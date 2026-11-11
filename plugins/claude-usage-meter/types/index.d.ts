export type Categories = { cacheRead: number; cacheWrite: number; uncachedInput: number; output: number }

// One session as scan.cjs sums it, subagents included.
export type Session = {
  id: string
  title: string
  mtime: number
  subagents: number
  requests: number
  // Requests whose model is not in the price table. Their tokens stay in `tokens`; their dollars do not.
  unpriced: number
  tokens: Categories
  usd: Categories
  total: number
  // cacheRead / (cacheRead + cacheWrite + uncachedInput), or null when that input is 0.
  hitRate: number | null
  usdTotal: number
  // API dollars at or after each window start passed to scanAll.
  // scanAll uses [weekStart, fiveHourStart]; a single-session scan passes none, so this is [].
  inWindow: number[]
}

export type Overview = {
  sessions: Session[]
  // API $ of priced responses inside the account's current weekly and 5-hour windows.
  // Summed from each session's inWindow, including sessions later hidden for having zero requests.
  weekUsd: number | null
  fiveUsd: number | null
  checkedAt: number
}

// Latest account rate limits reported by Claude Code. The "used" fields are percents already consumed.
export type AccountUsage = {
  fiveHourUsed: number | null
  weeklyUsed: number | null
  fiveHourResetsAt: string | null
  weeklyResetsAt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'claude-usage-meter': { overview: Overview; live: AccountUsage; sessionId: string; isCollapsed: boolean }
  }
}
