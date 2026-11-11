'use strict';
const { readMetadata, readConfig } = require('./per-chat-metadata.cjs');

function installPerChatUsage() {
  const KEY = '__codexPerChatUsage';
  if (window[KEY]?.version === 6) { window[KEY].refresh(); return; }
  window[KEY]?.destroy?.();
  const ROW = '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id]';
  let metadata = new Map(), usage = new Map(), checkedAt = null;
  let disposed = false, pending = false, nextFetch = 0, refreshTimer = null;
  const panel = document.createElement('section');
  panel.id = 'codex-per-chat-usage';
  panel.setAttribute('aria-label', '本聊天累计用量');
  const heading = document.createElement('div');
  heading.className = 'codex-chat-usage-heading';
  heading.textContent = '本聊天累计';
  const grid = document.createElement('div');
  grid.className = 'codex-chat-usage-grid';
  const tokenGrid = document.createElement('div');
  tokenGrid.className = 'codex-chat-usage-grid codex-chat-token-breakdown';
  const costGrid = document.createElement('div');
  costGrid.className = 'codex-chat-usage-grid codex-chat-token-breakdown';
  // Weekly allowance valued at ¥140 per 4 weeks; API prices are USD.
  // Settings arrive with each metadata update (per-chat-usage.config.json beside agent.cjs).
  let config = { monthlyPrice: 140, weeksPerMonth: 4, currency: 'CNY', usdToCny: 6.8 };
  const weeklyValue = () => config.monthlyPrice / config.weeksPerMonth;
  const symbol = () => (config.currency === 'USD' ? '$' : '¥');
  const cells = {};
  for (const [key, label] of [['fiveHour', '占 5 小时额度'], ['weekly', '占每周额度'], ['credits', '已用额度'], ['tokens', '累计 Token'],
    ['cachedInput','缓存命中输入'],['uncachedInput','未命中输入'],['output','输出 Token'],['hitRate','缓存命中率'],
    ['apiCost','按 API 价格'],['weeklyCost','按周额度折算']]) {
    const cell = document.createElement('div');
    cell.className = 'codex-chat-usage-cell';
    const caption = document.createElement('span'); caption.textContent = label;
    const value = document.createElement('strong'); value.textContent = '—'; value.dataset.metric = key;
    cell.append(caption, value);
    (['cachedInput','uncachedInput','output','hitRate'].includes(key) ? tokenGrid : ['apiCost','weeklyCost'].includes(key) ? costGrid : grid).append(cell);
    cells[key] = value;
  }
  panel.append(heading, grid, tokenGrid, costGrid);
  const style = document.createElement('style');
  style.id = 'codex-per-chat-usage-style';
  style.textContent = `
    #codex-per-chat-usage {flex:none;box-sizing:border-box;padding:9px 18px 10px;border-bottom:1px solid #8882;
      color:var(--color-text-primary,inherit);background:var(--color-surface-primary,transparent);font-size:12px;line-height:1.5;}
    #codex-per-chat-usage[hidden]{display:none!important;}
    .codex-chat-usage-heading{font-size:11px;opacity:.65;margin-bottom:4px;}
    .codex-chat-usage-grid{display:flex;flex-wrap:wrap;gap:8px 26px;}
    .codex-chat-token-breakdown{margin-top:6px;}
    .codex-chat-usage-cell{display:flex;align-items:baseline;gap:7px;white-space:nowrap;}
    .codex-chat-usage-cell>span{opacity:.65;font-size:11px;}
    .codex-chat-usage-cell>strong{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;}
    [data-codex-thread-tokens]{font-variant-numeric:tabular-nums;}
  `;
  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
  function setData(el, key, value) { const text = String(value ?? ''); if (el.dataset[key] !== text) el.dataset[key] = text; }
  function idForRow(row) {
    if (!row || row.getAttribute('data-app-action-sidebar-thread-host-id') !== 'local' || row.getAttribute('data-app-action-sidebar-thread-kind') !== 'local') return null;
    return /^local:([a-f0-9-]{36})$/i.exec(row.getAttribute('data-app-action-sidebar-thread-id') ?? '')?.[1] ?? null;
  }
  function currentId() { return idForRow(document.querySelector(`${ROW}[data-app-action-sidebar-thread-selected="true"]`)); }
  function number(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; }
  function percent(value) {
    const n = number(value);
    if (n === null) return '—';
    return new Intl.NumberFormat('zh-CN', n !== 0 && n < .01 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 }).format(n) + '%';
  }
  function money(value, symbol) { return value == null ? '—' : symbol + new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value); }
  function apiCostText(usd) { return usd == null ? '—' : config.currency === 'USD' ? money(usd, '$') : `${money(usd, '$')} ≈ ${money(usd * config.usdToCny, '¥')}`; }
  function weeklyCost(weekly) { return weekly == null ? null : weekly / 100 * weeklyValue(); }
  function tokenText(value) { return value == null ? '—' : new Intl.NumberFormat('zh-CN').format(value); }
  function summary(id) {
    const meta = metadata.get(id), entry = usage.get(id);
    const ready = entry?.data_status === 'available';
    return { fiveHour: ready ? number(entry.five_hour_limit_percent) : null,
      weekly: ready ? number(entry.weekly_limit_percent) : null,
      credits: ready ? number(entry.balance_usage_credits) : null,
      tokens: meta?.tokens == null || meta?.descendant_tokens == null ? null : meta.tokens + meta.descendant_tokens,
      breakdown: meta?.breakdown ?? null,
      apiCost: meta?.apiCost ?? null,
      descendants: meta?.descendant_thread_ids?.length ?? 0, ready };
  }
  function refresh() {
    if (disposed) return;
    if (!style.isConnected) (document.head ?? document.documentElement).append(style);
    const timeline = document.querySelector('[data-app-action-timeline-scroll]');
    const host = timeline?.parentElement?.parentElement?.parentElement;
    const id = currentId();
    if (host && id) {
      if (panel.parentElement !== host) host.prepend(panel);
      panel.hidden = false;
      setData(panel, 'threadId', id);
      const value = summary(id);
      const scope = value.descendants ? `本聊天累计 · 含 ${value.descendants} 个子智能体` : '本聊天累计';
      setText(heading, scope + (!value.ready && !pending ? ' · 额度数据暂不可用' : ''));
      setText(cells.fiveHour, percent(value.fiveHour));
      setText(cells.weekly, percent(value.weekly));
      setText(cells.credits, value.credits == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value.credits));
      setText(cells.tokens, tokenText(value.tokens));
      for (const key of ['cachedInput','uncachedInput','output']) {
        setText(cells[key],tokenText(value.breakdown?.[key]));
        setData(panel,key,value.breakdown?.[key]);
      }
      setText(cells.hitRate,value.breakdown?.hitRate == null ? '—' : new Intl.NumberFormat('zh-CN',{style:'percent',maximumFractionDigits:2}).format(value.breakdown.hitRate));
      setData(panel,'hitRate',value.breakdown?.hitRate);
      setText(cells.apiCost, apiCostText(value.apiCost?.usd));
      setText(cells.weeklyCost, money(weeklyCost(value.weekly), symbol()));
      setData(panel, 'apiCostUsd', value.apiCost?.usd); setData(panel, 'weeklyCostCny', weeklyCost(value.weekly));
      const costDetail = `按 API 价格：每次请求按其模型的 OpenAI API 标价分别计算（缓存命中输入、未命中输入、输出），单次输入超过 272K 的请求按长上下文价格（输入×2、输出×1.5），含子智能体。本聊天有 ${value.apiCost?.longRequests ?? '—'} 次长上下文请求。人民币按 1 美元 ≈ ${config.usdToCny} 元换算。
按周额度折算：占每周额度 × ${symbol()}${weeklyValue()}（月费 ${symbol()}${config.monthlyPrice} ÷ ${config.weeksPerMonth} 周）。`;
      if (costGrid.title !== costDetail) costGrid.title = costDetail;
      const tokenDetail = '缓存命中输入 + 未命中输入 + 输出 Token = 累计 Token。缓存命中率按输入 Token 计算。输出包含推理 Token，不重复累计。缺少完整会话记录时显示 —。';
      if(tokenGrid.title !== tokenDetail)tokenGrid.title=tokenDetail;
      setData(panel, 'fiveHour', value.fiveHour); setData(panel, 'weekly', value.weekly);
      setData(panel, 'credits', value.credits); setData(panel, 'tokens', value.tokens);
      setData(panel, 'state', value.ready ? 'ready' : pending ? 'loading' : 'unavailable');
      const detail = `本聊天累计消耗，含子智能体。百分比与设置中的聊天用量排行使用同一接口，可超过 100%。\n数据截至：${checkedAt ? new Date(checkedAt).toLocaleString() : '尚无可用记录'}。\n— 表示数据暂不可用，不代表 0。`;
      if (panel.title !== detail) panel.title = detail;
    } else panel.hidden = true;
    for (const badge of document.querySelectorAll('[data-codex-thread-tokens]')) {
      const rowId = idForRow(badge.closest(ROW));
      if (!rowId) continue;
      const value = summary(rowId);
      setData(badge, 'fiveHour', value.fiveHour); setData(badge, 'weekly', value.weekly); setData(badge, 'credits', value.credits);
      const detail = `本聊天累计（含子智能体）\n占 5 小时额度：${percent(value.fiveHour)}\n占每周额度：${percent(value.weekly)}\n已用额度：${value.credits == null ? '—' : value.credits}\nToken：${tokenText(value.tokens)}\n缓存命中输入：${tokenText(value.breakdown?.cachedInput)}\n未命中输入：${tokenText(value.breakdown?.uncachedInput)}\n输出 Token：${tokenText(value.breakdown?.output)}
按 API 价格：${apiCostText(value.apiCost?.usd)}
按周额度折算：${money(weeklyCost(value.weekly), symbol())}`;
      if (badge.title !== detail) badge.title = detail;
    }
  }
  function batches() {
    const output = []; let batch = [], seen = new Set(), size = 0;
    for (const meta of metadata.values()) {
      const descendants = Array.isArray(meta.descendant_thread_ids) ? meta.descendant_thread_ids : [];
      const ids = [meta.thread_id, ...descendants];
      if (ids.length >= 1000) continue;
      if (batch.length >= 100 || size + ids.length > 1000 || ids.some(id => seen.has(id))) {
        if (batch.length) output.push(batch);
        batch = []; seen = new Set(); size = 0;
      }
      batch.push({ thread_id: meta.thread_id, created_at: meta.created_at, descendant_thread_ids: descendants });
      ids.forEach(id => seen.add(id)); size += ids.length;
    }
    if (batch.length) output.push(batch);
    return output;
  }
  async function fetchUsage(force = false) {
    if (disposed || pending || !metadata.size || (!force && Date.now() < nextFetch)) return;
    pending = true; nextFetch = Date.now() + 60000; refresh();
    try {
      const resource = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/assets\/app-initial-[a-f0-9]+\.js(?:\?|$)/.test(url));
      if (!resource) throw new Error('Codex app bundle not found');
      const module = await import(resource);
      if (disposed) return;
      // The bundle's export names are minified and change between Codex releases:
      // find the API client by its safePost method rather than by name.
      module.sRr?.();
      const client = typeof module.iRr?.safePost === 'function' ? module.iRr
        : Object.values(module).find(value => value && typeof value === 'object' && typeof value.safePost === 'function');
      if (!client) throw new Error('Usage client unavailable');
      const next = new Map(), asOf = [];
      for (const threads of batches()) {
        if (disposed) return;
        const data = await client.safePost('/wham/usage/thread_usage/query_v2', { requestBody: { threads } });
        if (disposed) return;
        for (const row of data.threads ?? []) if (metadata.has(row.thread_id)) next.set(row.thread_id, row);
        if (data.data_as_of) asOf.push(data.data_as_of);
      }
      usage = next; checkedAt = asOf.sort()[0] ?? null;
    } catch {
      usage = new Map(); checkedAt = null;
    } finally { pending = false; if (!disposed) refresh(); }
  }
  function scheduleRefresh() {
    if (refreshTimer !== null || disposed) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 100);
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => !panel.contains(record.target) && record.target !== panel && record.target !== style && !record.target.closest?.('[data-codex-thread-tokens]'))) scheduleRefresh();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-app-action-sidebar-thread-selected', 'data-app-action-sidebar-thread-id'] });
  const poll = setInterval(() => { refresh(); fetchUsage(); }, 15000);
  window[KEY] = { version: 6, refresh,
    updateMetadata(rows, settings) {
      if (settings && typeof settings === 'object') config = { ...config, ...settings };
      const next = new Map((Array.isArray(rows) ? rows : []).filter(row => typeof row?.thread_id === 'string').map(row => [row.thread_id, row]));
      const sameList = (left, right) => {
        const a = Array.isArray(left) ? left : [], b = Array.isArray(right) ? right : [];
        return a.length === b.length && a.every((id, index) => id === b[index]);
      };
      // A new subagent changes the quota query, so it cannot wait out the throttle.
      const changed = [...next].some(([id, row]) => {
        const prev = metadata.get(id);
        return !prev || prev.created_at !== row.created_at || !sameList(prev.descendant_thread_ids, row.descendant_thread_ids);
      });
      metadata = next; if (changed) nextFetch = 0;
      refresh(); fetchUsage();
    },
    status() { return { threadId: currentId(), rows: metadata.size, available: [...usage.values()].filter(row => row.data_status === 'available').length, pending, checkedAt }; },
    refreshUsage() { return fetchUsage(true); },
    destroy() { disposed = true; clearInterval(poll); clearTimeout(refreshTimer); observer.disconnect(); panel.remove(); style.remove(); delete window[KEY]; }
  };
  refresh();
}
module.exports = { installPerChatUsage, readMetadata, readConfig };
