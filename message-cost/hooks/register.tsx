import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Gauge, Turn } from '../types'

type Baseline = { usd: number; session: number | null; week: number | null }
type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

const DAY_MS = 86_400_000
const MIN_DAYS_LEFT = 1 / 24

const gauge = atom(
  { plugin: 'message-cost', key: 'gauge' } as const,
  { session: null, week: null, weekResetsAt: null, sessionStart: null, usd: null } as Gauge,
)
const turn = atom({ plugin: 'message-cost', key: 'turn' } as const, null as Turn | null)
const isOpen = atom({ plugin: 'message-cost', key: 'isOpen' } as const, false)

const LABEL_WIDTH = 22
const VALUE_WIDTH = 10
const GAP_WIDTH = 3
const money = (usd: number) => (usd < 0.0001 ? '<$0.0001' : `$${usd.toFixed(4)}`)
const pct = (n: number | null) => (n === null ? 'n/a' : `${n.toFixed(1)}%`)
const count = (tokens: number) => (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`)
const windowOf = (limits: RateLimit[], kind: string) => limits.find(one => one.kind === kind)
const windowPct = (limits: RateLimit[], kind: string) => windowOf(limits, kind)?.percentUsed ?? null
const spentSince = (now: number | null, before: number | null) =>
  now === null || before === null ? null : Math.max(0, now - before)

// The weekly allowance left, split over the days until the week resets: a
// rough per-day ceiling. Less than an hour left counts as an hour, so the
// figure stays finite as the reset nears.
const weeklyPerDay = (week: number | null, resetsAt: string | null, nowMs: number) => {
  if (week === null || resetsAt === null) return null
  const daysLeft = (Date.parse(resetsAt) - nowMs) / DAY_MS
  if (daysLeft <= 0) return null

  return Math.max(0, 100 - week) / Math.max(daysLeft, MIN_DAYS_LEFT)
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
    const session = windowPct(usage.rateLimits, 'five_hour')
    const week = windowPct(usage.rateLimits, 'seven_day')
    baseline = { usd: usage.cost?.usd ?? 0, session, week }
    await update($, gauge, () => ({
      session,
      week,
      weekResetsAt: windowOf(usage.rateLimits, 'seven_day')?.resetsAt ?? null,
      sessionStart: session,
      usd: usage.cost?.usd ?? null,
    }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)
    const usage = await $.session.usage()
    const usd = usage.cost?.usd ?? null
    const session = windowPct(usage.rateLimits, 'five_hour')
    const week = windowPct(usage.rateLimits, 'seven_day')
    const weekResetsAt = windowOf(usage.rateLimits, 'seven_day')?.resetsAt ?? null

    const record: Turn = {
      model: e.usage?.model ?? 'unknown',
      usd: usd === null ? null : spentSince(usd, baseline.usd),
      tokens: e.usage
        ? {
            input: e.usage.input_tokens,
            cacheRead: e.usage.cache_read_input_tokens,
            cacheWrite: e.usage.cache_creation_input_tokens,
            output: e.usage.output_tokens,
          }
        : null,
    }

    baseline = { usd: usd ?? baseline.usd, session, week }
    await update($, turn, () => record)
    await update($, gauge, current => ({ ...current, session, week, weekResetsAt, usd }))

    return answer
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, gauge)
    const last = await read($, turn)
    const open = await read($, isOpen)
    const nowMs = await $.clock.now()

    // Pinned to the panel's top-right corner, whichever state it is in.
    const toggle = (
      <Box position="absolute" top={0} right={1}>
        <Button
          key="toggle"
          label={open ? 'Hide stats' : 'Show stats'}
          onPress={() => update($, isOpen, value => !value)}
        />
      </Box>
    )

    if (!open) {
      return (
        <Box position="relative" flexDirection="row" borderStyle="round" paddingX={1} paddingRight={14}>
          <Text>
            Session 5h {pct(now.session)} · Weekly {pct(now.week)} · Last message cost{' '}
            {last?.usd == null ? 'n/a' : money(last.usd)}
          </Text>
          {toggle}
        </Box>
      )
    }

    const sessionShare = spentSince(now.session, now.sessionStart)
    const perDay = weeklyPerDay(now.week, now.weekResetsAt, nowMs)

    const sessionRows: [string, string][] = [
      ['Session 5h', pct(now.session)],
      ['Weekly', pct(now.week)],
      ['Spent this session', now.usd === null ? 'n/a' : money(now.usd)],
      ['Spent % of 5h session', pct(sessionShare)],
      ['Weekly left per day', perDay === null ? 'n/a' : `${perDay.toFixed(1)}%`],
    ]
    const lastRows: [string, string][] = last
      ? [
          ['Cost', last.usd === null ? 'n/a' : money(last.usd)],
          ['Cache read', last.tokens ? count(last.tokens.cacheRead) : 'n/a'],
          ['Cache write', last.tokens ? count(last.tokens.cacheWrite) : 'n/a'],
          ['In', last.tokens ? count(last.tokens.input) : 'n/a'],
          ['Out', last.tokens ? count(last.tokens.output) : 'n/a'],
        ]
      : []
    const height = Math.max(sessionRows.length, lastRows.length)
    const half = LABEL_WIDTH + VALUE_WIDTH

    return (
      <Box position="relative" flexDirection="column" borderStyle="round" paddingX={1}>
        <Box flexDirection="row">
          <Box width={half}>
            <Text bold>Session</Text>
          </Box>
          <Box width={GAP_WIDTH} />
          <Box width={half}>
            <Text bold>{last ? `Last message (${last.model})` : 'Last message'}</Text>
          </Box>
        </Box>
        {Array.from({ length: height }, (_, i) => {
          const left = sessionRows[i]
          const right = lastRows[i]

          return (
            <Box key={`row-${i}`} flexDirection="row">
              <Box width={LABEL_WIDTH}>
                <Text>{left ? left[0] : ''}</Text>
              </Box>
              <Box width={VALUE_WIDTH} justifyContent="flex-end">
                <Text>{left ? left[1] : ''}</Text>
              </Box>
              <Box width={GAP_WIDTH} />
              <Box width={LABEL_WIDTH}>
                <Text>{right ? right[0] : ''}</Text>
              </Box>
              <Box width={VALUE_WIDTH} justifyContent="flex-end">
                <Text>{right ? right[1] : ''}</Text>
              </Box>
            </Box>
          )
        })}
        {toggle}
      </Box>
    )
  })
}

