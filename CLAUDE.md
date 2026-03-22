# TaskSmith — Claude Code Context

This file is loaded automatically by Claude Code when working in the TaskSmith repo.

## What This Is

TaskSmith is the unattended ops layer for Claude Code. Submit work from anywhere (Discord, REST, file drop, MCP, CI/CD). TaskSmith queues it, spawns Claude Code headless sessions with the right context, validates output against your test suite, retries intelligently when things fail, learns from outcomes, notifies you when it's done, and opens a PR. No terminal babysitting required.

npm package: `tasksmith-cli`. MIT licensed.

## Architecture at a Glance

```
Inputs (file drop, Discord, Slack, GitHub webhooks, REST, MCP, cron) → Coordinator → Worker Pool → Engine
Engine: compile prompt → invoke Claude Code CLI headless → validate → retry (Ralph Loop) → notify
Memory: hot (MEMORY.md) → warm (JSONL) → cold (gzipped archives)
```

## Repo Layout

```
src/
├── engine.ts          ~1,400 lines  Task lifecycle, Ralph Loop, circuit breaker, smart routing, JSONL task log
├── mcp.ts             ~700 lines    MCP server (13 tools, 4+ resource types)
├── cli.ts             ~1,535 lines  Commander CLI (submit, dag, metrics, insights, costs, workers, etc.)
├── plugins.ts         ~566 lines    Plugin loader, lifecycle hooks
├── coordinator.ts     ~765 lines    Wires providers + engine + pool + plugins + DAG
├── dag.ts             ~450 lines    Task DAG — dependency workflows, cycle detection, Mermaid export
├── sanitize.ts        ~375 lines    Input sanitization, trust levels, allowlists
├── config.ts          ~360 lines    Workspace resolution, config layering, skill installation
├── api.ts             ~355 lines    REST API server (Fastify) — auth + rate limiting + approval
├── onboarding.ts      ~251 lines    Simplified setup wizard
├── scheduler.ts       ~247 lines    Cron-based task scheduling (daemon-level, not session-scoped)
├── types.ts           ~218 lines    Interfaces, provider contracts
├── pool.ts            ~139 lines    Worker pool, concurrency limiter
├── index.ts           ~13 lines     Package exports
├── providers/
│   ├── comms/         ~790 lines    5 outbound + 7 inbound providers
│   └── memory/        ~241 lines    Three-tier memory (hot/warm/cold)
├── plugins/bundled/               8 official plugins (~2,800 lines total)
└── __tests__/                     Vitest tests
.claude/skills/                    Bundled Claude Code skills (ralph-loop, bug-hunt, etc.)
                                   Each skill: <name>/SKILL.md — installed to ~/.tasksmith/.claude/skills/
```

## Build & Test

```bash
npm run build          # tsc — must compile clean
npm test               # vitest run
npm run dev            # tsc --watch
```

## Key Conventions

- **TypeScript strict mode.** No `any` unless interfacing with external APIs.
- **Provider interface pattern** — every capability (comms, memory, plugins, embeddings) implements an interface. Adding a new provider requires zero engine changes.
- **Filesystem queue** — tasks are YAML/JSON files moving through `inbox/ → active/ → completed/ | failed/`. No database dependency.
- **Plugin = function** — a plugin is a single function receiving a context object. No class hierarchies.
- **Lazy loading** — bundled plugins import on-demand via dynamic `import()`. Disabled plugins add zero startup cost.
- **Config layering** — `defaults → global (~/.tasksmith) → project-local (.tasksmith/) → task-level params`. Deep merge at each layer.
- **Leverage Claude Code native** — permissions, sandboxing, and skills are delegated to Claude Code CLI's native capabilities. TaskSmith doesn't reimplement what CC does natively.
- **Three-layer skills** — bundled skills installed to `~/.tasksmith/.claude/skills/`, project skills in `<project>/.tasksmith/.claude/skills/`, plus CC's native `.claude/skills/` discovery from cwd. Engine passes `--add-dir` to CC with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.

## When Making Changes

1. `npm run build` must pass (clean tsc compile).
2. `npm test` must pass.
3. Update CHANGELOG.md with the change.
4. Update README.md if the change affects user-facing behavior, CLI commands, or config.

## Current Version

v1.0.1 — audit fixes, CC integration (`cc-install`), cost dashboard (`costs`), skill injection, budget alerts, dogfood batch fixes. See CHANGELOG.md for full details.

## Known Debt

- Context window risk — no truncation strategy if compiled prompts exceed model limits.
- No test suite beyond circuit breaker unit tests.
