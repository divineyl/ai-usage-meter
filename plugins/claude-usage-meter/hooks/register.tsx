import type { EngineInterface, Register } from 'claude-code'

import type { AccountUsage, Overview, Session } from '../types'

const PANE = 'claude-usage-meter'
const HOUR = 3600 * 1000

const overviewRef = { plugin: 'claude-usage-meter', key: 'overview' } as const
const liveRef = { plugin: 'claude-usage-meter', key: 'live' } as const
const sessionIdRef = { plugin: 'claude-usage-meter', key: 'sessionId' } as const
// Whether the strip shows one line; kept in $.store too so new sessions open the same way.
const collapsedRef = { plugin: 'claude-usage-meter', key: 'isCollapsed' } as const
const scanErrorRef = { plugin: 'claude-usage-meter', key: 'scanError' } as const
const COLLAPSED_KEY = 'isCollapsed'

// The userConfig fields, defaults filled in; see .claude-plugin/plugin.json.
type Settings = { weeklyValue: number; currency: 'CNY' | 'USD'; usdToCny: number }

function settingsFrom(options: Record<string, unknown>): Settings {
  const num = (value: unknown, fallback: number) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const currency = String(options.currency ?? 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY'
  return { weeklyValue: num(options.monthlyPrice, 140) / num(options.weeksPerMonth, 4), currency, usdToCny: num(options.usdToCny, 6.8) }
}

function compact(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(Math.round(n))
}
function money(n: number | null | undefined, symbol: string): string {
  return n == null ? '—' : symbol + n.toFixed(2)
}
function percent(n: number | null | undefined): string {
  return n == null ? '—' : (n < 0.1 && n > 0 ? n.toFixed(2) : n.toFixed(1)) + '%'
}
// API prices are USD; in CNY mode the converted amount follows.
function apiCost(usd: number, s: Settings): string {
  return s.currency === 'CNY' ? `${money(usd, '$')} ≈ ${money(usd * s.usdToCny, '¥')}` : money(usd, '$')
}
function localMoney(n: number | null, s: Settings): string {
  return money(n, s.currency === 'CNY' ? '¥' : '$')
}

// Estimated percent of an account window: sessionUsd × usedPercent / windowUsd.
// Callers pass the session's lifetime API dollars (usdTotal), not inWindow.
// Under 1% account usage the ratio is too noisy, so the share stays hidden.
function share(usd: number, windowUsd: number | null | undefined, used: number | null | undefined): number | null {
  if (windowUsd == null || used == null || used < 1 || windowUsd <= 0) return null
  return usd / (windowUsd / used)
}

async function readLive($: EngineInterface): Promise<AccountUsage | null> {
  try {
    const usage = await $.session.usage()
    const pick = (kind: string) => usage.rateLimits.find(r => r.kind === kind)
    const five = pick('five_hour'), week = pick('seven_day')
    return { fiveHourUsed: five?.percentUsed ?? null, weeklyUsed: week?.percentUsed ?? null,
      fiveHourResetsAt: five?.resetsAt ?? null, weeklyResetsAt: week?.resetsAt ?? null }
  } catch {
    return null
  }
}

let isScanning = false

// Reads the account windows, then sums every session's transcripts with the
// API dollars spent inside each window. One scan at a time.
async function refresh($: EngineInterface): Promise<void> {
  const fresh = await readLive($)
  // A response without rate-limit headers reads as nulls; keep the last real reading.
  const { value: last } = await $.state.get(liveRef)
  const live = fresh && (fresh.weeklyUsed !== null || !last) ? fresh : (last ?? null)
  if (live) await $.state.set(liveRef, live)
  if (isScanning) return
  isScanning = true
  try {
    const id = await $.session.id()
    await $.state.set(sessionIdRef, id)
    const weekEnd = live?.weeklyResetsAt ? Date.parse(live.weeklyResetsAt) : Number.NaN
    const fiveEnd = live?.fiveHourResetsAt ? Date.parse(live.fiveHourResetsAt) : Number.NaN
    // An unparseable reset time is "no window", not a zero-dollar window.
    const weekStart = Number.isFinite(weekEnd) ? weekEnd - 7 * 24 * HOUR : null
    const fiveStart = Number.isFinite(fiveEnd) ? fiveEnd - 5 * HOUR : null
    const ran = await $.process.run(['node', `${$.plugin.root}/scan.cjs`, '--all', String(weekStart), String(fiveStart)], { timeoutMs: 120000 })
    if (ran.exitCode !== 0) {
      const stderr = (ran as { stderr?: unknown }).stderr
      const line = typeof stderr === 'string' ? stderr.replace(/\s+/g, ' ').trim() : ''
      const shown = line.length > 300 ? `${line.slice(0, 300)}…` : line
      await $.state.set(scanErrorRef, shown || `scan.cjs 退出码 ${ran.exitCode}`)
      return
    }
    const scanned = JSON.parse(ran.stdout) as Omit<Overview, 'checkedAt'>
    await $.state.set(overviewRef, { ...scanned, checkedAt: await $.clock.now() })
    await $.state.set(scanErrorRef, null)
    const mine = scanned.sessions.find(s => s.id === id)
    if (mine) $.ui.status(`本会话 ${money(mine.usdTotal, '$')}`)
  } catch (error) {
    // Keep the last scan; the next turn tries again.
    const message = error instanceof Error ? error.message : '读取会话记录失败'
    try { await $.state.set(scanErrorRef, message) } catch { /* state itself failed */ }
  } finally {
    isScanning = false
  }
}

function Row({ cells, Box, Text }: { cells: [string, string][]; Box: any; Text: any }) {
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
      {cells.map(([label, value]) => (
        <Text key={label}>
          <Text dimColor>{label} </Text>
          <Text bold>{value}</Text>
        </Text>
      ))}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const settings = settingsFrom(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.state.set(collapsedRef, ((await $.store.get(COLLAPSED_KEY)) ?? true) === true)
    await $.command.register({ name: 'usage-meter', description: '打开所有会话的用量列表' })
    await refresh($)
    return started
  })

  on('command.run', { command: 'usage-meter' }, async $ => {
    await $.ui.open({ id: PANE, title: '会话用量' })
    await refresh($)
    return { text: '已打开会话用量列表。' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await refresh($)
    return result
  })

  // The strip above the prompt, for this session; one line until expanded.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { value: overview } = await $.state.get(overviewRef)
    const { value: live } = await $.state.get(liveRef)
    const { value: id } = await $.state.get(sessionIdRef)
    const s = overview?.sessions.find(one => one.id === id)
    if (!s || !live) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value: isCollapsed = true } = await $.state.get(collapsedRef)
    const toggle = async () => {
      await $.state.set(collapsedRef, !isCollapsed)
      await $.store.set(COLLAPSED_KEY, !isCollapsed)
    }
    const week = share(s.usdTotal, overview?.weekUsd, live.weeklyUsed)
    const five = share(s.usdTotal, overview?.fiveUsd, live.fiveHourUsed)
    const remain = (used: number | null) => (used == null ? '—' : percent(100 - used))
    const scope = s.subagents ? `本会话累计 · 含 ${s.subagents} 个子智能体` : '本会话累计'

    if (isCollapsed) {
      return (
        <Box flexDirection="row" columnGap={2}>
          <Text dimColor wrap="truncate-end">
            本会话 {money(s.usdTotal, '$')} · 占每周 {percent(week)} · 账号剩余 5 小时 {remain(live.fiveHourUsed)} · 每周 {remain(live.weeklyUsed)}
          </Text>
          <Button key="expand" label="展开" onPress={toggle} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text dimColor>{scope} · 账号剩余 5 小时 {remain(live.fiveHourUsed)} · 每周 {remain(live.weeklyUsed)}</Text>
          <Button key="collapse" label="收起" onPress={toggle} />
        </Box>
        <Row Box={Box} Text={Text} cells={[
          ['占 5 小时额度', percent(five)], ['占每周额度', percent(week)],
          ['按周额度折算', localMoney(week === null ? null : week / 100 * settings.weeklyValue, settings)], ['累计 Token', compact(s.total)],
        ]} />
        <Row Box={Box} Text={Text} cells={[
          ['缓存命中', compact(s.tokens.cacheRead)], ['写入缓存', compact(s.tokens.cacheWrite)],
          ['未命中', compact(s.tokens.uncachedInput)], ['输出', compact(s.tokens.output)], ['命中率', percent(s.hitRate === null ? null : s.hitRate * 100)],
        ]} />
        <Row Box={Box} Text={Text} cells={[
          ['按 API 价格', apiCost(s.usdTotal, settings)],
          ['缓存命中', money(s.usd.cacheRead, '$')], ['写入缓存', money(s.usd.cacheWrite, '$')],
          ['未命中', money(s.usd.uncachedInput, '$')], ['输出', money(s.usd.output, '$')],
        ]} />
      </Box>
    )
  })

  // The pane: every session with its own totals, newest first.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { value: overview } = await $.state.get(overviewRef)
    const { value: live } = await $.state.get(liveRef)
    const { value: id } = await $.state.get(sessionIdRef)
    const { value: scanError } = await $.state.get(scanErrorRef)
    if (!overview) return <Text dimColor>{scanError ? `读取会话记录失败：${scanError}` : '正在读取会话记录…'}</Text>
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 6)
    const perWeek = overview.weekUsd != null && live?.weeklyUsed ? overview.weekUsd / live.weeklyUsed * 100 : null

    return (
      <Box flexDirection="column">
        <Text dimColor>Token · 按 API 价格 · 占每周额度（估算）</Text>
        {overview.sessions.slice(0, room).map((s: Session) => {
          const week = share(s.usdTotal, overview.weekUsd, live?.weeklyUsed)
          return (
            <Text key={s.id} bold={s.id === id} wrap="truncate-end">
              {s.id === id ? '▶ ' : '  '}{s.title} <Text dimColor>{compact(s.total)} · {money(s.usdTotal, '$')} · {percent(week)}</Text>
            </Text>
          )
        })}
        <Text dimColor>
          本周期所有会话按 API 价格共 {money(overview.weekUsd, '$')}，账号每周额度已用 {percent(live?.weeklyUsed)}，
          用满约值 {money(perWeek, '$')}。各会话的占比按 API 费用折算，不含网页版和手机 App 的用量。
        </Text>
        {scanError ? <Text dimColor>最近一次读取失败：{scanError}</Text> : null}
      </Box>
    )
  })
}
