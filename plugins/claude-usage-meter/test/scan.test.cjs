'use strict';
// Run with: node --test plugins/claude-usage-meter/test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-meter-test-'));
process.env.CLAUDE_CONFIG_DIR = home;
process.env.USAGE_METER_CACHE = path.join(home, 'cache.json');
const { scan, scanAll, priceResponse } = require('../scan.cjs');

const project = path.join(home, 'projects', 'C--work-demo');
fs.mkdirSync(project, { recursive: true });

function response(id, usage, { model = 'claude-opus-5-5', t = '2026-10-20T00:00:00Z', block = 'text' } = {}) {
  return JSON.stringify({ type: 'assistant', timestamp: t, requestId: 'req_' + id,
    message: { id, model, role: 'assistant', content: [{ type: block }], usage } }) + '\n';
}
const usage = (input, write5m, write1h, read, output, extra = {}) => ({
  input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write5m + write1h, output_tokens: output,
  cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h }, ...extra
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('prices each category at Opus 5.5 rates, 5-minute and 1-hour writes apart', () => {
  // 1M of each: input $4, 5m write $5, 1h write $8, read $0.20, output $20
  const { usd } = priceResponse('claude-opus-5-5', usage(1e6, 1e6, 1e6, 1e6, 1e6));
  near(usd.uncachedInput, 4); near(usd.cacheWrite, 13); near(usd.cacheRead, 0.2); near(usd.output, 20);
});

test('Sonnet 5.5 cache hits are $0.10 per million tokens', () => {
  // Official hit rate is 0.05x input. Sonnet 5 stays at 0.1x ($0.20).
  const { usd } = priceResponse('claude-sonnet-5-5', usage(1e6, 1e6, 1e6, 1e6, 1e6));
  near(usd.uncachedInput, 2); near(usd.cacheWrite, 6.5); near(usd.cacheRead, 0.1); near(usd.output, 10);
  near(priceResponse('claude-sonnet-5', usage(0, 0, 0, 1e6, 0)).usd.cacheRead, 0.2);
});

test('Fable 5.2, Mythos 5.2, and Mythos 5 use their published rows', () => {
  for (const model of ['claude-fable-5-2', 'claude-mythos-5-2', 'claude-fable-5-2-20261109']) {
    const { usd } = priceResponse(model, usage(1e6, 1e6, 1e6, 1e6, 1e6));
    near(usd.uncachedInput, 8); near(usd.cacheWrite, 26); near(usd.cacheRead, 0.2); near(usd.output, 40);
  }
  const mythos = priceResponse('claude-mythos-5', usage(1e6, 1e6, 1e6, 1e6, 1e6)).usd;
  near(mythos.uncachedInput, 10); near(mythos.cacheWrite, 32.5); near(mythos.cacheRead, 1); near(mythos.output, 50);
  // A dated Mythos 5 id must not inherit Mythos 5.1's $0.25 hit.
  near(priceResponse('claude-mythos-5-20260609', usage(0, 0, 0, 1e6, 0)).usd.cacheRead, 1);
});

test('retired Opus 4 and Sonnet 4 snapshots keep their own rows', () => {
  const opus = priceResponse('claude-opus-4-1-20250805', usage(1e6, 1e6, 1e6, 1e6, 1e6)).usd;
  near(opus.uncachedInput, 15); near(opus.cacheWrite, 48.75); near(opus.cacheRead, 1.5); near(opus.output, 75);
  near(priceResponse('claude-opus-4-20250514', usage(0, 0, 0, 1e6, 0)).usd.cacheRead, 1.5);
  const sonnet = priceResponse('claude-sonnet-4-20250514', usage(1e6, 1e6, 1e6, 1e6, 1e6)).usd;
  near(sonnet.uncachedInput, 3); near(sonnet.cacheWrite, 9.75); near(sonnet.cacheRead, 0.3); near(sonnet.output, 15);
  // Shorter prefixes must not steal the longer ids already in the table.
  near(priceResponse('claude-opus-4-8', usage(1e6, 0, 0, 0, 0)).usd.uncachedInput, 5);
  near(priceResponse('claude-opus-4-5-20251101', usage(1e6, 0, 0, 0, 0)).usd.uncachedInput, 5);
  near(priceResponse('claude-sonnet-4-6', usage(1e6, 0, 0, 0, 0)).usd.uncachedInput, 3);
});

test('Haiku 5.5 prompts over 100K and fast mode cost more', () => {
  const short = priceResponse('claude-haiku-5-5', usage(50000, 0, 0, 0, 1000)).usd;
  const long = priceResponse('claude-haiku-5-5', usage(50000, 0, 0, 60000, 1000)).usd;
  near(long.uncachedInput, short.uncachedInput * 5);
  const fast = priceResponse('claude-opus-5-5', usage(1e6, 0, 0, 0, 0, { speed: 'fast' })).usd;
  near(fast.uncachedInput, 8);
});

test('an unknown model counts its tokens but leaves its cost out', () => {
  const { tokens, usd } = priceResponse('mystery-model', usage(10, 0, 0, 0, 5));
  assert.equal(tokens.output, 5);
  assert.equal(usd, null);
});

test('a session counts each response once and includes its subagents', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  // One response logged once per content block: the same message id twice.
  fs.writeFileSync(path.join(project, id + '.jsonl'),
    JSON.stringify({ type: 'custom-title', customTitle: '演示会话', sessionId: id }) + '\n' +
    response('msg_a', usage(10, 0, 1000, 5000, 100), { block: 'thinking' }) +
    response('msg_a', usage(10, 0, 1000, 5000, 100)) +
    response('msg_b', usage(0, 0, 0, 6000, 50)));
  fs.mkdirSync(path.join(project, id, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(project, id, 'subagents', 'agent-x.jsonl'), response('msg_c', usage(0, 2000, 0, 0, 30)));

  const s = scan(id);
  assert.equal(s.title, '演示会话');
  assert.equal(s.requests, 3);
  assert.equal(s.subagents, 1);
  assert.deepEqual(s.tokens, { cacheRead: 11000, cacheWrite: 3000, uncachedInput: 10, output: 180 });
  assert.equal(s.total, 14190);
  const expected = (10 * 4 + 1000 * 8 + 2000 * 5 + 11000 * 0.2 + 180 * 20) / 1e6;
  near(s.usdTotal, expected);
});

test('window sums only count responses inside each window', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(project, id + '.jsonl'),
    response('msg_old', usage(1e6, 0, 0, 0, 0), { t: '2026-10-01T00:00:00Z' }) +
    response('msg_new', usage(1e6, 0, 0, 0, 0), { t: '2026-10-25T00:00:00Z' }));
  const all = scanAll(Date.parse('2026-10-20T00:00:00Z'), Date.parse('2026-10-24T23:00:00Z'));
  const s = all.sessions.find(one => one.id === id);
  near(s.usdTotal, 8);
  near(s.inWindow[0], 4);
  near(s.inWindow[1], 4);
});
