'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-meter-more-'));
const cachePath = path.join(home, 'cache.json');
process.env.CLAUDE_CONFIG_DIR = home;
process.env.USAGE_METER_CACHE = cachePath;
const { scan, scanAll, priceResponse, requestCost, saveCache } = require('../scan.cjs');

const project = path.join(home, 'projects', 'C--work-demo');
fs.mkdirSync(project, { recursive: true });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const usage = (input, write5m, write1h, read, output, extra = {}) => ({
  input_tokens: input, cache_read_input_tokens: read, output_tokens: output, ...extra,
  ...(extra.omitCreation ? {} : {
    cache_creation_input_tokens: write5m + write1h,
    cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h }
  })
});
let seq = 0;
function id() {
  seq += 1;
  return `44444444-4444-4444-8444-${String(seq).padStart(12, '0')}`;
}
function response(messageId, u, { model = 'claude-opus-5-5', t = '2026-10-20T00:00:00.000Z', requestId, uuid, content } = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: t, requestId, uuid,
    message: { id: messageId, model, role: 'assistant', content: content ?? [{ type: 'text', text: 'ok' }], usage: u }
  }) + '\n';
}
function writeSession(sessionId, body) {
  const file = path.join(project, sessionId + '.jsonl');
  fs.writeFileSync(file, body);
  return file;
}

test('dated and snapshot model ids use the base price, and a longer prefix does not', () => {
  near(priceResponse('claude-opus-5-5-20260101', usage(1e6, 0, 0, 0, 0)).usd.uncachedInput, 4);
  near(priceResponse('claude-sonnet-4-6@20260101', usage(1e6, 0, 0, 0, 0)).usd.uncachedInput, 3);
  near(priceResponse('claude-opus-5-20260101', usage(1e6, 0, 0, 0, 0)).usd.uncachedInput, 5);
  near(priceResponse('claude-opus-4-8', usage(1e6, 0, 0, 0, 1e6)).usd.output, 25);
});

test('fast mode doubles every category and stacks with the Haiku long-context multiplier', () => {
  const fast = priceResponse('claude-opus-5-5', usage(1e6, 1e6, 1e6, 1e6, 1e6, { speed: 'fast' })).usd;
  near(fast.uncachedInput, 8); near(fast.cacheWrite, 26); near(fast.cacheRead, 0.4); near(fast.output, 40);
  near(priceResponse('claude-sonnet-5', usage(1e6, 0, 0, 0, 0, { speed: 'fast' })).usd.uncachedInput, 4);
  const atLimit = priceResponse('claude-haiku-5-5', usage(100000, 0, 0, 0, 1e6)).usd.uncachedInput;
  const over = priceResponse('claude-haiku-5-5', usage(100000, 0, 0, 1, 0)).usd;
  near(atLimit, 0.01);
  near(over.uncachedInput, 0.05);
  near(over.cacheRead, 0.00000005);
  const stacked = priceResponse('claude-haiku-5-5', usage(100000, 0, 0, 1, 0, { speed: 'fast' })).usd.uncachedInput;
  near(stacked, 0.1);
  // Output alone never crosses the 100K prompt threshold, and Haiku 4.5 has no long tier.
  near(priceResponse('claude-haiku-5-5', usage(100000, 0, 0, 0, 1e6)).usd.output, 0.5);
  near(priceResponse('claude-haiku-4-5', usage(200000, 0, 0, 0, 0)).usd.uncachedInput, 0.2);
});

test('cache writes fall back to the combined field only when the 5m/1h split is absent', () => {
  const split = priceResponse('claude-opus-5-5', usage(0, 1e6, 2e6, 0, 0)).usd;
  near(split.cacheWrite, 5 + 16);
  const legacy = priceResponse('claude-opus-5-5', {
    input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1e6
  }).usd;
  near(legacy.cacheWrite, 5);
  const emptySplit = priceResponse('claude-opus-5-5', {
    input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 1e6, cache_creation: {}
  }).usd;
  near(emptySplit.cacheWrite, 0);
});

test('request cost is the sum of priced categories and is null when the model or the counters cannot be priced', () => {
  near(requestCost('claude-opus-5-5', usage(1e6, 1e6, 0, 0, 1e6)), 29);
  assert.equal(requestCost('mystery-model', usage(10, 0, 0, 0, 1)), null);
  assert.equal(requestCost('claude-opus-5-5', { input_tokens: '10abc', output_tokens: 1 }), null);
  const numeric = priceResponse('claude-opus-5-5', { input_tokens: '10', output_tokens: '5', cache_read_input_tokens: '1' });
  assert.equal(numeric.tokens.uncachedInput, 10);
  assert.equal(numeric.tokens.output, 5);
  assert.equal(numeric.tokens.cacheRead, 1);
  assert.equal(priceResponse('claude-opus-5-5', { input_tokens: -1, output_tokens: 1 }).tokens, null);
  assert.equal(priceResponse(12, usage(10, 0, 0, 0, 1)).usd, null);
  assert.equal(priceResponse('mystery-model', usage(10, 0, 0, 0, 1, { speed: 'fast' })).usd, null);
  assert.equal(priceResponse('mystery-model', usage(10, 0, 0, 0, 1, { speed: 'fast' })).tokens.output, 1);
});

test('the last copy of a message wins, and synthetic, malformed, and id-less duplicates are not counted twice', () => {
  const session = id();
  writeSession(session,
    response('msg_a', usage(0, 0, 0, 0, 1), { content: [{ type: 'thinking' }] }) +
    '{this is not json "usage"\n' +
    response('msg_a', usage(0, 0, 0, 0, 50)) +
    response('synth', usage(0, 0, 0, 0, 99), { model: '<synthetic>' }) +
    response(undefined, usage(0, 0, 0, 0, 3), { requestId: 'req_1', uuid: 'same' }) +
    response(undefined, usage(0, 0, 0, 0, 4), { requestId: 'req_2', uuid: 'same' }) +
    response(undefined, usage(0, 0, 0, 0, 5), { uuid: 'uuid_a' }) +
    response(undefined, usage(0, 0, 0, 0, 6), { uuid: 'uuid_b' }));
  const s = scan(session);
  assert.equal(s.requests, 5);
  assert.equal(s.tokens.output, 50 + 3 + 4 + 5 + 6);
  assert.equal(typeof s.total, 'number');
});

test('a non-numeric counter is left unpriced instead of turning the session total into a string', () => {
  const session = id();
  writeSession(session,
    response('bad', { input_tokens: '10abc', output_tokens: 9, cache_read_input_tokens: 0 }) +
    response('good', { input_tokens: '10', output_tokens: '5', cache_read_input_tokens: 0 }));
  const s = scan(session);
  assert.equal(s.requests, 2);
  assert.equal(s.unpriced, 1);
  assert.equal(s.tokens.uncachedInput, 10);
  assert.equal(s.tokens.output, 5);
  assert.equal(s.total, 15);
  assert.equal(typeof s.total, 'number');
  near(s.usdTotal, (10 * 4 + 5 * 20) / 1e6);
});

test('an unknown model keeps its tokens out of the dollar totals and out of the window sum', () => {
  const session = id();
  const week = Date.parse('2026-10-20T00:00:00.000Z');
  writeSession(session,
    response('old', usage(1e6, 0, 0, 0, 0), { t: '2026-10-01T00:00:00.000Z' }) +
    response('mystery', usage(3, 0, 0, 0, 7), { model: 'mystery-model', t: '2026-10-21T00:00:00.000Z' }));
  const s = scanAll(week, null).sessions.find(one => one.id === session);
  assert.equal(s.unpriced, 1);
  assert.equal(s.tokens.output, 7);
  assert.equal(s.tokens.uncachedInput, 3 + 1e6);
  near(s.usdTotal, 4);
  near(s.inWindow[0], 0);
  assert.equal(s.inWindow[1], 0);
});

test('title falls back to the first real prompt, then the project name', () => {
  const prompted = id();
  const prompt = '  hello   world from the user message that is definitely longer than forty characters';
  writeSession(prompted,
    JSON.stringify({ parentUuid: null, type: 'user', message: { content: '<local-command-stdout>' } }) + '\n' +
    JSON.stringify({ parentUuid: null, type: 'user', message: { content: [{ type: 'text', text: prompt }] } }) + '\n' +
    response('msg', usage(0, 0, 0, 0, 1)));
  assert.equal(scan(prompted).title, prompt.replace(/\s+/g, ' ').slice(0, 40));

  const bare = id();
  writeSession(bare, response('msg', usage(0, 0, 0, 0, 1)));
  assert.equal(scan(bare).title, 'C--work-demo');
});

test('subagents add tokens and window dollars, and their titles and non-transcripts do not', () => {
  const session = id();
  const week = Date.parse('2026-10-20T00:00:00.000Z');
  const five = Date.parse('2026-10-24T00:00:00.000Z');
  writeSession(session,
    JSON.stringify({ type: 'custom-title', customTitle: '主会话', sessionId: session }) + '\n' +
    response('before', usage(1e6, 0, 0, 0, 0), { t: '2026-10-19T23:59:59.999Z' }) +
    response('week', usage(1e6, 0, 0, 0, 0), { t: '2026-10-20T00:00:00.000Z' }) +
    response('both', usage(0, 0, 0, 50, 25), { t: '2026-10-24T00:00:00.000Z' }) +
    response('bad-time', usage(1e6, 0, 0, 0, 0), { t: 'not-a-date' }));
  const sub = path.join(project, session, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'notes.txt'), 'ignore me');
  fs.mkdirSync(path.join(sub, 'folder.jsonl'));
  fs.writeFileSync(path.join(sub, 'agent.jsonl'),
    JSON.stringify({ type: 'custom-title', customTitle: '子智能体标题' }) + '\n' +
    response('sub', usage(1e6, 0, 0, 0, 0), { t: '2026-10-24T00:00:00.000Z' }));
  fs.mkdirSync(path.join(project, 'fake.jsonl'));
  fs.writeFileSync(path.join(project, 'readme.jsonl.txt'), response('nope', usage(1e6, 0, 0, 0, 0)));
  writeSession(id(), JSON.stringify({ type: 'custom-title', customTitle: '没有请求' }) + '\n');

  const all = scanAll(week, five);
  const s = all.sessions.find(one => one.id === session);
  assert.equal(s.title, '主会话');
  assert.equal(s.subagents, 1);
  assert.equal(s.tokens.cacheRead, 50);
  assert.equal(s.tokens.output, 25);
  assert.equal(s.tokens.uncachedInput, 4e6);
  near(s.hitRate, 50 / (50 + 4e6));
  near(s.usdTotal, 16 + (50 * 0.2 + 25 * 20) / 1e6);
  near(s.inWindow[0], 8 + (50 * 0.2 + 25 * 20) / 1e6);
  near(s.inWindow[1], 4 + (50 * 0.2 + 25 * 20) / 1e6);
  assert.equal(all.sessions.some(one => one.title === '没有请求'), false);
  assert.equal(all.sessions.some(one => one.id === 'fake'), false);
  near(all.weekUsd, all.sessions.reduce((sum, one) => sum + one.inWindow[0], 0));
  near(all.fiveUsd, all.sessions.reduce((sum, one) => sum + one.inWindow[1], 0));
});

test('sessions are newest first, output-only usage has no hit rate, and a changed file leaves the cache', () => {
  const older = id();
  const newer = id();
  const olderFile = writeSession(older, response('o', usage(0, 0, 0, 0, 2), { t: '2026-10-22T00:00:00.000Z' }));
  const newerFile = writeSession(newer, response('n', usage(0, 0, 0, 0, 4), { t: '2026-10-23T00:00:00.000Z' }));
  const olderTime = new Date('2026-10-01T00:00:00Z');
  const newerTime = new Date('2026-10-02T00:00:00Z');
  fs.utimesSync(olderFile, olderTime, olderTime);
  fs.utimesSync(newerFile, newerTime, newerTime);
  const ranked = scanAll(null, null).sessions.filter(one => one.id === older || one.id === newer);
  assert.deepEqual(ranked.map(one => one.id), [newer, older]);
  assert.equal(ranked.find(one => one.id === older).hitRate, null);
  assert.equal(scanAll(null, null).weekUsd, null);

  const again = scan(older);
  assert.equal(again.total, 2);
  fs.appendFileSync(olderFile, response('o2', usage(0, 0, 0, 0, 8)));
  const bumped = new Date('2026-11-01T00:00:00Z');
  fs.utimesSync(olderFile, bumped, bumped);
  assert.equal(scan(older).tokens.output, 10);
  saveCache();
  assert.equal(fs.existsSync(cachePath), true);
  assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8'))[olderFile].parsed.totals.tokens.output, 10);
});

test('a missing transcript, a transcript directory, and a missing projects folder do not crash the scan', () => {
  assert.equal(scan('55555555-5555-4555-8555-555555555555'), null);
  assert.equal(scan('fake'), null);
  const projects = path.join(home, 'projects');
  const parked = path.join(home, 'projects-parked');
  fs.renameSync(projects, parked);
  try {
    assert.equal(scan('44444444-4444-4444-8444-000000000001'), null);
    const empty = scanAll(10, 20);
    assert.deepEqual(empty.sessions, []);
    assert.equal(empty.weekUsd, 0);
    assert.equal(empty.fiveUsd, 0);
    const undated = scanAll(null, null);
    assert.equal(undated.weekUsd, null);
    assert.equal(undated.fiveUsd, null);
  } finally {
    fs.renameSync(parked, projects);
  }
});

test('the command line prints one session, every session, and null for a session that is not on disk', () => {
  const session = id();
  writeSession(session,
    JSON.stringify({ type: 'custom-title', customTitle: '命令行', sessionId: session }) + '\n' +
    response('cli', usage(1e6, 0, 0, 0, 0), { t: '2026-10-25T00:00:00.000Z' }));
  const script = path.join(__dirname, '..', 'scan.cjs');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, USAGE_METER_CACHE: path.join(home, 'cli-cache.json') };
  const one = spawnSync(process.execPath, [script, session], { encoding: 'utf8', env });
  assert.equal(one.status, 0, one.stderr);
  const parsed = JSON.parse(one.stdout);
  assert.equal(parsed.title, '命令行');
  near(parsed.usdTotal, 4);

  const missing = spawnSync(process.execPath, [script, '66666666-6666-4666-8666-666666666666'], { encoding: 'utf8', env });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, 'null');

  const week = String(Date.parse('2026-10-20T00:00:00.000Z'));
  const all = spawnSync(process.execPath, [script, '--all', week, 'null'], { encoding: 'utf8', env });
  assert.equal(all.status, 0, all.stderr);
  const overview = JSON.parse(all.stdout);
  const mine = overview.sessions.find(s => s.id === session);
  near(mine.inWindow[0], 4);
  assert.equal(mine.inWindow[1], 0);
  assert.equal(overview.fiveUsd, null);
  assert.ok(overview.weekUsd >= 4);
  assert.equal(fs.existsSync(env.USAGE_METER_CACHE), true);

  fs.writeFileSync(env.USAGE_METER_CACHE, '{not json');
  const reread = spawnSync(process.execPath, [script, session], { encoding: 'utf8', env });
  assert.equal(reread.status, 0, reread.stderr);
  assert.equal(JSON.parse(reread.stdout).title, '命令行');
});
