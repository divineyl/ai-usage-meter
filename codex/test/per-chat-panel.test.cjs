'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bundle-'));
const assets = path.join(bundleRoot, 'assets');
fs.mkdirSync(assets);
const bundle = path.join(assets, 'app-initial-abc123.js');
const missingClient = path.join(assets, 'app-initial-000000.js');
fs.writeFileSync(bundle, `
export function sRr() { globalThis.__meterSrr = (globalThis.__meterSrr || 0) + 1; }
export const iRr = {
  async safePost(url, body) {
    globalThis.__meterPosts.push({ url, body });
    if (globalThis.__meterImpl) return globalThis.__meterImpl(url, body);
    return { threads: [], data_as_of: '2026-10-20T00:00:00.000Z' };
  }
};
`);
fs.writeFileSync(missingClient, 'export const nope = 1;\n');
const { installPerChatUsage } = require('../per-chat-usage.cjs');

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.className = '';
    this.hidden = false;
    this.id = '';
    this.title = '';
    this.dataset = {};
    this._text = '';
  }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  append(...nodes) { for (const node of nodes) this._attach(node, this.children.length); }
  prepend(node) { this._attach(node, 0); }
  _attach(node, index) {
    if (node.parentElement) node.remove();
    node.parentElement = this;
    this.children.splice(index, 0, node);
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }
  get isConnected() {
    const doc = global.document;
    let node = this;
    while (node) {
      if (node === doc.documentElement || node === doc.head) return true;
      node = node.parentElement;
    }
    return false;
  }
  contains(target) {
    let node = target;
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }
  matches(selector) {
    const parts = [...String(selector).matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
    if (!parts.length) return false;
    return parts.every(part => part[2] === undefined ? this.getAttribute(part[1]) !== null : this.getAttribute(part[1]) === part[2]);
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

const THREAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function resetFetch(resource = bundle) {
  globalThis.__meterPosts = [];
  globalThis.__meterSrr = 0;
  globalThis.__meterImpl = null;
  performance.getEntriesByType = () => [{ name: resource }];
}
function boot({ selected = true, hostId = 'local', kind = 'local', thread = THREAD } = {}) {
  global.window?.__codexPerChatUsage?.destroy?.();
  const documentElement = new El('html');
  const head = new El('head');
  const body = new El('body');
  documentElement.append(head, body);
  const document = {
    documentElement, head, body,
    createElement: tag => new El(tag),
    querySelector: selector => documentElement.querySelector(selector),
    querySelectorAll: selector => documentElement.querySelectorAll(selector)
  };
  global.document = document;
  global.window = {};
  global.MutationObserver = class { constructor() {} observe() {} disconnect() {} };
  const host = new El('section');
  const mid = new El('div');
  const inner = new El('div');
  const timeline = new El('div');
  timeline.setAttribute('data-app-action-timeline-scroll', '');
  inner.append(timeline); mid.append(inner); host.append(mid);
  const row = new El('div');
  row.setAttribute('data-app-action-sidebar-thread-row', '');
  row.setAttribute('data-app-action-sidebar-thread-id', `local:${thread}`);
  row.setAttribute('data-app-action-sidebar-thread-host-id', hostId);
  row.setAttribute('data-app-action-sidebar-thread-kind', kind);
  if (selected) row.setAttribute('data-app-action-sidebar-thread-selected', 'true');
  const badge = new El('span');
  badge.setAttribute('data-codex-thread-tokens', '');
  row.append(badge);
  body.append(host, row);
  resetFetch();
  installPerChatUsage();
  return { document, host, row, badge, api: global.window.__codexPerChatUsage };
}
function walk(node, found = []) {
  found.push(node);
  for (const child of node.children || []) walk(child, found);
  return found;
}
function metric(root, key) { return walk(root).find(node => node.dataset?.metric === key); }
function panelOf(host) { return host.children.find(node => node.id === 'codex-per-chat-usage'); }
function heading(panel) { return walk(panel).find(node => node.className === 'codex-chat-usage-heading'); }
async function until(check) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('timed out');
}
function rowOf(id, extra = {}) {
  return {
    thread_id: id, created_at: '2026-10-20T00:00:00.000Z', descendant_thread_ids: [],
    tokens: 10, descendant_tokens: 0, ...extra
  };
}
test.after(() => { global.window?.__codexPerChatUsage?.destroy?.(); });

test('the panel stays hidden without a selected local chat and shows an em dash for missing numbers', async () => {
  const hidden = boot({ selected: false });
  assert.equal(panelOf(hidden.host), undefined);
  hidden.api.destroy();

  const cloud = boot({ hostId: 'cloud' });
  assert.equal(panelOf(cloud.host), undefined);
  assert.equal(cloud.badge.title, '');
  cloud.api.destroy();

  const view = boot();
  const panel = panelOf(view.host);
  assert.equal(panel.hidden, false);
  view.api.updateMetadata([rowOf(THREAD, {
    tokens: 100, descendant_tokens: null,
    breakdown: null, apiCost: null, descendant_thread_ids: ['child']
  })]);
  await until(() => view.api.status().pending === false);
  assert.equal(metric(panel, 'tokens').textContent, '—');
  assert.equal(metric(panel, 'cachedInput').textContent, '—');
  assert.equal(metric(panel, 'hitRate').textContent, '—');
  assert.equal(metric(panel, 'apiCost').textContent, '—');
  assert.equal(metric(panel, 'fiveHour').textContent, '—');
  assert.match(heading(panel).textContent, /含 1 个子智能体/);
  assert.match(heading(panel).textContent, /额度数据暂不可用/);
  assert.equal(panel.dataset.state, 'unavailable');
  assert.match(panel.title, /不代表 0/);
  assert.match(panel.title, /数据截至/);
});

test('CNY and USD settings format both the API price and the weekly allowance', async () => {
  const view = boot();
  const panel = panelOf(view.host);
  const meta = rowOf(THREAD, {
    tokens: 200, descendant_tokens: 55,
    descendant_thread_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    breakdown: { cachedInput: 180, uncachedInput: 70, output: 25, hitRate: 0.72 },
    apiCost: { usd: 13.8, longRequests: 2 }
  });
  globalThis.__meterImpl = () => ({
    threads: [{ thread_id: THREAD, data_status: 'available', five_hour_limit_percent: 0.004, weekly_limit_percent: 10, balance_usage_credits: 0 }],
    data_as_of: '2026-10-21T00:00:00.000Z'
  });
  view.api.updateMetadata([meta]);
  await until(() => view.api.status().checkedAt === '2026-10-21T00:00:00.000Z');
  assert.equal(view.api.status().available, 1);
  assert.ok(globalThis.__meterSrr >= 1);
  assert.equal(metric(panel, 'tokens').textContent, '255');
  assert.equal(metric(panel, 'cachedInput').textContent, '180');
  assert.equal(metric(panel, 'hitRate').textContent, '72%');
  assert.equal(metric(panel, 'fiveHour').textContent, '0.004%');
  assert.equal(metric(panel, 'weekly').textContent, '10%');
  assert.equal(metric(panel, 'credits').textContent, '0');
  assert.equal(metric(panel, 'apiCost').textContent, '$13.80 ≈ ¥93.84');
  assert.equal(metric(panel, 'weeklyCost').textContent, '¥3.50');
  assert.equal(heading(panel).textContent, '本聊天累计 · 含 1 个子智能体');
  assert.match(view.badge.title, /¥3\.50/);
  assert.match(walk(panel).find(node => node.title?.includes('长上下文')).title, /本聊天有 2 次长上下文请求/);

  view.api.updateMetadata([meta], { monthlyPrice: 20, weeksPerMonth: 4, currency: 'USD', usdToCny: 7 });
  assert.equal(globalThis.__meterPosts.length, 1);
  assert.equal(metric(panel, 'apiCost').textContent, '$13.80');
  assert.equal(metric(panel, 'weeklyCost').textContent, '$0.50');
  assert.match(view.badge.title, /\$0\.50/);
  assert.equal(panel.dataset.state, 'ready');
});

test('quota figures are hidden until the response is available, including zero and values over 100', async () => {
  const view = boot();
  const panel = panelOf(view.host);
  let release;
  globalThis.__meterImpl = () => new Promise(resolve => { release = resolve; });
  view.api.updateMetadata([rowOf(THREAD, { breakdown: { cachedInput: 0, uncachedInput: 4, output: 1, hitRate: 0 }, apiCost: { usd: 0, longRequests: 0 } })]);
  await until(() => typeof release === 'function');
  assert.equal(view.api.status().pending, true);
  assert.equal(panel.dataset.state, 'loading');
  assert.equal(heading(panel).textContent, '本聊天累计');
  assert.equal(metric(panel, 'hitRate').textContent, '0%');
  release({
    threads: [{ thread_id: THREAD, data_status: 'pending', five_hour_limit_percent: 80, weekly_limit_percent: 80, balance_usage_credits: 4 }],
    data_as_of: '2026-10-22T00:00:00.000Z'
  });
  await until(() => view.api.status().pending === false);
  assert.equal(metric(panel, 'fiveHour').textContent, '—');
  assert.equal(metric(panel, 'credits').textContent, '—');
  assert.equal(metric(panel, 'apiCost').textContent, '$0.00 ≈ ¥0.00');

  globalThis.__meterImpl = () => ({
    threads: [{ thread_id: THREAD, data_status: 'available', five_hour_limit_percent: 120.456, weekly_limit_percent: -1, balance_usage_credits: 1.5 }],
    data_as_of: '2026-10-23T00:00:00.000Z'
  });
  await view.api.refreshUsage();
  assert.equal(metric(panel, 'fiveHour').textContent, '120.46%');
  assert.equal(metric(panel, 'weekly').textContent, '—');
  assert.equal(metric(panel, 'credits').textContent, '1.5');
  assert.match(panel.title, /可超过 100%/);
});

test('usage queries are split on size and shared ids, and a changed subagent list refetches immediately', async () => {
  const view = boot();
  const posts = () => globalThis.__meterPosts.map(post => post.body.requestBody.threads);
  const many = Array.from({ length: 101 }, (_, index) => rowOf(`thread-${index}`));
  view.api.updateMetadata(many);
  await until(() => globalThis.__meterPosts.length === 2 && view.api.status().pending === false);
  assert.equal(posts()[0].length, 100);
  assert.equal(posts()[1].length, 1);
  assert.equal(posts()[0][0].descendant_thread_ids.length, 0);

  globalThis.__meterPosts = [];
  view.api.updateMetadata(many);
  await until(() => view.api.status().pending === false);
  assert.equal(globalThis.__meterPosts.length, 0);

  const shared = 'shared-child';
  view.api.updateMetadata([
    rowOf('left', { descendant_thread_ids: [shared] }),
    rowOf('right', { descendant_thread_ids: [shared] })
  ]);
  await until(() => globalThis.__meterPosts.length === 2);
  assert.equal(posts().at(-2)[0].thread_id, 'left');
  assert.equal(posts().at(-1)[0].thread_id, 'right');

  globalThis.__meterPosts = [];
  const huge = rowOf('huge', { descendant_thread_ids: Array.from({ length: 999 }, (_, index) => `d${index}`) });
  view.api.updateMetadata([huge, rowOf('kept')]);
  await until(() => globalThis.__meterPosts.length === 1 && view.api.status().pending === false);
  assert.deepEqual(posts()[0].map(item => item.thread_id), ['kept']);

  globalThis.__meterPosts = [];
  view.api.updateMetadata([{ thread_id: 'solo', tokens: 1, descendant_tokens: 0 }]);
  await until(() => globalThis.__meterPosts.length === 1);
  assert.deepEqual(posts()[0][0].descendant_thread_ids, []);

  globalThis.__meterPosts = [];
  view.api.updateMetadata([rowOf('solo')]);
  await until(() => globalThis.__meterPosts.length === 1);
  const before = globalThis.__meterPosts.length;
  view.api.updateMetadata([rowOf('solo')]);
  await until(() => view.api.status().pending === false);
  assert.equal(globalThis.__meterPosts.length, before);
  view.api.updateMetadata([rowOf('solo', { descendant_thread_ids: ['new-child'] })]);
  await until(() => globalThis.__meterPosts.length === before + 1);
  view.api.updateMetadata([rowOf('solo', { descendant_thread_ids: ['new-child'], created_at: '2026-10-21T00:00:00.000Z' })]);
  await until(() => globalThis.__meterPosts.length === before + 2);
  await view.api.refreshUsage();
  assert.equal(globalThis.__meterPosts.length, before + 3);
});

test('a missing bundle, a missing client, and a failed request all clear the quota without throwing', async () => {
  const view = boot();
  performance.getEntriesByType = () => [];
  view.api.updateMetadata([rowOf(THREAD)]);
  await until(() => view.api.status().pending === false);
  assert.equal(view.api.status().available, 0);
  assert.equal(view.api.status().checkedAt, null);
  assert.match(panelOf(view.host).title, /尚无可用记录/);
  assert.equal(panelOf(view.host).dataset.state, 'unavailable');

  resetFetch(missingClient);
  view.api.updateMetadata([rowOf(THREAD, { created_at: '2026-10-22T00:00:00.000Z' })]);
  await until(() => view.api.status().pending === false && globalThis.__meterSrr === 0);
  assert.equal(view.api.status().available, 0);

  resetFetch(bundle);
  globalThis.__meterImpl = () => { throw new Error('usage down'); };
  view.api.updateMetadata([rowOf(THREAD, { created_at: '2026-10-23T00:00:00.000Z' })]);
  await until(() => view.api.status().pending === false && globalThis.__meterPosts.length === 1);
  assert.equal(view.api.status().checkedAt, null);
  assert.equal(view.api.status().available, 0);
});

test('bad metadata rows are ignored, a second install refreshes in place, and destroy removes the panel', () => {
  const view = boot();
  view.api.updateMetadata(null);
  assert.equal(view.api.status().rows, 0);
  view.api.updateMetadata([null, { thread_id: 4 }, { nope: true }, rowOf(THREAD)]);
  assert.equal(view.api.status().rows, 1);
  assert.equal(view.api.status().threadId, THREAD);
  installPerChatUsage();
  assert.equal(view.host.children.filter(node => node.id === 'codex-per-chat-usage').length, 1);
  const style = view.document.head.children.find(node => node.id === 'codex-per-chat-usage-style');
  assert.equal(style.isConnected, true);
  view.api.destroy();
  assert.equal(global.window.__codexPerChatUsage, undefined);
  assert.equal(style.isConnected, false);
  assert.equal(panelOf(view.host), undefined);
});

test('the earliest data_as_of is kept when a query is split across responses', async () => {
  const view = boot();
  globalThis.__meterImpl = () => ({
    threads: [],
    data_as_of: globalThis.__meterPosts.length === 1 ? '2026-10-22T00:00:00.000Z' : '2026-10-21T00:00:00.000Z'
  });
  view.api.updateMetadata([
    rowOf('one', { descendant_thread_ids: ['shared'] }),
    rowOf('two', { descendant_thread_ids: ['shared'] })
  ]);
  await until(() => view.api.status().pending === false && globalThis.__meterPosts.length === 2);
  assert.equal(view.api.status().checkedAt, '2026-10-21T00:00:00.000Z');
});
