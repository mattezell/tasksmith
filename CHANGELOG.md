# Changelog

All notable changes to TaskSmith will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.3] - 2026-02-21

### Fixed
- **Auto-commit before merge** — the worktree finalize step now auto-commits any uncommitted changes Claude left behind (common in yolo/autonomous mode), then checks for commits ahead of the base branch using `git rev-list --count`. Previously, if Claude committed its own work, `git status --porcelain` showed clean and finalize bailed out with "nothing to merge" — the committed work was never merged. If Claude didn't commit, the auto-commit ran but its result was never checked (could fail silently). Both cases are now handled correctly.
- **Worktree reuse on restart** — when a task is resubmitted after a crash/restart, worktree creation no longer fails with "branch already exists". The `WorktreeManager.create()` method now handles three scenarios: (1) existing worktree directory — reuse as-is, preserving any commits from before the interruption; (2) existing branch with no worktree (orphaned) — attach a new worktree to the existing branch; (3) neither exists — create fresh (previous behavior). Runs `git worktree prune` before creation to clean stale metadata.

### Changed
- `pool.ts` — `WorktreeManager.create()` refactored with three-case branch/worktree detection. `finalize()` uses `git rev-list --count` instead of `git status --porcelain` to determine if there's work to merge. Auto-commit result is now checked and logged on failure. All log messages include task ID for traceability.

## [0.8.2] - 2026-02-20

### Added
- **Claude Code output visibility** — per-iteration summary logging (turns, cost, duration) extracted from Claude's `--output-format json` response. Full JSON output saved to `~/.tasksmith/logs/{task-id}/iteration-{n}.json` when `system.logLevel: DEBUG`.
- **`CCJsonResult` interface** — typed parsing of Claude Code's JSON output (`result`, `duration_ms`, `num_turns`, `total_cost_usd`, `session_id`, `is_error`).
- **`local` worktree strategy** — purely local isolation with no push, no merge, no cleanup. Worktree and branch stay on disk for manual review. Useful for reviewing AI changes before committing to anything.
- **Rate limit detection with auto-pause** — detects "hit your limit" in Claude Code's response, parses the reset time (with timezone support), sleeps until reset + 60s buffer, then retries the same iteration. Falls back to 15-minute pause if time can't be parsed. Capped at 12 hours max sleep.
- **Project-aware worktrees** — `WorktreeManager.create()` resolves project symlinks (e.g., `~/.tasksmith/projects/my-api` → `/home/user/code/my-api`) via `realpathSync` so worktrees are created in the correct git repository, not the TaskSmith workspace.

### Fixed
- **Duplicate task creation on WSL2** — three-part fix:
  - `FileDropProvider` dedup map with 2-second window to handle WSL2 inotify double-fire
  - `ignoreInitial: true` on chokidar to avoid race with `scanInbox` at startup
  - `cleanupSourceFile()` removes original file_drop source after `handleInbound` writes a normalized copy
- **Concurrent execution blocked by `spawnSync`** — replaced `spawnSync` with async `spawn` in `invokeCC()`. The synchronous call was freezing the entire Node.js event loop, preventing the scan interval, file watchers, and pool dequeuing from running during Claude Code execution. True parallel task execution now works.
- **Infinite watcher loop in `handleInbound`** — `handleInbound` was writing normalized task files back to `inbox/`, triggering the file watcher, which called `handleInbound` again. Fixed by writing directly to `active/` and calling `pool.submit()`, completely bypassing the inbox.
- **Nested session detection** — Claude Code refused to launch because the `CLAUDECODE` environment variable was inherited from the parent process. Fixed by setting `CLAUDECODE: undefined` in the spawn environment.
- **Worktrees silently disabled** — `isGitRepo()` was checking `~/.tasksmith` (not a git repo) instead of the actual project directory. Refactored to take a `cwd` parameter and run the safety check per-project during `WorktreeManager.create()`.

### Changed
- `engine.ts` — `invokeCC()` is now fully async using `child_process.spawn` with promise-based stdout/stderr collection. Added `logCCOutput()` for per-iteration visibility and `detectRateLimit()` for pause-and-resume behavior.
- `pool.ts` — `WorktreeManager` refactored: `isGitRepo(cwd)` takes a path param, `create(task, projectPath)` takes resolved project path, `WorktreeInfo` gains `repoPath` field. Added `resolveProjectPath()` on `WorkerPool` that follows symlinks via `realpathSync`. Pool constructor no longer gates on `isGitRepo` upfront.
- `coordinator.ts` — new `submitTask()` method writes directly to `active/` and calls `pool.submit()`. `handleInbound()` uses `submitTask()` instead of writing to inbox. New `cleanupSourceFile()` method.
- `providers/comms/providers.ts` — `FileDropProvider` gains `recentlyProcessed` dedup map and `DEDUP_WINDOW_MS` constant. Accepts `.json` file extension.
- Version bumped to 0.8.2.

## [0.8.1] - 2026-02-19

### Added
- **Sandbox plugin** (`sandbox`) — OS-level process isolation for Claude Code invocations via `@anthropic-ai/sandbox-runtime`. Uses bubblewrap on Linux/WSL2 and Seatbelt on macOS. No Docker required.
  - Filesystem isolation: blocks reads to `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.gnupg`, `~/.netrc`; blocks writes to `.env`, `.env.*`, shell config files
  - Network isolation: domain allowlist enforced at the OS level, blocks arbitrary outbound connections including under prompt injection
  - Per-task opt-in via `params.sandbox: true`; global default via `enabled: true` in plugin config
  - Per-task domain extensions via `params.sandbox_domains`
  - Escape hatch lockdown: `allowUnsandboxedCommands: false` eliminates Claude Code's `dangerouslyDisableSandbox` bypass
  - Violation logging to task output
  - Per-task settings files scoped to task ID — parallel workers with different configs don't collide
  - Programmatic `SandboxManager` API with `npx srt` CLI fallback (no package install required)
  - Graceful skip with warning on unsupported platforms (native Windows)
- **`addCommandWrapper` plugin hook** — new method on `PluginContext`. Plugins register command wrapper functions called by the engine before spawning Claude Code. Wrappers compose left-to-right. Non-breaking: existing plugins unaffected.
- **`PluginManager.applyCommandWrappers()`** — runs a command string through all registered wrappers. Engine calls this before every Claude Code invocation.
- **`CommandWrapperHook` type** — exported from `plugins.ts`.
- **Onboarding wizard: Sandbox step** — new step 9 (of 10) in `tasksmith setup`. Explains security model, prompts for opt-in vs. all-tasks default, escape hatch lockdown, and optional `@anthropic-ai/sandbox-runtime` install. Platform-aware: warns on Linux re: bubblewrap, warns on Windows re: WSL2.
- **`SandboxConfig` interface** in `types.ts` — fully typed + JSDoc'd. Documents all config keys and per-task params (`sandbox`, `sandbox_domains`).
- **README: Sandbox Isolation section** — comprehensive docs including default blocks, config, per-task overrides, escape hatch, and Docker comparison.

### Changed
- `engine.ts` — `invokeCC()` is now `async`. Claude Code invocation routes through `pluginManager.applyCommandWrappers()` before spawning. Uses `shell: true` on `spawnSync` to support wrapped commands. Backwards-compatible when no wrappers are registered.
- `engine.ts` — new `pluginManager` property (injected by coordinator after plugin activation).
- `plugins.ts` — `PluginContext` gains `addCommandWrapper()` method. `PluginManager` gains `getCommandWrappers()` and `applyCommandWrappers()`. `Task` added to imports.
- `src/plugins/bundled/index.ts` — `sandbox` added to lazy-load registry and `BUNDLED_PLUGIN_INFO` (9th bundled plugin).
- `coordinator.ts` — injects `pluginManager` into engine for command wrapper support.
- `onboarding.ts` — step counters updated 9→10, sandbox step inserted after engine step, step map gains `sandbox` key, security notice includes sandbox guidance.
- Plugin count updated across README and site (8→9).
- Version bumped to 0.8.1.

### Security
- Prompt injection attacks that attempt data exfiltration are now containable at the OS level when the sandbox plugin is active.
- SSH keys, AWS credentials, and cloud provider credentials blocked at filesystem read level by default.
- `.env` files and shell configuration files blocked at write level by default.
- Escape hatch (`dangerouslyDisableSandbox`) locked by default — Claude Code cannot self-authorize sandbox bypass.
- Permission modes (0.8.0) and sandbox (0.8.1) are complementary: permission modes control Claude Code's tool access, sandbox controls OS-level process boundaries.

### Notes
- Sandbox plugin is opt-in by default. Existing installations are unaffected until the plugin is added to config.
- `@anthropic-ai/sandbox-runtime` is optional. TaskSmith falls back to `npx srt` when not installed.
- Platform support: macOS, Linux, WSL2. Native Windows support planned upstream.
- Docker plugin remains for heavier isolation (custom base environments, resource limits). Sandbox and Docker are complementary.

## [0.8.0] - 2026-02-18

### Added
- **Permission modes** — three-tier autonomy control for Claude Code invocation:
  - `supervised` (default) — legacy behavior, uses `--allowedTools` from provider config. Tasks may stall on permission prompts in headless mode.
  - `autonomous` — passes `--permission-mode acceptEdits` with scoped `--allowedTools` and `--disallowedTools`. Full file read/write without prompts; bash scoped to explicitly allowed commands.
  - `yolo` — passes `--dangerously-skip-permissions`. Full autonomy with no guardrails. Prominent startup warning displayed.
- **`engine` config block** — new top-level config section:
  - `engine.permissionMode` — set default permission mode (`supervised`, `autonomous`, `yolo`)
  - `engine.permissions.allow` — list of `--allowedTools` rules for `autonomous` mode (e.g., `Bash(npm *)`, `Edit`, `Read`)
  - `engine.permissions.deny` — list of `--disallowedTools` rules applied in both `autonomous` and `yolo` modes (e.g., `Bash(rm -rf *)`, `Bash(sudo *)`)
  - `engine.concurrency` and `engine.worktree` moved here from ad-hoc config (backward compatible)
- **`tasksmith run --mode <mode>`** — CLI flag to override the configured permission mode for a session
- **Task-level permission overrides** — tasks can set `params.permission_mode`, `params.allowed_tools`, and `params.disallowed_tools` to override engine defaults per-task
- **Auto-allow validation commands** — in `autonomous` mode, if a task has a `validation_command`, the base command is automatically added to the allow list
- **Permission mode in startup banner** — shows 🟢 supervised, 🟡 autonomous, or 🔴 YOLO with mode description
- **YOLO mode startup warning** — red warning banner when running in yolo mode, recommends isolated environments
- **`PermissionMode` type** — exported from types.ts for plugin authors
- **`EngineConfig` and `PermissionsConfig` interfaces** — typed engine configuration
- **Sensible default allow/deny lists** — ships with curated defaults for `autonomous` mode covering common dev tools (npm, git, python, cargo, go, make, tsc, file operations) while denying destructive commands (rm -rf, sudo, curl, wget) and sensitive file reads (.env, secrets/)
- **Onboarding wizard: Engine & Permissions step** — new step 8 (of 9) in `tasksmith setup` lets users choose permission mode (supervised/autonomous/yolo) and configure concurrency interactively
- **Permission mode in `tasksmith status` and `tasksmith info`** — both commands now display the configured permission mode with color-coded output (🟢 green/🟡 yellow/🔴 red)
- **README: Permission Modes section** — comprehensive documentation of all three modes with config examples, task-level overrides, mode resolution order, and important notes about CLI flag behavior

### Changed
- **Engine `invokeCC()`** — rewritten to build Claude Code CLI args based on active permission mode instead of always using `--allowedTools`
- **Coordinator banner** — wider (58 chars) to accommodate mode display; shows permission mode between workspace and inbox lines
- **Engine config** — `concurrency` and `worktree` settings now live under the `engine` block in config (previous locations still work via deep-merge)
- **Onboarding wizard** — now 9 steps (was 8); security notice updated to reference permission modes
- **Security section** — updated with permission mode guidance in mitigations and recommendations
- Version bumped to 0.8.0

## [0.7.2] - 2026-02-18

### Added
- **`--param` CLI flag** — repeatable `--param key=value` option on `tasksmith submit` for passing task params (e.g., `--param validation_command="npm test" --param github_issue=42`). Auto-casts booleans and numbers.
- **Interactive validation prompt** — when submitting interactively with `ralph-loop` or `bug-hunt` templates, CLI now asks for a validation command if one wasn't provided via `--param`
- **JSON inbound parsing** — Coordinator now accepts JSON messages from inbound providers (Discord, REST, etc.) in addition to YAML
- **Natural language param extraction** — chat messages now extract params automatically:
  - Explicit `key="quoted value"` and `key=value` patterns
  - Natural language: "validate with npm test" → `{ validation_command: "npm test" }`
- **Green field project support** — Engine auto-creates the project directory for `project-init` template when it doesn't exist, so new projects can be scaffolded without manual setup
- **Security warning on startup** — Coordinator displays a warning when external-facing inbound providers (`discord_bot`, `rest_api`) are active
- **Security notice in onboarding** — setup wizard now shows security recommendations after completion
- **README: Security section** — documents attack surface (prompt injection, shell execution via params, memory poisoning, no auth), current mitigations, and recommendations
- **README: Passing Parameters** — comprehensive guide to passing params via every input path (CLI, YAML, JSON, REST API, Discord structured, Discord natural language)
- **README: Green Field Projects** — documents `project-init` template usage across CLI, chat, and file drop

### Changed
- Submit confirmation output now displays parsed params
- Discord bot documentation updated to show structured YAML/JSON input and natural language param extraction examples
- REST API examples updated to include params
- Version bumped to 0.7.2

## [0.7.1] - 2026-02-18

### Added
- **Setup config backup** — `tasksmith setup` now creates a timestamped backup of the existing config file (e.g., `tasksmith.yaml.<timestamp>.bak`) before making any changes, preventing accidental loss of previous settings
- **Setup defaults preservation** — re-running `tasksmith setup` now displays previously configured values as defaults for every prompt:
  - SOUL.md settings (communication style, code philosophy, test preference, etc.) parsed from existing file
  - USER.md settings (name, role, languages, GPU) parsed from existing file
  - Outbound providers pre-checked based on currently enabled state
  - Provider credentials (webhook URLs, bot tokens, ntfy topics) shown as defaults
  - Inbound provider toggles (Discord bot, REST API) reflect current config
  - Model routing selections (embedding model, summarize model) reflect current config
- Pressing Enter on any prompt now carries the existing value forward unchanged

## [0.7.0] - 2025-02-18

### Added
- **Parallel task execution** — configurable worker pool with `engine.concurrency` setting. Tasks are priority-queued (urgent → high → normal → low) and executed concurrently up to the concurrency limit.
- **Git worktree isolation** — each parallel task can run in its own `git worktree` branch, preventing clobbering between concurrent tasks. Three strategies:
  - `pr` (default) — commits, pushes, opens a GitHub PR via `gh` CLI on success
  - `auto-merge` — merges directly into base branch (falls back to PR on conflicts)
  - `branch-only` — commits and pushes the branch for manual handling
- **Worktree cleanup** — failed tasks discard their worktree automatically. No damage to main.
- **Task-level worktree overrides** — `params.worktree: false`, `params.worktree_strategy`, `params.worktree_branch`
- **`tasksmith workers`** CLI command — shows pool config, worktree settings, active worktrees, git/gh availability
- **Multi-provider embeddings** — semantic-memory plugin now supports Ollama (local), OpenAI (`text-embedding-3-small`), and Gemini (`text-embedding-004`) as embedding backends. Configured via `provider` field. API keys from config or environment variables.
- **Engine.pickupAll()** — new method for batch inbox scanning used by worker pool

### Changed
- **Coordinator** uses worker pool instead of sequential scan loop. All task execution now goes through the pool (backwards-compatible at `concurrency: 1`).
- **Engine.execute()** accepts optional `cwdOverride` parameter for worktree-isolated execution
- **Engine.invokeCC()** and **validate()** respect `cwdOverride` (worktree path takes priority over project dir)
- Semantic memory config: `model` renamed to `ollamaModel`, new fields for `openaiApiKey`, `openaiModel`, `geminiApiKey`, `geminiModel`
- Embedding store tags records with `provider:model` identifier; detects model changes and warns about rebuild

### Architecture
- New `src/pool.ts` (484 lines) — `WorkerPool` class and `WorktreeManager` class
- Core: 4,194 lines | Plugins: 2,582 lines | Total: 6,776 lines

## [0.6.0] - 2025-02-18

### Added
- **Scheduled tasks** — cron-based task scheduling with standard 5-field cron syntax (minute hour day-of-month month day-of-week). Supports wildcards, ranges, steps, lists. Creates task files in inbox on schedule.
  - Human-readable schedule descriptions ("daily at 02:00", "every 6 hours", "Mon at 09:00")
  - Checks every 30 seconds, fires once per minute
  - Graceful startup/shutdown
- **`tasksmith schedule`** CLI command — shows all configured schedules with human-readable descriptions, templates, and enabled status
- **Semantic memory plugin** — vector-based semantic search across task history and memory entries via local Ollama embeddings
  - `tasksmith semantic --query "authentication refactoring"` returns conceptually related entries ranked by cosine similarity
  - `tasksmith semantic --stats` shows embedding count, model, store file, Ollama status
  - Persists embeddings to disk (JSON) for fast startup
  - Falls back gracefully if Ollama unavailable
  - Hooks: embeds memory entries on flush, embeds task summaries after execution
- **`npm run stats`** — automated stats script (`scripts/update-stats.mjs`) counts core vs plugin lines, picks marketing bucket, updates site/index.html and README.md numbers sections automatically
- **Marketing bucket: "under 5,000 lines"** — replaced "under 3,000" to provide headroom for growth while staying honest. Framing: "every module fits in your head."

### Changed
- Coordinator starts scheduler after inbox scanner if schedules are configured in `tasksmith.yaml`
- Scheduler stops gracefully on shutdown
- Version bumped from 0.5.3 to 0.6.0

### Architecture
- New `src/scheduler.ts` (237 lines) — lightweight cron parser and scheduler with zero dependencies
- New `src/plugins/bundled/semantic-memory.ts` (329 lines at initial release)
- Core: 3,592 lines | Plugins: 2,460 lines (8 plugins) | Total: 6,052 lines

## [0.5.3] - 2025-02-18

### Added
- **Cloudflare plugin** — Cloudflare Pages deployment automation (487 lines)
  - `tasksmith cf deploy` — deploys to Cloudflare Pages via `wrangler pages deploy`
  - `tasksmith cf status` — API token validity, project info, latest deployment
  - `tasksmith cf deployments` — lists last 10 deployments with timestamps
  - `tasksmith cf rollback --deployment-id <id>` — rollback via Cloudflare API
  - Auto-deploy on task success (configurable with pattern matching)
  - Optional CDN cache purge after deploy
  - Task-level overrides: `params.cf_deploy`, `cf_deploy_dir`, `cf_branch`

### Changed
- Bundled plugin count: 7 → 8 (added cloudflare)
- Bundled plugin registry updated with lazy-loaded cloudflare import

## [0.5.2] - 2025-02-17

### Fixed
- **Clean shutdown** — process exits cleanly instead of hanging on Ctrl+C
- **Force exit on hang** — safety timeout ensures process terminates even if providers stall
- **Hardcoded version removed** — version now read dynamically instead of hardcoded in banner
- **Startup banner formatting** — dynamic box width, cleaner layout

### Changed
- Various formatting and display improvements throughout CLI output

## [0.5.1] - 2025-02-17

### Fixed
- Minor formatting fixes and cleanup from v0.5.0 release

## [0.5.0] - 2025-02-17

### Added
- **Official bundled plugins** — ship with tasksmith-cli, no separate npm install needed
  - **github** — GitHub Issues/PR integration: auto-create issues on task failure, comment results on linked issues, close issues on task success. Uses GitHub REST API with `GITHUB_TOKEN` env var or config.
  - **metrics** — Task execution metrics: tracks success rates, iteration counts, duration, model/template/project breakdowns. Writes to `metrics.json`. Includes `tasksmith metrics` CLI command with colored output.
  - **docker** — Docker container isolation: run tasks in sandboxed containers with resource limits, project directory mounting, automatic cleanup on completion/shutdown. Supports per-task image overrides. Includes `tasksmith docker` CLI command for status.
  - **jira** — JIRA ticket integration: auto-create tickets on task failure, comment results on linked tickets, transition tickets to "Done" on success. Uses Atlassian REST API v3 with API token auth.
  - **postgres** — PostgreSQL task history: stores every task execution with full metadata, auto-creates tables, queryable via SQL. Includes `tasksmith pg` CLI command for viewing history. Peer dependency on `pg` package.
  - **proxmox** — Proxmox VE integration: clone VMs from templates, start/stop on task lifecycle, snapshot before execution, rollback on failure, auto-cleanup. Includes `tasksmith proxmox` CLI command. Great for full OS-level isolation.
- **Bundled plugin registry** — `src/plugins/bundled/index.ts` with lazy-loaded imports for zero startup cost
- **`tasksmith plugin list`** now shows official bundled plugins with enabled/disabled status alongside npm-discovered community plugins
- **Plugin loading priority** — bundled plugins resolve first, then npm packages, then local paths
- **`@tasksmith-dev` npm scope** secured for future scoped package publishing

### Changed
- Plugin system `loadFromConfig()` now checks bundled registry before npm resolution
- `tasksmith plugin list` redesigned with enabled/disabled indicators and inline descriptions
- Updated plugins README to accurately reflect what ships vs what's planned

## [0.4.0] - 2025-02-17

### Added
- **Workspace overrides** — `workspace.projectsDir` to point projects anywhere, not just `~/.tasksmith/projects/`
- **Project-local mode** — `tasksmith init` creates `.tasksmith/` in current project with local config, templates, and task queue
- **Config layering** — defaults → global `~/.tasksmith` → project-local `.tasksmith/`, each layer merges and overrides
- **Auto-detection** — `cd` into a project with `.tasksmith/` or `tasksmith.yaml` and the workspace resolves automatically
- **Template resolution chain** — 5-level priority: project-local → workspace → custom dir → global → built-in
- **JSON task files** — drop `.json` alongside `.yaml` in inbox, both processed identically
- **JSON config support** — `tasksmith.json` accepted anywhere `tasksmith.yaml` is
- **`tasksmith init`** — initialize project-local TaskSmith config
- **`tasksmith templates`** — list all templates with source labels and paths
- **`tasksmith info`** — show workspace resolution order, config paths, template search paths
- **Real-world examples** — 6 task files (auth validation, refactor, doc gen, bug hunt, code review, JSON)
- **Project setup guide** — comprehensive walkthrough of adding TaskSmith to an existing project
- **Template repository scaffold** — community template collection with 3 new templates (api_scaffold, test_writer, security_audit)
- **Plugin repository scaffold** — curated plugin directory with creation guide

### Changed
- `resolveWorkspace()` now walks up directory tree looking for `.tasksmith/` or `tasksmith.yaml`
- `status` command now shows workspace mode, path, and projects directory
- Task inbox scanner now accepts `.json` files
- Template loading uses centralized `resolveTemplate()` instead of hardcoded paths
- Version bumped to 0.4.0

## [0.3.1] - 2025-02-17

### Changed
- **Renamed from ClaudeForge to TaskSmith** — new domain, new npm package, new identity
- Package name: `tasksmith-cli` (binary: `tasksmith`, alias: `forge`)
- Domain: tasksmith.dev
- All source files, templates, docs, and config references updated
- Plugin convention: `tasksmith-plugin-*`
- Config file: `tasksmith.yaml`

### Added
- Landing page with retro BBS/CRT aesthetic
- Favicon set (ICO, PNG, Apple Touch Icon)
- Social preview image and Open Graph meta tags
- Branding kit (avatars, banners for Discord/GitHub/Twitter)

## [0.3.0] - 2025-02-17

### Added
- **Plugin system** — npm-based discovery, `tasksmith-plugin-*` convention
- `PluginManager` class with lifecycle hooks (beforeTaskExecute, afterTaskExecute, onTaskFail, onValidationFail, onMemoryStore, onStartup, onShutdown)
- `tasksmith plugin list` — discover installed plugins
- `tasksmith plugin create <name>` — scaffold a publishable plugin
- Plugins can register outbound/inbound providers, templates, and hooks

## [0.2.0] - 2025-02-17

### Added
- **Task Engine** — inbox watcher, compiled prompt assembly, Claude Code CLI invocation
- **Ralph Loop** — run → validate → feed errors back → retry until tests pass
- **Three-tier memory** — hot (MEMORY.md), warm (JSONL searchable logs), cold (compressed archives)
- **10 notification providers** — Discord webhook, Slack, ntfy.sh, email (SMTP), SMS (Twilio), Pushover, IFTTT, generic webhook, Matrix, Gotify
- **4 inbound providers** — file drop, Discord bot, REST API, watched folder
- **Coordinator** — orchestrates engine, memory, notifications, inbound commands
- **7 built-in templates** — ralph-loop, bug-hunt, code-review, doc-gen, heartbeat, project-init, research
- **Onboarding wizard** — `tasksmith setup` with 5-step guided configuration
- **CLI commands** — run, submit, status, doctor, memory, setup
- **Session archiver** — compress and archive completed task sessions
- Prompt compilation with SOUL.md, USER.md, CONVENTIONS.md, MEMORY.md, CLAUDE.md

## [0.1.0] - 2025-02-17

### Added
- Initial project structure and TypeScript configuration
- Core type system and provider interfaces
- Configuration management with YAML and deep merge
- Workspace scaffolding

[0.8.2]: https://github.com/mattezell/tasksmith/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/mattezell/tasksmith/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/mattezell/tasksmith/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/mattezell/tasksmith/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/mattezell/tasksmith/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/mattezell/tasksmith/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mattezell/tasksmith/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/mattezell/tasksmith/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/mattezell/tasksmith/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/mattezell/tasksmith/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/mattezell/tasksmith/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mattezell/tasksmith/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/mattezell/tasksmith/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/mattezell/tasksmith/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mattezell/tasksmith/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mattezell/tasksmith/releases/tag/v0.1.0