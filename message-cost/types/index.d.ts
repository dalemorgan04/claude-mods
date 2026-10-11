export type Gauge = {
  session: number | null
  week: number | null
  weekResetsAt: string | null
  sessionStart: number | null
  usd: number | null
}

export type Turn = {
  model: string
  usd: number | null
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    'message-cost': { gauge: Gauge; turn: Turn | null; isOpen: boolean }
  }
}
