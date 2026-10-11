---
name: model-routing
description: Set up, check or explain token-efficient model routing in Claude Code (Opus plans, Haiku searches, Sonnet implements). Use when the user asks about model choice, opusplan, subagent models, the Explore agent, delegating searches, or reducing token cost or spend.
---

# Model routing

Policy: **Opus plans, Haiku explores, Sonnet implements.** Facts below come from
the Claude Code docs (sub-agents, model-config); re-check anything version-sensitive.

## How each role is routed

| Role | Mechanism |
| --- | --- |
| Plan (Opus) → implement (Sonnet) | `opusplan` model alias: Opus in plan mode, Sonnet when executing. Same conversation, so Sonnet keeps full context. Set with `/model opusplan`, or `"model": "opusplan"` in settings. |
| Search (Haiku) | Built-in `Explore` runs on the main model (Opus on an Opus session), so it is **not** Haiku by default. Override it with a user or project subagent named `Explore` that sets `model: haiku`. Template: [Explore.md](Explore.md). |

Plugin agents are namespaced (`model-routing:explore-haiku`) and rank lowest in
priority, so they do not replace the built-in `Explore`. This plugin's
`explore-haiku` agent is an extra Haiku searcher; for the real override, copy
`Explore.md` to `~/.claude/agents/Explore.md` (all projects) or
`.claude/agents/Explore.md` (one project). A new agents directory needs a restart.

## Subagent model resolution (first match wins)

1. Per-invocation `model` parameter
2. Subagent frontmatter `model` (`inherit` = main model)
3. `CLAUDE_CODE_SUBAGENT_MODEL` env var
4. Main conversation's model

## When to delegate to Explore

- Broad or multi-file search ("find every place we parse config files"): **delegate**.
- Known single file or a one-symbol lookup: **read or grep directly**.

## When not to spawn subagents

Small targeted edits, tasks needing back-and-forth, phases that share a lot of
context, latency-sensitive work. Each subagent starts cold and spends its own
tokens. They pay off for verbose, self-contained work that returns a summary
(searches, test runs, log processing).

## Setup checklist

1. `claude --version`; need v2.1.293+ for Haiku 5.5 (Sonnet 5.5 v2.1.284+, Opus 5.5 v2.1.280+). `claude update` if older.
2. Look for conflicts in `~/.claude/agents/`, `.claude/agents/`, settings files and env: an existing `Explore`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, `ANTHROPIC_MODEL`.
3. Ask the user: user scope or project scope? Then install `Explore.md` there.
4. Set `opusplan` as the model, and confirm no project/managed setting or `ANTHROPIC_MODEL` overrides it.
5. Only if broad searches still happen in the main thread, add one line to CLAUDE.md: "Use the Explore subagent for any search spanning more than a few files." Keep CLAUDE.md lean, since subagents load it.

## Verify

Fresh session, ask for a broad search. `/tasks` should show the subagent on
Haiku. `/status` shows the main model. In plan mode the main model should be
Opus, and Sonnet after exiting. Report mismatches rather than guessing fixes.

## Warnings

- **Never set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`**: it forces one model onto every subagent and ignores frontmatter `model`, breaking the split.
- Delegation is driven by the subagent `description` ("use proactively" encourages it). Keep descriptions short; combined custom-subagent descriptions over 15,000 tokens trigger a startup warning.
- `omitClaudeMd: true` in a subagent skips CLAUDE.md to save tokens.
- `/model` switches reach subagents that inherit the main model, not ones with an explicit `model`.

## Optional: Opus throughout with a Sonnet implementer

If the user wants Opus as the main model the whole time instead of `opusplan`,
add a subagent `implementer` with `model: sonnet` and a description like
"Implements a defined plan: file edits and refactors. Use proactively once the
plan is settled." The trade-off: it starts with fresh context, so the plan must
be passed in the prompt.
