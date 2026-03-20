# TaskSmith — Claude Code Context

This file is loaded automatically by Claude Code when working in the TaskSmith repo.

## What This Is

TaskSmith is the unattended ops layer for Claude Code. Submit work from anywhere (Discord, REST, file drop, MCP, CI/CD). TaskSmith queues it, spawns Claude Code headless sessions with the right context, validates output against your test suite, retries intelligently when things fail, learns from outcomes, notifies you when it's done, and opens a PR. No terminal babysitting required.

npm package: `tasksmith-cli`. MIT licensed.

## Architecture at a Glance

```
Inputs (file drop, Discord, REST, MCP, cron) → Coordinator → Worker Pool → Engine
Engine: compile prompt → invoke Claude Code CLI headless → validate → retry (Ralph Loop) → notify
Memory: hot (MEMORY.md) → warm (JSONL) → cold (gzipped archives)
```

## Repo Layout

```
src/
├── engine.ts          ~1,008 lines  Task lifecycle, Ralph Loop, circuit breaker, smart routing
├── mcp.ts             ~700 lines    MCP server (13 tools, 5 resources)
├── cli.ts             ~572 lines    Commander CLI
├── plugins.ts         ~566 lines    Plugin loader, lifecycle hooks
├── coordinator.ts     ~537 lines    Wires providers + engine + pool + plugins
├── dag.ts             ~417 lines    Task DAG — dependency workflows, cycle detection
├── sanitize.ts        ~375 lines    Input sanitization, trust levels, allowlists
├── config.ts          ~324 lines    Workspace resolution, config layering
├── onboarding.ts      ~251 lines    Simplified setup wizard
├── scheduler.ts       ~237 lines    Cron-based task scheduling (daemon-level, not session-scoped)
├── types.ts           ~203 lines    Interfaces, provider contracts
├── api.ts             ~186 lines    REST API server (Fastify)
├── pool.ts            ~138 lines    Worker pool, concurrency limiter
├── index.ts           ~13 lines     Package exports
├── providers/
│   ├── comms/         ~409 lines    6 outbound + 4 inbound providers
│   └── memory/        ~241 lines    Three-tier memory (hot/warm/cold)
├── plugins/bundled/               8 official plugins (~2,573 lines total)
└── __tests__/                     Vitest tests
.claude/skills/                    Claude Code skills (ralph-loop, bug-hunt, etc.)
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
- **Leverage Claude Code native** — worktrees, permissions, sandboxing, and skills are delegated to Claude Code CLI's native capabilities. TaskSmith doesn't reimplement what CC does natively.

## When Making Changes

1. `npm run build` must pass (clean tsc compile).
2. `npm test` must pass.
3. Update CHANGELOG.md with the change.
4. Update README.md if the change affects user-facing behavior, CLI commands, or config.

## Current Version

v1.0.0 — the "unattended ops" pivot. Stripped reimplemented CC features (worktree management, permission wrappers, sandbox plugin, template system). Migrated templates to Claude Code Skills format. Strengthened core differentiators: fire-and-forget task queue, Ralph Loop + circuit breaker, cross-task memory, multi-channel I/O, smart model routing, DAGs, MCP server, cron scheduler.

## Known Debt

- REST API has no auth. Discord bot accepts commands from anyone in the configured channel.
- Context window risk — no truncation strategy if compiled prompts exceed model limits.
- No test suite beyond circuit breaker unit tests.
