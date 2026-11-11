'use strict';
const fs = require('node:fs');
const path = require('node:path');
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
// OpenAI standard text rates, USD per 1M tokens. Checked 2026-11-11:
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/guides/prompt-caching
// write30m and write12h multiply the input rate. GPT-5.6 and later charge 1.25x for a
// 30-minute write and 2.5x for a 12-hour write. Earlier models have no write premium
// (write30m 1, write12h null). A single cache_write_input_tokens count is the 30-minute
// tier, which is the API default. ttl_30m_tokens and ttl_12h_tokens are billed apart
// when a rollout records them. Prompts over 272K: 2x input/cache/writes and 1.5x output,
// unless long is false.
const tier = (input, cached, output, write30m, write12h, long = true) => ({ input, cached, output, write30m, write12h, long });
const PRICES = {
  'gpt-6-astra': tier(10, 1, 50, 1.25, 2.5),
  'gpt-6.1-sol': tier(2, 0.1, 10, 1.25, 2.5),
  'gpt-6.1-terra': tier(1, 0.05, 5, 1.25, 2.5),
  'gpt-6-luna': tier(0.1, 0.01, 0.5, 1.25, 2.5),
  'gpt-6-sol': tier(2, 0.2, 10, 1.25, 2.5),
  'gpt-5.6-sol': tier(4, 0.4, 20, 1.25, 2.5),
  'gpt-5.6-terra': tier(2, 0.2, 12, 1.25, 2.5),
  'gpt-5.6-luna': tier(0.2, 0.02, 1.2, 1.25, 2.5),
  'gpt-5.5': tier(5, 0.5, 30, 1, null),
  'gpt-5.5-pro': tier(30, null, 180, 1, null),
  'gpt-5.4': tier(2.5, 0.25, 15, 1, null),
  'gpt-5.4-pro': tier(30, null, 180, 1, null),
  'gpt-5.4-mini': tier(0.75, 0.075, 4.5, 1, null, false),
  'gpt-5.4-nano': tier(0.2, 0.02, 1.25, 1, null, false),
  'gpt-5.3-codex': tier(1.75, 0.175, 14, 1, null, false),
  'gpt-5.2': tier(1.75, 0.175, 14, 1, null, false),
  'gpt-5.2-pro': tier(21, null, 168, 1, null, false),
  'gpt-5.1': tier(1.25, 0.125, 10, 1, null, false),
  'gpt-5': tier(1.25, 0.125, 10, 1, null, false),
  'gpt-5-mini': tier(0.25, 0.025, 2, 1, null, false),
  'gpt-5-nano': tier(0.05, 0.005, 0.4, 1, null, false),
  'gpt-5-pro': tier(15, null, 120, 1, null, false),
  'gpt-4.1': tier(2, 0.5, 8, 1, null, false),
  'gpt-4.1-mini': tier(0.4, 0.1, 1.6, 1, null, false),
  'gpt-4o': tier(2.5, 1.25, 10, 1, null, false),
  'gpt-4o-mini': tier(0.15, 0.075, 0.6, 1, null, false),
  'o3': tier(2, 0.5, 8, 1, null, false),
  'o3-pro': tier(20, null, 80, 1, null, false)
};
const LONG_CONTEXT = 272000, CACHE_WRITE = 1.25;
const costCache = new Map();
function requestCost(price, delta, promptInput) {
  const long = price.long !== false && promptInput > LONG_CONTEXT, inRate = long ? 2 : 1, outRate = long ? 1.5 : 1;
  if (delta.cached > 0 && typeof price.cached !== 'number') return null;
  const cachedPrice = price.cached ?? 0;
  let write30, write12;
  if (delta.write30m != null || delta.write12h != null) {
    const room = Math.max(0, delta.input - delta.cached);
    write12 = Math.min(Math.max(0, delta.write12h ?? 0), room);
    write30 = Math.min(Math.max(0, delta.write30m ?? 0), room - write12);
    if (write12 > 0 && !(price.write12h > 0)) return null;
  } else {
    write30 = Math.min(delta.write, delta.input - delta.cached);
    write12 = 0;
  }
  const rate30 = price.write30m ?? CACHE_WRITE, rate12 = price.write12h > 0 ? price.write12h : 0;
  return ((delta.cached * cachedPrice + (delta.input - delta.cached - write30 - write12) * price.input
    + write30 * price.input * rate30 + write12 * price.input * rate12) * inRate
    + delta.output * price.output * outRate) / 1e6;
}
// Sums every request in a rollout at its own model and context tier; appended bytes are parsed incrementally.
function readApiCost(file, fallbackModel) {
  if (typeof file !== 'string' || !file) return null;
  let fd;
  try {
    const stat = fs.statSync(file);
    let state = costCache.get(file);
    if (!state || state.inode !== stat.ino || stat.size < state.offset) {
      state = { inode: stat.ino, offset: 0, rest: '', model: fallbackModel, usd: 0, unknown: false, last: null, longRequests: 0 };
    }
    if (stat.size > state.offset) {
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(stat.size - state.offset);
      fs.readSync(fd, buffer, 0, buffer.length, state.offset);
      state.offset = stat.size;
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
        const details = total.cache_write_tokens_details || total.input_tokens_details?.cache_write_tokens_details;
        const split = details && typeof details === 'object' ? details
          : (total.cache_write_30m_input_tokens != null || total.cache_write_12h_input_tokens != null
            ? { ttl_30m_tokens: total.cache_write_30m_input_tokens ?? 0, ttl_12h_tokens: total.cache_write_12h_input_tokens ?? 0 }
            : null);
        const now = { input: total.input_tokens ?? 0, cached: total.cached_input_tokens ?? 0, write: total.cache_write_input_tokens ?? 0,
          write30m: split ? (split.ttl_30m_tokens ?? 0) : null, write12h: split ? (split.ttl_12h_tokens ?? 0) : null, output: total.output_tokens ?? 0 };
        const prev = state.last && now.input >= state.last.input && now.output >= state.last.output ? state.last : { input: 0, cached: 0, write: 0, output: 0, write30m: 0, write12h: 0 };
        const delta = { input: now.input - prev.input, cached: Math.max(0, now.cached - prev.cached), write: Math.max(0, now.write - prev.write),
          write30m: now.write30m == null ? null : Math.max(0, now.write30m - (prev.write30m ?? 0)),
          write12h: now.write12h == null ? null : Math.max(0, now.write12h - (prev.write12h ?? 0)),
          output: now.output - prev.output };
        state.last = now;
        if (!delta.input && !delta.output) continue;
        delta.cached = Math.min(delta.cached, delta.input);
        const price = PRICES[state.model];
        if (!price) { state.unknown = true; continue; }
        const promptInput = last?.input_tokens ?? delta.input;
        if (promptInput > LONG_CONTEXT && price.long !== false) state.longRequests++;
        const usd = requestCost(price, delta, promptInput);
        if (usd == null || !Number.isFinite(usd)) { state.unknown = true; continue; }
        state.usd += usd;
      }
    }
    if (costCache.size >= 1024 && !costCache.has(file)) costCache.delete(costCache.keys().next().value);
    costCache.set(file, state);
    return state.unknown ? null : { usd: state.usd, longRequests: state.longRequests };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
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
        tokens: parentBreakdown?.total ?? (Number.isSafeInteger(row.tokens_used) && row.tokens_used >= 0 ? row.tokens_used : null),
        descendant_tokens: descendants.reduce((sum, item, index) => sum + (childBreakdowns[index]?.total ?? (Number.isSafeInteger(item.tokens_used) && item.tokens_used >= 0 ? item.tokens_used : 0)), 0),
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
  if (saved.currency === 'USD' || saved.currency === 'CNY') config.currency = saved.currency;
  return config;
}
module.exports = { readMetadata, readTokenBreakdown, readApiCost, readConfig, DEFAULT_CONFIG, PRICES };
