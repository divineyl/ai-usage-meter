'use strict';
// Sums Claude Code sessions' token usage (subagents included) from the transcripts
// under ~/.claude/projects and prices it at Anthropic API list prices.
//   node scan.cjs <sessionId>                    -> that session
//   node scan.cjs --all <weekStartMs> <fiveStartMs> -> every session, plus API $ inside each window
// Each transcript's parse is cached by size and mtime in the system temp folder.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// USD per 1M tokens: input, 5-minute cache write, 1-hour cache write, cache read, output.
const PRICES = {
  'claude-fable-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-mythos-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-fable-5': [10, 12.5, 20, 1, 50],
  'claude-opus-5-5': [4, 5, 8, 0.2, 20],
  'claude-opus-5': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-8': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-7': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-6': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-5': [5, 6.25, 10, 0.5, 25],
  'claude-sonnet-5-5': [2, 2.5, 4, 0.2, 10],
  'claude-sonnet-5': [2, 2.5, 4, 0.2, 10],
  'claude-sonnet-4-6': [3, 3.75, 6, 0.3, 15],
  'claude-sonnet-4-5': [3, 3.75, 6, 0.3, 15],
  'claude-haiku-5-5': [0.1, 0.125, 0.2, 0.01, 0.5],
  'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5]
};
// Haiku 5.5 prompts over 100K tokens cost 5x; fast mode (Opus) costs 2x.
const HAIKU_LONG = 100000;
// Claude Code keeps its data under CLAUDE_CONFIG_DIR when set, else ~/.claude.
const root = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const cacheFile = () => process.env.USAGE_METER_CACHE || path.join(os.tmpdir(), 'claude-usage-meter-cache-v1.json');
const FIELDS = ['cacheRead', 'cacheWrite', 'uncachedInput', 'output'];

function priceFor(model) {
  if (PRICES[model]) return PRICES[model];
  const base = Object.keys(PRICES).find(id => model.startsWith(id + '-') || model.startsWith(id + '@'));
  return base ? PRICES[base] : null;
}

// One response's tokens and USD per category, or null cost when the model has no price.
function priceResponse(model, u) {
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
  const input = u.input_tokens ?? 0, read = u.cache_read_input_tokens ?? 0, output = u.output_tokens ?? 0;
  const tokens = { cacheRead: read, cacheWrite: write5m + write1h, uncachedInput: input, output };
  const price = priceFor(model);
  if (!price) return { tokens, usd: null };
  let scale = 1;
  if (model.startsWith('claude-haiku-5-5') && input + read + write5m + write1h > HAIKU_LONG) scale = 5;
  if (u.speed === 'fast') scale *= 2;
  const usd = {
    cacheRead: scale * read * price[3] / 1e6,
    cacheWrite: scale * (write5m * price[1] + write1h * price[2]) / 1e6,
    uncachedInput: scale * input * price[0] / 1e6,
    output: scale * output * price[4] / 1e6
  };
  return { tokens, usd };
}

function requestCost(model, u) {
  const { usd } = priceResponse(model, u);
  return usd && FIELDS.reduce((sum, key) => sum + usd[key], 0);
}

function empty() {
  const zero = () => Object.fromEntries(FIELDS.map(key => [key, 0]));
  return { requests: 0, unpriced: 0, tokens: zero(), usd: zero() };
}
function add(into, from) {
  into.requests += from.requests; into.unpriced += from.unpriced;
  for (const key of FIELDS) { into.tokens[key] += from.tokens[key]; into.usd[key] += from.usd[key]; }
}

// Parses one transcript: its totals, its title, and [time, usd] per response for window sums.
// One response is logged once per content block, so the last line of each message id wins.
function parseFile(file) {
  const byId = new Map();
  let title = null, firstPrompt = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.includes('"custom-title"')) {
      try { const row = JSON.parse(line); if (row.type === 'custom-title' && row.customTitle) title = row.customTitle; } catch {}
      continue;
    }
    if (firstPrompt === null && line.startsWith('{"parentUuid":null') && line.includes('"type":"user"')) {
      try {
        const content = JSON.parse(line).message?.content;
        const text = typeof content === 'string' ? content : content?.find?.(block => block.type === 'text')?.text;
        if (text && !text.startsWith('<')) firstPrompt = text.replace(/\s+/g, ' ').slice(0, 40);
      } catch {}
    }
    if (!line.includes('"usage"')) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const message = row.message;
    if (!message?.usage || !message.model || message.model === '<synthetic>') continue;
    byId.set(message.id ?? row.requestId ?? row.uuid, { t: Date.parse(row.timestamp), model: message.model, usage: message.usage });
  }
  const totals = empty(), times = [];
  for (const { t, model, usage } of byId.values()) {
    const { tokens, usd } = priceResponse(model, usage);
    totals.requests++;
    for (const key of FIELDS) totals.tokens[key] += tokens[key];
    if (usd === null) { totals.unpriced++; continue; }
    let sum = 0;
    for (const key of FIELDS) { totals.usd[key] += usd[key]; sum += usd[key]; }
    times.push([t, sum]);
  }
  return { totals, times, title, firstPrompt };
}

let cache = null, cacheChanged = false;
function cached(file) {
  if (cache === null) { try { cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { cache = {}; } }
  const stat = fs.statSync(file);
  const hit = cache[file];
  if (hit && hit.size === stat.size && hit.mtime === stat.mtimeMs) return hit.parsed;
  const parsed = parseFile(file);
  cache[file] = { size: stat.size, mtime: stat.mtimeMs, parsed };
  cacheChanged = true;
  return parsed;
}
function saveCache() {
  if (!cacheChanged) return;
  try { fs.writeFileSync(cacheFile(), JSON.stringify(cache)); } catch {}
}

// The session's transcript and its subagents' transcripts.
function sessionFiles(dir, id) {
  const files = [path.join(dir, id + '.jsonl')];
  const subagents = path.join(dir, id, 'subagents');
  if (fs.existsSync(subagents)) for (const name of fs.readdirSync(subagents)) if (name.endsWith('.jsonl')) files.push(path.join(subagents, name));
  return files;
}

function summarize(id, dir, windows) {
  const files = sessionFiles(dir, id);
  const totals = empty(), inWindow = windows.map(() => 0);
  let title = null, firstPrompt = null, mtime = 0;
  files.forEach((file, index) => {
    const parsed = cached(file);
    add(totals, parsed.totals);
    if (index === 0) { title = parsed.title; firstPrompt = parsed.firstPrompt; }
    mtime = Math.max(mtime, fs.statSync(file).mtimeMs);
    for (const [t, usd] of parsed.times) windows.forEach((start, w) => { if (start !== null && t >= start) inWindow[w] += usd; });
  });
  const input = totals.tokens.cacheRead + totals.tokens.cacheWrite + totals.tokens.uncachedInput;
  const usd = FIELDS.reduce((sum, key) => sum + totals.usd[key], 0);
  return { id, title: title ?? firstPrompt ?? path.basename(dir), mtime, subagents: files.length - 1, ...totals,
    total: input + totals.tokens.output, hitRate: input ? totals.tokens.cacheRead / input : null, usdTotal: usd, inWindow };
}

function scan(sessionId) {
  for (const project of fs.readdirSync(root())) {
    const dir = path.join(root(), project);
    if (fs.existsSync(path.join(dir, sessionId + '.jsonl'))) return summarize(sessionId, dir, []);
  }
  return null;
}

function scanAll(weekStart, fiveStart) {
  const sessions = [];
  for (const project of fs.readdirSync(root())) {
    const dir = path.join(root(), project);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      sessions.push(summarize(name.slice(0, -6), dir, [weekStart, fiveStart]));
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return {
    sessions: sessions.filter(s => s.requests > 0),
    weekUsd: weekStart === null ? null : sessions.reduce((sum, s) => sum + s.inWindow[0], 0),
    fiveUsd: fiveStart === null ? null : sessions.reduce((sum, s) => sum + s.inWindow[1], 0)
  };
}

module.exports = { scan, scanAll, requestCost, priceResponse, saveCache, PRICES };
if (require.main === module) {
  const [mode, a, b] = process.argv.slice(2);
  const num = value => (value && value !== 'null' ? Number(value) : null);
  const result = mode === '--all' ? scanAll(num(a), num(b)) : scan(mode ?? '');
  saveCache();
  process.stdout.write(JSON.stringify(result));
}
