export type Gauge = {
  session: number | null
  week: number | null
  weekResetsAt: string | null
  fiveResetsAt: string | null
  sessionStart: number | null
  startedMs: number | null
  usd: number | null
  context: number | null
}

export type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number }

export type Turn = {
  model: string
  usd: number | null
  tokens: Tokens | null
  // Percentage points of the 5h and weekly windows the message used.
  sessionPct: number | null
  weekPct: number | null
}

export type Chat = {
  turns: number
  usd: number
  tokens: Tokens
  // Percentage points of the 5h and weekly windows the chat has used.
  sessionPct: number
  weekPct: number
}

declare module 'claude-code' {
  interface PluginState {
    'message-cost': { gauge: Gauge; turn: Turn | null; chat: Chat; isOpen: boolean }
  }
}
