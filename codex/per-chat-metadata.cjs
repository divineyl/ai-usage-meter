'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const breakdownCache = new Map();
function readTokenBreakdown(file) {
  if (typeof file !== 'string' || !file) return null;
  let fd;
  try {
    const stat = fs.statSync(file);
    const cached = breakdownCache.get(file);
    if (cached?.size === stat.size && cached?.mtime === stat.mtimeMs && cached?.inode === stat.ino) return cached.result;
    fd = fs.openSync(file, 'r');
    let size = Math.min(stat.size, 256 * 1024), result = null, found = false;
    while (size > 0) {
      const start = Math.max(0, stat.size - size), buffer = Buffer.alloc(size);
      const count = fs.readSync(fd, buffer, 0, size, start);
      let text = buffer.toString('utf8', 0, count);
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!/"type"\s*:\s*"token_count"/.test(lines[i])) continue;
        let event; try { event = JSON.parse(lines[i]); } catch { continue; }
        if (event.payload?.type !== 'token_count') continue;
        const usage = event.payload.info?.total_token_usage;
        if (!usage) continue;
        found = true;
        const input = usage.input_tokens, cachedInput = usage.cached_input_tokens, output = usage.output_tokens;
        const total = usage.total_tokens ?? input + output;
        if ([input, cachedInput, output, total].every(value => Number.isSafeInteger(value) && value >= 0) && cachedInput <= input && total === input + output) {
          result = { input, cachedInput, uncachedInput: input - cachedInput, output, total, hitRate: input ? cachedInput / input : null };
        }
        break;
      }
      if (found || start === 0) break;
      size = Math.min(stat.size, size * 4);
    }
    if (breakdownCache.size >= 1024 && !breakdownCache.has(file)) breakdownCache.delete(breakdownCache.keys().next().value);
    breakdownCache.set(file, { size: stat.size, mtime: stat.mtimeMs, inode: stat.ino, result });
    return result;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
// OpenAI API list prices, USD per 1M tokens (developers.openai.com, 2026-10-29).
// Prompts over 272K input tokens: 2x input/cache, 1.5x output for the whole request.
const PRICES = {
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6.1-terra': { input: 1, cached: 0.05, output: 5 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 }
};
const LONG_CONTEXT = 272000, CACHE_WRITE = 1.25;
const costCache = new Map();
// Absent counters are zero. Anything else that is not a finite, non-negative
// number would make the summed price NaN or negative, which the UI would show
// as a real cost. Numeric strings are accepted because JSON from some dumps
// quotes counters; garbage is rejected.
function tokenCount(value) {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
// Head and tail of a byte range. A rewritten rollout changes one of them;
// an append keeps the previous range intact.
function fileSignature(fd, size) {
  if (size <= 0) return 'empty';
  const span = Math.min(size, 4096);
  const head = Buffer.alloc(span);
  fs.readSync(fd, head, 0, span, 0);
  const seamStart = Math.max(0, size - span);
  const seam = Buffer.alloc(size - seamStart);
  fs.readSync(fd, seam, 0, seam.length, seamStart);
  return crypto.createHash('sha1').update(head).update(seam).digest('hex');
}
function blankCostState(stat, fallbackModel) {
  return { inode: stat.ino, offset: 0, rest: '', model: fallbackModel, usd: 0, unknown: false, sawCorrupt: false, last: null, longRequests: 0, signature: 'empty', mtime: stat.mtimeMs };
}
function consumeCostBytes(state, buffer) {
  const lines = (state.rest + buffer.toString('utf8')).split('\n');
  state.rest = lines.pop();
  for (const line of lines) {
    const isContext = line.includes('"turn_context"'), isCount = line.includes('"token_count"');
    if (!isContext && !isCount) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    const payload = event.payload ?? {};
    if (event.type === 'turn_context') { if (typeof payload.model === 'string') state.model = payload.model; continue; }
    if (payload.type !== 'token_count') continue;
    const total = payload.info?.total_token_usage, last = payload.info?.last_token_usage;
    if (!total) continue;
    const input = tokenCount(total.input_tokens), cached = tokenCount(total.cached_input_tokens);
    const write = tokenCount(total.cache_write_input_tokens), output = tokenCount(total.output_tokens);
    // Skip an unreadable snapshot. The next cumulative line still covers its tokens.
    // Unknown stays false so one bad line does not hide a price we could compute.
    if (input === null || cached === null || write === null || output === null) { state.sawCorrupt = true; continue; }
    const now = { input, cached, write, output };
    const prev = state.last && now.input >= state.last.input && now.output >= state.last.output ? state.last : { input: 0, cached: 0, write: 0, output: 0 };
    const delta = { input: now.input - prev.input, cached: Math.max(0, now.cached - prev.cached), write: Math.max(0, now.write - prev.write), output: now.output - prev.output };
    state.last = now;
    if (!delta.input && !delta.output) continue;
    delta.cached = Math.min(delta.cached, delta.input);
    const price = PRICES[state.model];
    if (!price) { state.unknown = true; continue; }
    let promptInput = delta.input;
    if (last && last.input_tokens != null) {
      const sized = tokenCount(last.input_tokens);
      if (sized !== null) promptInput = sized;
    }
    if (promptInput > LONG_CONTEXT) state.longRequests++;
    state.usd += requestCost(price, delta, promptInput);
  }
}
function requestCost(price, delta, promptInput) {
  const long = promptInput > LONG_CONTEXT, inRate = long ? 2 : 1, outRate = long ? 1.5 : 1;
  const write = Math.min(delta.write, delta.input - delta.cached);
  return ((delta.cached * price.cached + (delta.input - delta.cached - write) * price.input + write * price.input * CACHE_WRITE) * inRate
    + delta.output * price.output * outRate) / 1e6;
}
// Sums every request in a rollout at its own model and context tier; appended bytes are parsed incrementally.
function readApiCost(file, fallbackModel) {
  if (typeof file !== 'string' || !file) return null;
  let fd;
  try {
    const stat = fs.statSync(file);
    let state = costCache.get(file);
    if (!state || state.inode !== stat.ino || stat.size < state.offset) state = blankCostState(stat, fallbackModel);
    // Same size and mtime is the append-only fast path. A rewrite that keeps
    // the length still bumps mtime and must be priced again; a longer rewrite
    // fails the prefix signature and is priced from the start.
    const unchanged = state.offset === stat.size && state.mtime === stat.mtimeMs && state.inode === stat.ino;
    if (!unchanged) {
      fd = fs.openSync(file, 'r');
      const prefixOk = state.offset === 0 || fileSignature(fd, state.offset) === state.signature;
      if (!prefixOk || stat.size === state.offset) state = blankCostState(stat, fallbackModel);
      if (stat.size > state.offset) {
        const length = stat.size - state.offset;
        const buffer = Buffer.alloc(length);
        const count = fs.readSync(fd, buffer, 0, length, state.offset);
        consumeCostBytes(state, buffer.subarray(0, count));
        state.offset = stat.size;
      }
      state.mtime = stat.mtimeMs;
      state.signature = stat.size === 0 ? 'empty' : fileSignature(fd, stat.size);
    }
    if (costCache.size >= 1024 && !costCache.has(file)) costCache.delete(costCache.keys().next().value);
    costCache.set(file, state);
    // No usable counter at all must not look like a real zero. A later good
    // snapshot clears this by setting last, and its delta includes the gap.
    return state.unknown || (state.sawCorrupt && !state.last) ? null : { usd: state.usd, longRequests: state.longRequests };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function storedTokens(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
// A missing breakdown may fall back to the database counter. If that is missing
// too, the contribution is unknown — zero would look like a finished total.
function contribution(breakdown, stored) {
  if (breakdown) return breakdown.total;
  return storedTokens(stored);
}
function descendantTotal(descendants, breakdowns) {
  let sum = 0;
  for (let index = 0; index < descendants.length; index++) {
    const part = contribution(breakdowns[index], descendants[index].tokens_used);
    if (part === null) return null;
    sum += part;
  }
  return sum;
}
function combineCosts(parts) {
  if (!parts.length || parts.some(part => part === null)) return null;
  return parts.reduce((sum, part) => ({ usd: sum.usd + part.usd, longRequests: sum.longRequests + part.longRequests }), { usd: 0, longRequests: 0 });
}
function combineBreakdowns(parts) {
  if (!parts.length || parts.some(part => part === null)) return null;
  const result = { input: 0, cachedInput: 0, uncachedInput: 0, output: 0, total: 0, hitRate: null };
  for (const part of parts) for (const key of ['input', 'cachedInput', 'uncachedInput', 'output', 'total']) result[key] += part[key];
  if (!Object.values(result).every(value => value === null || Number.isSafeInteger(value))) return null;
  result.hitRate = result.input ? result.cachedInput / result.input : null;
  return result;
}
function readMetadata(ids, home = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex')) {
  const file = fs.readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  if (!file) return [];
  const db = new DatabaseSync(path.join(home, file), { readOnly: true, timeout: 500 });
  try {
    const hasModel = db.prepare('PRAGMA table_info(threads)').all().some(column => column.name === 'model');
    const model = hasModel ? 't.model' : 'NULL AS model';
    const thread = db.prepare(`SELECT t.id, t.created_at, t.tokens_used, t.rollout_path, ${model} FROM threads t WHERE t.id = ?`);
    const children = db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?
      UNION SELECT e.child_thread_id FROM thread_spawn_edges e JOIN descendants d ON e.parent_thread_id = d.id
    ) SELECT d.id, t.tokens_used, t.rollout_path, ${model} FROM descendants d LEFT JOIN threads t ON t.id = d.id`);
    return [...new Set(ids)].filter(id => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)).flatMap(id => {
      const row = thread.get(id);
      if (!row) return [];
      const descendants = children.all(id).filter(item => item.id !== id);
      const parentBreakdown = readTokenBreakdown(row.rollout_path);
      const childBreakdowns = descendants.map(item => readTokenBreakdown(item.rollout_path));
      const breakdown = combineBreakdowns([parentBreakdown, ...childBreakdowns]);
      const apiCost = combineCosts([readApiCost(row.rollout_path, row.model), ...descendants.map(item => readApiCost(item.rollout_path, item.model))]);
      return [{ thread_id: id, created_at: row.created_at > 0 ? new Date(row.created_at * 1000).toISOString() : null,
        descendant_thread_ids: descendants.map(item => item.id),
        tokens: contribution(parentBreakdown, row.tokens_used),
        descendant_tokens: descendantTotal(descendants, childBreakdowns),
        breakdown, apiCost }];
    });
  } finally { db.close(); }
}
// Display settings from per-chat-usage.config.json beside this file; defaults when absent or invalid.
const DEFAULT_CONFIG = { monthlyPrice: 140, weeksPerMonth: 4, currency: 'CNY', usdToCny: 6.8 };
function readConfig(dir = __dirname) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(dir, 'per-chat-usage.config.json'), 'utf8')); } catch {}
  const config = { ...DEFAULT_CONFIG };
  for (const key of ['monthlyPrice', 'weeksPerMonth', 'usdToCny']) if (Number.isFinite(saved[key]) && saved[key] > 0) config[key] = saved[key];
  const currency = typeof saved.currency === 'string' ? saved.currency.toUpperCase() : '';
  if (currency === 'USD' || currency === 'CNY') config.currency = currency;
  return config;
}
module.exports = { readMetadata, readTokenBreakdown, readApiCost, readConfig, DEFAULT_CONFIG, PRICES };
