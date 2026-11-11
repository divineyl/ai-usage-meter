'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const metadata = require('../per-chat-metadata.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-cost-'));
let n = 0;
const file = () => path.join(root, `rollout-${++n}.jsonl`);
const near = (actual, expected) => assert.ok(actual && Math.abs(actual.usd - expected) < 1e-9, `${actual && actual.usd} != ${expected}`);
function context(model) { return JSON.stringify({ type: 'turn_context', payload: { model } }) + '\n'; }
function snap(input, cached, output, lastInput = input, write = 0) {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, cache_write_input_tokens: write, total_tokens: (Number(input) || 0) + (Number(output) || 0) },
    last_token_usage: { input_tokens: lastInput }
  } } }) + '\n';
}
function touch(target) {
  const when = new Date(Date.now() + 60_000);
  fs.utimesSync(target, when, when);
}

test('each published model is priced from its own input, cached input, and output rates', () => {
  const expected = {
    'gpt-6-astra': [10, 1, 50],
    'gpt-6.1-sol': [2, 0.1, 10],
    'gpt-6.1-terra': [1, 0.05, 5],
    'gpt-6-luna': [0.1, 0.01, 0.5]
  };
  for (const [model, [input, cached, output]] of Object.entries(expected)) {
    const target = file();
    // 1M would cross the 272K long-context tier, so each leg is 1K tokens.
    fs.writeFileSync(target, context(model) + snap(1000, 0, 0, 1000) + snap(2000, 1000, 0, 1000) + snap(2000, 1000, 1000, 1000));
    const cost = metadata.readApiCost(target, null);
    near(cost, (input + cached + output) * 1000 / 1e6);
    assert.equal(cost.longRequests, 0);
  }
  assert.deepEqual(Object.keys(metadata.PRICES).sort(), Object.keys(expected).sort());
});

test('cache writes cost 1.25x input, are capped by the uncached input, and stack with long-context rates', () => {
  const capped = file();
  fs.writeFileSync(capped, context('gpt-6.1-sol') + snap(100, 80, 0, 100, 50));
  near(metadata.readApiCost(capped, null), 0.000058);

  const stacked = file();
  fs.writeFileSync(stacked, context('gpt-6.1-sol') + snap(300000, 100000, 1000, 300000, 50000));
  const cost = metadata.readApiCost(stacked, null);
  near(cost, 0.885);
  assert.equal(cost.longRequests, 1);
});

test('long-context rates start above 272K input and use the request size, not the cumulative delta', () => {
  const standard = file();
  fs.writeFileSync(standard, context('gpt-6.1-sol') + snap(272000, 0, 1000, 272000));
  const atLimit = metadata.readApiCost(standard, null);
  near(atLimit, 272000 * 2 / 1e6 + 0.01);
  assert.equal(atLimit.longRequests, 0);

  const over = file();
  fs.writeFileSync(over, context('gpt-6.1-sol') + snap(272001, 0, 0, 272001));
  const long = metadata.readApiCost(over, null);
  near(long, 272001 * 4 / 1e6);
  assert.equal(long.longRequests, 1);

  const tinyButLong = file();
  fs.writeFileSync(tinyButLong, context('gpt-6.1-sol') + snap(1, 0, 1000, 300000));
  near(metadata.readApiCost(tinyButLong, null), 0.000004 + 0.015);
  assert.equal(metadata.readApiCost(tinyButLong, null).longRequests, 1);

  const exact = file();
  fs.writeFileSync(exact, context('gpt-6.1-sol') + snap(0, 0, 1000, 272000));
  near(metadata.readApiCost(exact, null), 0.01);
  assert.equal(metadata.readApiCost(exact, null).longRequests, 0);
});

test('the fallback model prices a rollout until a turn context replaces it', () => {
  const target = file();
  fs.writeFileSync(target, snap(1000, 0, 0));
  near(metadata.readApiCost(target, 'gpt-6.1-sol'), 0.002);
  const switched = file();
  fs.writeFileSync(switched, snap(1000, 0, 0) + context('gpt-6.1-terra') + snap(2000, 0, 0));
  near(metadata.readApiCost(switched, 'gpt-6.1-sol'), 0.003);
  const ignored = file();
  fs.writeFileSync(ignored, context('gpt-6.1-sol') + JSON.stringify({ type: 'turn_context', payload: { model: 5 } }) + '\n' + snap(1000, 0, 0));
  near(metadata.readApiCost(ignored, 'gpt-6-luna'), 0.002);
});

test('a repeated snapshot is skipped, and a counter that goes backwards starts a new priced segment', () => {
  const target = file();
  fs.writeFileSync(target, context('gpt-6.1-sol') + snap(1000, 0, 0) + snap(1000, 0, 0));
  near(metadata.readApiCost(target, null), 0.002);
  fs.appendFileSync(target, snap(10, 0, 0));
  near(metadata.readApiCost(target, null), 0.00202);
});

test('appended bytes add to the cached price, and a rewrite of any length replaces it', () => {
  const target = file();
  const sol = context('gpt-6.1-sol') + snap(1000, 0, 10, 1000);
  const solMore = context('gpt-6.1-sol') + snap(1000, 0, 20, 1000);
  assert.equal(Buffer.byteLength(sol), Buffer.byteLength(solMore));
  fs.writeFileSync(target, sol);
  near(metadata.readApiCost(target, null), 0.0021);
  fs.appendFileSync(target, snap(2000, 0, 20, 1000));
  near(metadata.readApiCost(target, null), 0.0042);

  fs.writeFileSync(target, solMore);
  touch(target);
  near(metadata.readApiCost(target, null), 0.0022);

  fs.writeFileSync(target, context('gpt-6.1-terra') + snap(1000, 0, 0) + snap(1000, 0, 0));
  near(metadata.readApiCost(target, null), 0.001);
  fs.writeFileSync(target, '');
  assert.deepEqual(metadata.readApiCost(target, 'gpt-6.1-sol'), { usd: 0, longRequests: 0 });
});

test('a partial last line is priced once the closing newline arrives', () => {
  const target = file();
  const body = context('gpt-6.1-sol') + snap(1000, 0, 0);
  fs.writeFileSync(target, body.slice(0, -1));
  assert.deepEqual(metadata.readApiCost(target, null), { usd: 0, longRequests: 0 });
  fs.appendFileSync(target, '\n');
  near(metadata.readApiCost(target, null), 0.002);
});

test('unreadable counters do not become NaN or zero, and a later cumulative snapshot still prices the gap', () => {
  const onlyBad = file();
  fs.writeFileSync(onlyBad, context('gpt-6.1-sol') + snap('abc', 0, 1));
  assert.equal(metadata.readApiCost(onlyBad, null), null);
  const negative = file();
  fs.writeFileSync(negative, context('gpt-6.1-sol') + snap(-5, 0, 1));
  assert.equal(metadata.readApiCost(negative, null), null);
  const object = file();
  fs.writeFileSync(object, context('gpt-6.1-sol') + snap({}, 0, 1));
  assert.equal(metadata.readApiCost(object, null), null);

  const quoted = file();
  fs.writeFileSync(quoted, context('gpt-6.1-sol') + snap('1000', '0', '0'));
  near(metadata.readApiCost(quoted, null), 0.002);

  const recovered = file();
  fs.writeFileSync(recovered, context('gpt-6.1-sol') + snap('abc', 0, 1) + snap(1000, 0, 0));
  near(metadata.readApiCost(recovered, null), 0.002);
  fs.appendFileSync(recovered, snap('nope', 0, 1));
  near(metadata.readApiCost(recovered, null), 0.002);
  fs.appendFileSync(recovered, snap(1500, 0, 0));
  near(metadata.readApiCost(recovered, null), 0.003);
});

test('an unknown model, a missing file, and an unreadable path leave the cost unknown', () => {
  const dated = file();
  fs.writeFileSync(dated, context('gpt-6.1-sol-2026') + snap(1000, 0, 0));
  assert.equal(metadata.readApiCost(dated, null), null);
  const mixed = file();
  fs.writeFileSync(mixed, context('gpt-6.1-sol') + snap(1000, 0, 0) + context('mystery-model') + snap(2000, 0, 0));
  assert.equal(metadata.readApiCost(mixed, null), null);
  assert.equal(metadata.readApiCost(path.join(root, 'missing.jsonl'), 'gpt-6.1-sol'), null);
  assert.equal(metadata.readApiCost(root, 'gpt-6.1-sol'), null);
  assert.equal(metadata.readApiCost('', 'gpt-6.1-sol'), null);
  assert.equal(metadata.readApiCost(null, 'gpt-6.1-sol'), null);
  const locked = file();
  fs.writeFileSync(locked, context('gpt-6.1-sol') + snap(1000, 0, 0));
  fs.chmodSync(locked, 0);
  try { assert.equal(metadata.readApiCost(locked, null), null); }
  finally { fs.chmodSync(locked, 0o644); }
  const ignored = file();
  fs.writeFileSync(ignored, context('gpt-6.1-sol') + JSON.stringify({ type: 'event_msg', payload: { type: 'other' } }) + '\n' + '{bad\n');
  assert.deepEqual(metadata.readApiCost(ignored, null), { usd: 0, longRequests: 0 });
});
