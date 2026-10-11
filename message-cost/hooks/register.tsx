import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Chat, Gauge, Tokens, Turn } from '../types'

type Baseline = { usd: number; session: number | null; week: number | null }
type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }
type Row = [label: string, value: string, color?: string]

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MIN_BURN_HOURS = 0.1

const noTokens: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
const noChat: Chat = { turns: 0, usd: 0, tokens: noTokens, sessionPct: 0, weekPct: 0 }

const gauge = atom(
  { plugin: 'message-cost', key: 'gauge' } as const,
  {
    session: null,
    week: null,
    weekResetsAt: null,
    fiveResetsAt: null,
    sessionStart: null,
    startedMs: null,
    usd: null,
    context: null,
  } as Gauge,
)
const turn = atom({ plugin: 'message-cost', key: 'turn' } as const, null as Turn | null)
// Lives in the session's state, so a hot reload keeps it and a new session starts it over.
const chat = atom({ plugin: 'message-cost', key: 'chat' } as const, noChat)
const isOpen = atom({ plugin: 'message-cost', key: 'isOpen' } as const, false)

const LABEL_WIDTH = 11
const VALUE_WIDTH = 9
const GAP_WIDTH = 3
const BLOCK_WIDTH = LABEL_WIDTH + VALUE_WIDTH

const money = (usd: number) => (usd < 0.0001 ? '<$0.0001' : `$${usd.toFixed(4)}`)
const pct = (n: number | null) => (n === null ? 'n/a' : `${n.toFixed(1)}%`)
const pct2 = (n: number | null | undefined) => (n == null ? 'n/a' : `${n.toFixed(2)}%`)
const count = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
const windowOf = (limits: RateLimit[], kind: string) => limits.find(one => one.kind === kind)
const windowPct = (limits: RateLimit[], kind: string) => windowOf(limits, kind)?.percentUsed ?? null
const spentSince = (now: number | null, before: number | null) =>
  now === null || before === null ? null : Math.max(0, now - before)

// Share of the input the prompt cache served: the cheap part of a turn.
const hitRate = (t: Tokens | null) => {
  if (!t) return null
  const total = t.cacheRead + t.cacheWrite + t.input

  return total === 0 ? null : (t.cacheRead / total) * 100
}

// Green while there is room, yellow as it fills, red near the limit.
const usedColor = (n: number | null) => (n === null ? undefined : n >= 85 ? 'error' : n >= 60 ? 'warning' : 'success')
// The reverse: a high cache hit rate is the good end.
const hitColor = (n: number | null) => (n === null ? undefined : n >= 80 ? 'success' : n >= 50 ? 'warning' : 'error')

const countdown = (resetsAt: string | null, nowMs: number) => {
  if (resetsAt === null) return 'n/a'
  const ms = Date.parse(resetsAt) - nowMs
  if (!(ms > 0)) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes >= 24 * 60) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`

  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}

// Whole calendar days left in the week, today included and the reset day not:
// resetting at 6am Friday, Sunday has Sunday to Thursday, five days.
const daysLeftInWeek = (resetsAt: string, nowMs: number) => {
  const reset = new Date(resetsAt)
  const today = new Date(nowMs)
  reset.setHours(0, 0, 0, 0)
  today.setHours(0, 0, 0, 0)

  return Math.round((reset.getTime() - today.getTime()) / DAY_MS)
}

// The weekly allowance left, split over the days left. The reset morning
// itself counts as one day, so the figure stays finite on the last day.
const weeklyPerDay = (week: number | null, resetsAt: string | null, nowMs: number) => {
  if (week === null || resetsAt === null || Date.parse(resetsAt) <= nowMs) return null

  return Math.max(0, 100 - week) / Math.max(daysLeftInWeek(resetsAt, nowMs), 1)
}

// What the week has averaged per day over the days before today; the per-day
// ceiling falling below it means the rest of the week cannot be paid for at
// this pace.
const weeklyPace = (week: number | null, resetsAt: string | null, nowMs: number) => {
  if (week === null || resetsAt === null) return null
  const elapsed = 7 - daysLeftInWeek(resetsAt, nowMs)

  return week / Math.max(elapsed, 1)
}

const addTurn = (current: Chat, one: Pick<Turn, 'usd' | 'tokens' | 'sessionPct' | 'weekPct'>): Chat => ({
  turns: current.turns + 1,
  usd: current.usd + (one.usd ?? 0),
  sessionPct: (current.sessionPct ?? 0) + (one.sessionPct ?? 0),
  weekPct: (current.weekPct ?? 0) + (one.weekPct ?? 0),
  tokens: one.tokens
    ? {
        input: current.tokens.input + one.tokens.input,
        cacheRead: current.tokens.cacheRead + one.tokens.cacheRead,
        cacheWrite: current.tokens.cacheWrite + one.tokens.cacheWrite,
        output: current.tokens.output + one.tokens.output,
      }
    : current.tokens,
})

const tokenRows = (cost: string, t: Tokens | null, sessionPct: number | null | undefined, weekPct: number | null | undefined): Row[] => {
  const rate = hitRate(t)

  return [
    ['Cost', cost],
    ['C.read', t ? count(t.cacheRead) : 'n/a'],
    ['C.write', t ? count(t.cacheWrite) : 'n/a'],
    ['In', t ? count(t.input) : 'n/a'],
    ['Out', t ? count(t.output) : 'n/a'],
    ['Hit rate', pct(rate), hitColor(rate)],
    ['% of 5h', pct2(sessionPct)],
    ['% of week', pct2(weekPct)],
  ]
}

export const register: Register = on => {
  // Where the last measurement left the session: the ledger's dollars and the
  // two windows' percentages. Each turn's growth is measured from here, so a
  // tool loop's several model turns each get their own share.
  let baseline: Baseline = { usd: 0, session: null, week: null }

  on('session.start', async ($, e, next) => {
    // A status line set by an earlier load of this mod outlives it; clear it.
    $.ui.status(undefined)

    const usage = await $.session.usage()
    const nowMs = await $.clock.now()
    const session = windowPct(usage.rateLimits, 'five_hour')
    const week = windowPct(usage.rateLimits, 'seven_day')
    baseline = { usd: usage.cost?.usd ?? 0, session, week }
    // The starting point is kept across reloads: only its first reading counts.
    await update($, gauge, current => ({
      session,
      week,
      weekResetsAt: windowOf(usage.rateLimits, 'seven_day')?.resetsAt ?? null,
      fiveResetsAt: windowOf(usage.rateLimits, 'five_hour')?.resetsAt ?? null,
      sessionStart: current.sessionStart ?? session,
      startedMs: current.startedMs ?? nowMs,
      usd: usage.cost?.usd ?? null,
      context: usage.context.percent ?? null,
    }))

    // A turn that finished before this load (the mod was added or changed
    // mid-chat) was never totalled: count it once, so the totals start level
    // with the last message.
    const earlier = await read($, turn)
    if (earlier) await update($, chat, current => (current.turns === 0 ? addTurn(current, earlier) : current))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)
    // A subagent's turns carry an agentId; the panel is about the main loop.
    if (e.agentId) return answer

    const tokens = e.usage
      ? {
          input: e.usage.input_tokens,
          cacheRead: e.usage.cache_read_input_tokens,
          cacheWrite: e.usage.cache_creation_input_tokens,
          output: e.usage.output_tokens,
        }
      : null
    const model = e.usage?.model ?? 'unknown'

    // Keep the tokens even if the ledger read fails: they are the part the
    // panel can always show.
    const usage = await $.session.usage().catch(() => null)
    if (!usage) {
      await update($, turn, () => ({ model, usd: null, tokens, sessionPct: null, weekPct: null }))
      await update($, chat, current => addTurn(current, { usd: null, tokens, sessionPct: null, weekPct: null }))
      return answer
    }
    const usd = usage.cost?.usd ?? null
    const session = windowPct(usage.rateLimits, 'five_hour')
    const week = windowPct(usage.rateLimits, 'seven_day')
    const weekResetsAt = windowOf(usage.rateLimits, 'seven_day')?.resetsAt ?? null
    const fiveResetsAt = windowOf(usage.rateLimits, 'five_hour')?.resetsAt ?? null

    const turnUsd = usd === null ? null : spentSince(usd, baseline.usd)
    const record: Turn = {
      model,
      usd: turnUsd,
      tokens,
      sessionPct: spentSince(session, baseline.session),
      weekPct: spentSince(week, baseline.week),
    }

    baseline = { usd: usd ?? baseline.usd, session, week }
    await update($, turn, () => record)
    await update($, chat, current => addTurn(current, record))
    await update($, gauge, current => ({
      ...current,
      session,
      week,
      weekResetsAt,
      fiveResetsAt,
      usd,
      context: usage.context.percent ?? null,
    }))

    return answer
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const stored = await read($, gauge)
    // The windows move as responses land, so read them fresh rather than as
    // they stood when the last turn ended.
    const live = await $.session.usage().catch(() => null)
    const now: Gauge = live
      ? {
          ...stored,
          session: windowPct(live.rateLimits, 'five_hour'),
          week: windowPct(live.rateLimits, 'seven_day'),
          weekResetsAt: windowOf(live.rateLimits, 'seven_day')?.resetsAt ?? stored.weekResetsAt,
          fiveResetsAt: windowOf(live.rateLimits, 'five_hour')?.resetsAt ?? stored.fiveResetsAt,
          usd: live.cost?.usd ?? stored.usd,
          context: live.context.percent ?? stored.context,
        }
      : stored
    const last = await read($, turn)
    const total = await read($, chat)
    const open = await read($, isOpen)
    const nowMs = await $.clock.now()

    // Pinned to the panel's top-right corner, whichever state it is in.
    const toggle = (
      <Box position="absolute" top={0} right={0} paddingX={1} paddingTop={1}>
        <Button
          key="toggle"
          label={open ? '▴ Hide stats' : '▾ Show stats'}
          onPress={() => update($, isOpen, value => !value)}
        />
      </Box>
    )

    const perDay = weeklyPerDay(now.week, now.weekResetsAt, nowMs)
    const pace = weeklyPace(now.week, now.weekResetsAt, nowMs)
    // Red when the per-day ceiling has fallen below the pace the week has run at.
    const perDayColor = perDay === null || pace === null ? undefined : perDay < pace ? 'error' : 'success'

    if (!open) {
      return (
        <Box position="relative" flexDirection="row" borderStyle="round" borderColor="subtle" paddingX={2} paddingRight={20}>
          <Text dimColor>5h </Text>
          <Text bold color={usedColor(now.session)}>{pct(now.session)}</Text>
          <Text dimColor>  ·  Week </Text>
          <Text bold color={usedColor(now.week)}>{pct(now.week)}</Text>
          <Text bold color={perDayColor}>{perDay === null ? '' : ` (${perDay.toFixed(0)}%)`}</Text>
          <Text dimColor>  ·  Last </Text>
          <Text bold>{last?.usd == null ? 'n/a' : money(last.usd)}</Text>
          <Text dimColor>{last ? ` (${pct2(last.sessionPct)} / ${pct2(last.weekPct)})` : ''}</Text>
          {toggle}
        </Box>
      )
    }

    const sessionShare = spentSince(now.session, now.sessionStart)
    const hours = now.startedMs === null ? 0 : (nowMs - now.startedMs) / HOUR_MS
    const burn = sessionShare === null || hours < MIN_BURN_HOURS ? null : sessionShare / hours

    const sessionRows: Row[] = [
      ['5h used', pct(now.session), usedColor(now.session)],
      ['Weekly', pct(now.week), usedColor(now.week)],
      ['Spent', now.usd === null ? 'n/a' : money(now.usd)],
      ['Since start', pct(sessionShare)],
      ['Wk left/day', perDay === null ? 'n/a' : `${perDay.toFixed(1)}%`, perDayColor],
      ['5h resets', countdown(now.fiveResetsAt, nowMs)],
      ['Burn/hr', burn === null ? 'n/a' : `${burn.toFixed(1)}%`],
      ['Context', pct(now.context), usedColor(now.context)],
    ]
    const lastRows = tokenRows(last?.usd == null ? 'n/a' : money(last.usd), last?.tokens ?? null, last?.sessionPct, last?.weekPct)
    const chatRows: Row[] = [
      ...tokenRows(money(total.usd), total.turns === 0 ? null : total.tokens, total.turns === 0 ? null : total.sessionPct, total.turns === 0 ? null : total.weekPct),
      ['Messages', `${total.turns}`],
      ['Avg cost', total.turns === 0 ? 'n/a' : money(total.usd / total.turns)],
    ]
    const height = Math.max(sessionRows.length, lastRows.length, chatRows.length)
    const rule = '─'.repeat(BLOCK_WIDTH)

    const cell = (row: Row | undefined, key: string) => (
      <Box key={key} width={BLOCK_WIDTH} flexDirection="row">
        <Box width={LABEL_WIDTH}>
          <Text dimColor>{row ? row[0] : ''}</Text>
        </Box>
        <Box width={VALUE_WIDTH} justifyContent="flex-end">
          <Text bold color={row?.[2]}>{row ? row[1] : ''}</Text>
        </Box>
      </Box>
    )
    const gap = (key: string) => <Box key={key} width={GAP_WIDTH} />

    return (
      <Box position="relative" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={2}>
        <Box flexDirection="row">
          <Box width={BLOCK_WIDTH}>
            <Text bold color="claude">Session</Text>
          </Box>
          {gap('g1')}
          <Box width={BLOCK_WIDTH}>
            <Text bold color="claude">Last message</Text>
          </Box>
          {gap('g2')}
          <Box width={BLOCK_WIDTH}>
            <Text bold color="claude">This chat</Text>
          </Box>
        </Box>
        <Box flexDirection="row">
          <Box width={BLOCK_WIDTH}>
            <Text dimColor>{rule}</Text>
          </Box>
          {gap('r1')}
          <Box width={BLOCK_WIDTH}>
            <Text dimColor>{rule}</Text>
          </Box>
          {gap('r2')}
          <Box width={BLOCK_WIDTH}>
            <Text dimColor>{rule}</Text>
          </Box>
        </Box>
        {Array.from({ length: height }, (_, i) => (
          <Box key={`row-${i}`} flexDirection="row">
            {cell(sessionRows[i], 's')}
            {gap('g1')}
            {cell(lastRows[i], 'l')}
            {gap('g2')}
            {cell(chatRows[i], 'c')}
          </Box>
        ))}
        {last ? <Text dimColor>{last.model}</Text> : null}
        {toggle}
      </Box>
    )
  })
}
