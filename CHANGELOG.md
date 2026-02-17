# Changelog

All notable changes to TaskSmith will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2025-02-17

### Added
- **Official bundled plugins** — ship with tasksmith-cli, no separate npm install needed
  - **github** — GitHub Issues/PR integration: auto-create issues on task failure, comment results on linked issues, close issues on task success. Uses GitHub REST API with `GITHUB_TOKEN` env var or config.
  - **metrics** — Task execution metrics: tracks success rates, iteration counts, duration, model/template/project breakdowns. Writes to `metrics.json`. Includes `tasksmith metrics` CLI command with colored output.
  - **docker** — Docker container isolation: run tasks in sandboxed containers with resource limits, project directory mounting, automatic cleanup on completion/shutdown. Supports per-task image overrides. Includes `tasksmith docker` CLI command for status.
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

[0.5.0]: https://github.com/mattezell/tasksmith/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mattezell/tasksmith/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/mattezell/tasksmith/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/mattezell/tasksmith/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mattezell/tasksmith/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mattezell/tasksmith/releases/tag/v0.1.0
