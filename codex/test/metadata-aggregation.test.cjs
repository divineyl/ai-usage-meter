'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const metadata = require('../per-chat-metadata.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-more-'));
const parent = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const grandchild = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
function event(input, cached, output, extra = {}) {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
    input_tokens: input, cached_input_tokens: cached, output_tokens: output,
    reasoning_output_tokens: extra.reasoning ?? 0, total_tokens: extra.total
  } } } }) + '\n';
}
function valid(input, cached, output) { return event(input, cached, output, { total: input + output }); }
function context(model) { return JSON.stringify({ type: 'turn_context', payload: { model } }) + '\n'; }
function snap(input, cached, output) {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output },
    last_token_usage: { input_tokens: input }
  } } }) + '\n';
}
function homeOf(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function database(dir, filename, withModel = false) {
  const db = new DatabaseSync(path.join(dir, filename));
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, created_at INTEGER, tokens_used INTEGER, rollout_path TEXT${withModel ? ', model TEXT' : ''});
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);`);
  return db;
}

test('token breakdowns reject inconsistent counters and still recover an earlier valid line', () => {
  assert.equal(metadata.readTokenBreakdown(''), null);
  assert.equal(metadata.readTokenBreakdown(null), null);
  assert.equal(metadata.readTokenBreakdown(root), null);
  const missing = path.join(root, 'absent.jsonl');
  assert.equal(metadata.readTokenBreakdown(missing), null);

  const zeroInput = path.join(root, 'zero.jsonl');
  fs.writeFileSync(zeroInput, valid(0, 0, 5));
  assert.deepEqual(metadata.readTokenBreakdown(zeroInput), { input: 0, cachedInput: 0, uncachedInput: 0, output: 5, total: 5, hitRate: null });

  const implied = path.join(root, 'implied.jsonl');
  fs.writeFileSync(implied, event(10, 4, 1));
  assert.equal(metadata.readTokenBreakdown(implied).total, 11);
  assert.equal(metadata.readTokenBreakdown(implied).hitRate, 0.4);

  const mismatch = path.join(root, 'mismatch.jsonl');
  fs.writeFileSync(mismatch, event(10, 0, 1, { total: 99 }));
  assert.equal(metadata.readTokenBreakdown(mismatch), null);
  const fraction = path.join(root, 'fraction.jsonl');
  fs.writeFileSync(fraction, valid(1.5, 0, 1));
  assert.equal(metadata.readTokenBreakdown(fraction), null);

  const reasoning = path.join(root, 'reasoning.jsonl');
  fs.writeFileSync(reasoning, valid(20, 0, 8).replace('"output_tokens":8', '"output_tokens":8,"reasoning_output_tokens":100'));
  assert.equal(metadata.readTokenBreakdown(reasoning).output, 8);

  const spaced = path.join(root, 'spaced.jsonl');
  fs.writeFileSync(spaced, '{ "type" : "token_count", "payload": { "type": "token_count", "info": { "total_token_usage": { "input_tokens": 10, "cached_input_tokens": 4, "output_tokens": 1, "total_tokens": 11 } } } }\n');
  assert.equal(metadata.readTokenBreakdown(spaced).uncachedInput, 6);

  const recovered = path.join(root, 'recovered.jsonl');
  fs.writeFileSync(recovered, valid(10, 4, 1) + '{not json "type":"token_count"\n');
  assert.equal(metadata.readTokenBreakdown(recovered).total, 11);
  const stale = path.join(root, 'stale-valid.jsonl');
  fs.writeFileSync(stale, valid(10, 4, 1) + valid(5, 9, 1));
  assert.equal(metadata.readTokenBreakdown(stale), null);

  const buried = path.join(root, 'buried.jsonl');
  let body = valid(10, 4, 1);
  const filler = JSON.stringify({ type: 'noise', value: 'x'.repeat(2000) }) + '\n';
  while (Buffer.byteLength(body) < 300 * 1024) body += filler;
  fs.writeFileSync(buried, body);
  assert.equal(metadata.readTokenBreakdown(buried).total, 11);

  const locked = path.join(root, 'locked.jsonl');
  fs.writeFileSync(locked, valid(10, 4, 1));
  fs.chmodSync(locked, 0);
  try { assert.equal(metadata.readTokenBreakdown(locked), null); }
  finally { fs.chmodSync(locked, 0o644); }
});

test('the newest state database wins, invalid ids are ignored, and duplicate ids are read once', () => {
  const home = homeOf('states');
  fs.writeFileSync(path.join(home, 'state_1.sqlite-journal'), 'ignore');
  fs.writeFileSync(path.join(home, 'notes.sqlite'), 'ignore');
  const low = database(home, 'state_9.sqlite');
  low.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(parent, 10, 9, null);
  low.close();
  const high = database(home, 'state_10.sqlite');
  high.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(parent, 0, 10, null);
  high.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(other, -5, 4, null);
  high.close();
  const rows = metadata.readMetadata([parent, parent, 'not-a-uuid', 12, other], home);
  assert.deepEqual(rows.map(row => row.thread_id), [parent, other]);
  assert.equal(rows[0].tokens, 10);
  assert.equal(rows[0].created_at, null);
  assert.equal(rows[0].descendant_tokens, 0);
  assert.equal(rows[1].created_at, null);
  assert.deepEqual(metadata.readMetadata([], home), []);
  assert.deepEqual(metadata.readMetadata([parent], homeOf('empty-home')), []);
  assert.throws(() => metadata.readMetadata([parent], path.join(root, 'missing-home')));
});

test('descendant tokens stay unknown when any child has neither a transcript nor a counter', () => {
  const home = homeOf('unknown-child');
  const parentFile = path.join(home, 'parent.jsonl');
  fs.writeFileSync(parentFile, valid(200, 150, 20));
  const db = database(home, 'state_1.sqlite');
  const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?)');
  insert.run(parent, 20, 999, parentFile);
  insert.run(child, 30, null, null);
  insert.run(grandchild, 40, 15, null);
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(parent, child);
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(parent, grandchild);
  db.close();
  const row = metadata.readMetadata([parent], home)[0];
  assert.equal(row.tokens, 220);
  assert.equal(row.descendant_tokens, null);
  assert.equal(row.breakdown, null);
  assert.equal(row.apiCost, null);
  assert.deepEqual(row.descendant_thread_ids.sort(), [child, grandchild].sort());
  assert.equal(row.created_at, '1970-01-01T00:00:20.000Z');
});

test('a known zero child is zero, a negative stored counter is unknown, and a self-edge is ignored', () => {
  const home = homeOf('zeros');
  const db = database(home, 'state_1.sqlite');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(parent, 1, -1, null);
  db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(child, 1, 0, null);
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(parent, child);
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(parent, parent);
  db.close();
  const row = metadata.readMetadata([parent], home)[0];
  assert.equal(row.tokens, null);
  assert.equal(row.descendant_tokens, 0);
  assert.deepEqual(row.descendant_thread_ids, [child]);
});

test('a parent model and a child turn context are priced together, including a grandchild reached through a cycle', { timeout: 5000 }, () => {
  const home = homeOf('priced-tree');
  const parentFile = path.join(home, 'parent.jsonl');
  const childFile = path.join(home, 'child.jsonl');
  const grandFile = path.join(home, 'grand.jsonl');
  fs.writeFileSync(parentFile, snap(1000, 0, 0));
  fs.writeFileSync(childFile, context('gpt-6.1-terra') + snap(1000, 0, 0));
  fs.writeFileSync(grandFile, context('gpt-6-luna') + snap(1000, 1000, 0));
  const db = database(home, 'state_3.sqlite', true);
  const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)');
  const upper = 'ABCDEFAB-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  insert.run(upper, 80, 6, null, 'gpt-6.1-sol');
  insert.run(parent, 50, 1, parentFile, 'gpt-6.1-sol');
  insert.run(child, 60, 1, childFile, 'gpt-6-astra');
  insert.run(grandchild, 70, null, grandFile, null);
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(parent, child);
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(child, grandchild);
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(grandchild, parent);
  db.close();
  const found = metadata.readMetadata([parent], home)[0];
  assert.deepEqual(found.descendant_thread_ids.slice().sort(), [child, grandchild].sort());
  assert.equal(found.tokens, 1000);
  assert.equal(found.descendant_tokens, 2000);
  assert.equal(found.breakdown.total, 3000);
  assert.equal(found.breakdown.cachedInput, 1000);
  // The child row's stored model is Astra, but its turn context prices it as Terra.
  assert.ok(Math.abs(found.apiCost.usd - (0.002 + 0.001 + 0.00001)) < 1e-9, String(found.apiCost.usd));
  assert.equal(found.apiCost.longRequests, 0);
  assert.equal(metadata.readMetadata([upper], home)[0].tokens, 6);
  assert.equal(metadata.readMetadata([upper.toLowerCase()], home).length, 0);
  assert.equal(found.created_at, '1970-01-01T00:00:50.000Z');
});

test('an unsafe combined total is withheld even though each transcript is readable on its own', () => {
  const home = homeOf('overflow');
  const parentFile = path.join(home, 'parent.jsonl');
  const childFile = path.join(home, 'child.jsonl');
  const huge = Number.MAX_SAFE_INTEGER;
  fs.writeFileSync(parentFile, valid(huge, 0, 0));
  fs.writeFileSync(childFile, valid(huge, 0, 0));
  const db = database(home, 'state_1.sqlite');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(parent, 1, 0, parentFile);
  db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(child, 1, 0, childFile);
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(parent, child);
  db.close();
  const row = metadata.readMetadata([parent], home)[0];
  assert.equal(row.breakdown, null);
  assert.equal(row.tokens, huge);
  assert.equal(row.descendant_tokens, huge);
});

test('settings accept a lowercase currency and a fractional week count, and ignore everything else', () => {
  const dir = fs.mkdtempSync(path.join(root, 'config-'));
  assert.deepEqual(metadata.readConfig(path.join(dir, 'missing')), metadata.DEFAULT_CONFIG);
  fs.writeFileSync(path.join(dir, 'per-chat-usage.config.json'), '{');
  assert.deepEqual(metadata.readConfig(dir), metadata.DEFAULT_CONFIG);
  fs.writeFileSync(path.join(dir, 'per-chat-usage.config.json'), JSON.stringify({
    monthlyPrice: 0, weeksPerMonth: 0.5, currency: 'usd', usdToCny: 7.1, extra: true, monthly: '20'
  }));
  assert.deepEqual(metadata.readConfig(dir), { monthlyPrice: 140, weeksPerMonth: 0.5, currency: 'USD', usdToCny: 7.1 });
  fs.writeFileSync(path.join(dir, 'per-chat-usage.config.json'), JSON.stringify({ currency: 'cny', monthlyPrice: '20', usdToCny: 0 }));
  assert.deepEqual(metadata.readConfig(dir), { ...metadata.DEFAULT_CONFIG, currency: 'CNY' });
});
