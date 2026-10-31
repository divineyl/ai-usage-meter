export type Categories = { cacheRead: number; cacheWrite: number; uncachedInput: number; output: number }

// One session as scan.cjs sums it, subagents included.
export type Session = {
  id: string
  title: string
  mtime: number
  subagents: number
  requests: number
  unpriced: number
  tokens: Categories
  usd: Categories
  total: number
  hitRate: number | null
  usdTotal: number
}

export type Overview = {
  sessions: Session[]
  // API $ of every session inside the account's current weekly and 5-hour windows.
  weekUsd: number | null
  fiveUsd: number | null
  checkedAt: number
}

export type Live = {
  engineUsd: number | null
  fiveHourUsed: number | null
  weeklyUsed: number | null
  fiveHourResetsAt: string | null
  weeklyResetsAt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'claude-usage-meter': { overview: Overview; live: Live; sessionId: string; isCollapsed: boolean }
  }
}
