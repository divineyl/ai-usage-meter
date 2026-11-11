'use strict';
// The prompt strip is JSX and cannot be imported here. These tests execute the
// pricing, quota-share, and formatting functions from that file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'register.tsx'), 'utf8');
const start = source.indexOf('function settingsFrom');
const end = source.indexOf('async function readLive');
const body = source.slice(start, end)
  .replace(/: Record<string, unknown>/g, '')
  .replace(/: number \| null \| undefined/g, '')
  .replace(/: number \| null/g, '')
  .replace(/: unknown/g, '')
  .replace(/: Settings/g, '')
  .replace(/: number/g, '')
  .replace(/: string/g, '');
const ui = new Function(`${body}\nreturn { settingsFrom, compact, money, percent, apiCost, localMoney, share };`)();
const liveLine = source.match(/const live = .+/)[0];
const mergeLive = new Function('fresh', 'last', `${liveLine}\nreturn live;`);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('settings turn the monthly price into a weekly value and reject blank or non-positive numbers', () => {
  assert.deepEqual(ui.settingsFrom({}), { weeklyValue: 35, currency: 'CNY', usdToCny: 6.8 });
  assert.deepEqual(ui.settingsFrom({ monthlyPrice: 20, weeksPerMonth: 4, currency: 'usd', usdToCny: 7 }), {
    weeklyValue: 5, currency: 'USD', usdToCny: 7
  });
  assert.deepEqual(ui.settingsFrom({ monthlyPrice: 0, weeksPerMonth: -1, currency: 'EUR', usdToCny: 'x' }), {
    weeklyValue: 35, currency: 'CNY', usdToCny: 6.8
  });
  assert.equal(ui.settingsFrom({ monthlyPrice: '140', weeksPerMonth: '5' }).weeklyValue, 28);
});

test('compact, money, and percent format the strip the way the prompt shows it', () => {
  assert.equal(ui.compact(0), '0');
  assert.equal(ui.compact(1.4), '1');
  assert.equal(ui.compact(1.5), '2');
  assert.equal(ui.compact(9999), '9999');
  assert.equal(ui.compact(10000), '1.0万');
  assert.equal(ui.compact(10500), '1.1万');
  assert.equal(ui.compact(34411000), '3441.1万');
  assert.equal(ui.compact(1e8), '1.00亿');
  assert.equal(ui.compact(1.5e8), '1.50亿');
  assert.equal(ui.money(null, '¥'), '—');
  assert.equal(ui.money(undefined, '$'), '—');
  assert.equal(ui.money(1.2, '¥'), '¥1.20');
  assert.equal(ui.percent(null), '—');
  assert.equal(ui.percent(undefined), '—');
  assert.equal(ui.percent(0), '0.0%');
  assert.equal(ui.percent(0.09), '0.09%');
  assert.equal(ui.percent(0.1), '0.1%');
  assert.equal(ui.percent(4.24), '4.2%');
  assert.equal(ui.percent(98.2), '98.2%');
});

test('API dollars convert only in CNY mode, and the weekly value uses the same currency', () => {
  const cny = { currency: 'CNY', usdToCny: 6.8, weeklyValue: 35 };
  const usd = { currency: 'USD', usdToCny: 6.8, weeklyValue: 5 };
  assert.equal(ui.apiCost(13.8, cny), '$13.80 ≈ ¥93.84');
  assert.equal(ui.apiCost(13.8, usd), '$13.80');
  assert.equal(ui.localMoney(1.47, cny), '¥1.47');
  assert.equal(ui.localMoney(null, usd), '—');
  assert.equal(ui.localMoney(0.5, usd), '$0.50');
});

test('a session share is its dollars divided by the current window dollar-per-percent, and a thin window stays unknown', () => {
  near(ui.share(10, 50, 50), 10);
  near(ui.share(2, 2, 1), 1);
  assert.equal(ui.share(0, 10, 10), 0);
  assert.equal(ui.share(10, 50, 0.99), null);
  assert.equal(ui.share(10, 50, 0), null);
  assert.equal(ui.share(10, 0, 50), null);
  assert.equal(ui.share(10, -1, 50), null);
  assert.equal(ui.share(10, null, 50), null);
  assert.equal(ui.share(10, 50, null), null);
  assert.equal(ui.share(10, undefined, 50), null);
});

test('a rate-limit read with no weekly percent keeps the previous limits and still takes a newer engine dollar figure', () => {
  const last = { engineUsd: 1, fiveHourUsed: 10, weeklyUsed: 20, fiveHourResetsAt: 'a', weeklyResetsAt: 'b' };
  assert.equal(mergeLive(null, null), null);
  assert.deepEqual(mergeLive(null, last), last);
  assert.deepEqual(mergeLive({ engineUsd: 4, fiveHourUsed: 1, weeklyUsed: null, fiveHourResetsAt: 'c', weeklyResetsAt: null }, last),
    { ...last, engineUsd: 4 });
  const fresh = { engineUsd: 9, fiveHourUsed: 2, weeklyUsed: 0, fiveHourResetsAt: 'd', weeklyResetsAt: 'e' };
  assert.deepEqual(mergeLive(fresh, last), fresh);
  assert.deepEqual(mergeLive({ engineUsd: null, fiveHourUsed: null, weeklyUsed: null, fiveHourResetsAt: null, weeklyResetsAt: null }, null).weeklyUsed, null);
});
