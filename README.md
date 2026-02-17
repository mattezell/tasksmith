# TaskSmith

Lightweight agent orchestration built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI.

TaskSmith turns Claude Code into a task engine. Drop a YAML file in a folder, and it assembles your project context, coding conventions, and memory into a compiled prompt, invokes Claude Code, validates the output, retries if needed, and notifies you when it's done. Send tasks from Discord, a REST API, or your file system.

## Why TaskSmith?

Claude Code is powerful, but it's a single-shot tool. You give it a prompt, it does work, it's done. TaskSmith adds the orchestration layer:

- **Compiled Prompts** — Your SOUL.md (personality), USER.md (preferences), CONVENTIONS.md, project context, and memory are automatically assembled into every prompt. Claude Code always has full context.
- **Ralph Loop** — Define a validation command. TaskSmith runs Claude Code, checks the output, and if validation fails, feeds the errors back and retries. Iterate until tests pass.
- **Memory** — Three tiers: hot (MEMORY.md loaded every prompt), warm (JSONL logs, searchable), cold (compressed session archives). Claude remembers across tasks.
- **Notifications** — Discord, Slack, ntfy.sh, email, webhooks. Know when tasks finish without watching a terminal.
- **Inbound Commands** — Submit tasks via Discord bot, REST API, file drop, or watched folders.
- **Plugins** — Extend with npm packages. `npm install tasksmith-plugin-whatever`, add one line to config.

## Prerequisites

- **Node.js 18+** (Claude Code users already have this)
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

Optional:
- [Ollama](https://ollama.com/) for local model routing (summarization, embeddings)
- [Discord bot token](https://discord.com/developers/applications) for bidirectional Discord integration

## Install

```bash
npm install -g tasksmith-cli
```

This gives you two commands: `tasksmith` and `forge` (alias).

## Quick Start

```bash
# 1. Interactive setup (creates workspace, SOUL.md, configures notifications)
tasksmith setup

# 2. Start the engine
tasksmith run

# 3. Submit a task (from another terminal)
tasksmith submit -t ralph-loop -p "Add input validation to the /users endpoint" --project my-api
```

Or drop a YAML file directly:

```yaml
# ~/.tasksmith/tasks/inbox/fix-auth.yaml
template: bug-hunt
prompt: "Fix the JWT refresh token race condition"
project: my-api
model: opus
priority: high
params:
  validation_command: "npm test"
```

## CLI Reference

### `tasksmith setup`

Interactive onboarding wizard. Walks through 8 steps:

1. Prerequisites check (Claude Code, Node, git, optional Ollama/Docker)
2. Workspace directory scaffold
3. SOUL.md workshop — define how Claude works for you
4. USER.md profile — name, role, languages, hardware
5. Communication providers — select and configure notifications
6. Model routing — detect local models, configure routing
7. Memory system — initialize baseline memory
8. Smoke test — send test notifications

Re-run any step individually:

```bash
tasksmith setup --step comms
tasksmith setup --step soul
```

### `tasksmith run`

Start the engine. This runs continuously and:

- Watches `tasks/inbox/` for new YAML task files
- Starts all configured inbound listeners (Discord bot, REST API, etc.)
- Processes tasks sequentially through the full lifecycle
- Sends notifications on completion/failure

### `tasksmith submit`

Submit a task to the engine.

```bash
# Interactive mode
tasksmith submit

# Direct submission
tasksmith submit -t ralph-loop -p "Refactor the auth module" --project my-api --model opus

# From a YAML file
tasksmith submit -f path/to/task.yaml
```

Options:
- `-t, --template <name>` — Template name (default: `ralph-loop`)
- `-p, --prompt <text>` — Task prompt
- `--project <name>` — Project name (matches a directory in `projects/`)
- `--model <model>` — Model to use: `opus`, `sonnet` (default: `sonnet`)
- `--priority <level>` — `low`, `normal`, `high`, `urgent` (default: `normal`)
- `--iterations <n>` — Max retry iterations (default: `5`)

### `tasksmith status`

Show task queue counts, infrastructure health (Claude Code, Ollama), active providers, and directive file status.

### `tasksmith doctor`

Diagnose common issues: missing prerequisites, broken workspace, missing directive files.

### `tasksmith memory`

Browse and search the memory system.

```bash
tasksmith memory --hot              # Show hot memory (what Claude sees every prompt)
tasksmith memory --search "auth"    # Search across all memory providers
tasksmith memory --recent 10        # Show 10 most recent entries
```

### `tasksmith plugin`

Manage plugins.

```bash
tasksmith plugin list              # List discovered plugins
tasksmith plugin create proxmox    # Scaffold a new plugin
```

## Templates

Templates are instruction sets that shape how Claude Code approaches a task. Each is a markdown file with `{{prompt}}` and `{{project}}` placeholders.

| Template | Purpose |
|----------|---------|
| `ralph-loop` | Iterate-until-valid. Define a `validation_command` in params; TaskSmith runs it after each attempt and retries on failure. |
| `bug-hunt` | Reproduce, analyze root cause, propose and optionally apply a fix. |
| `code-review` | Review for security, performance, maintainability, convention adherence, test coverage. |
| `research` | Three-phase: broad exploration → deep dives → synthesis into structured markdown. |
| `project-init` | Scaffold a new project with idiomatic structure, tests, CLAUDE.md, and git. |
| `doc-gen` | Generate or update documentation: API reference, setup, architecture, decisions. |
| `heartbeat` | Scheduled tasks: daily briefing, memory consolidation, health checks. |

Custom templates go in `~/.tasksmith/templates/<name>/PROMPT.md`.

## Task YAML Format

```yaml
id: my-task-id              # Optional. Auto-generated if omitted.
template: ralph-loop        # Which template to use
prompt: "Your instructions"  # What to do
project: my-api             # Project directory (in projects/)
model: sonnet               # opus or sonnet
priority: normal            # low, normal, high, urgent
max_iterations: 5           # Max retries for ralph-loop
notify:
  - all                     # Notification targets
params:                     # Template-specific parameters
  validation_command: "npm test"
  cooldown_seconds: 5       # Pause between retries
```

## Workspace Structure

Default location: `~/.tasksmith/` (override with `--dir` or `TASKSMITH_DIR`).

```
~/.tasksmith/
├── config/
│   └── tasksmith.yaml       # Main configuration
├── directives/
│   ├── SOUL.md                 # How Claude behaves
│   ├── USER.md                 # About you
│   ├── MEMORY.md               # Durable facts (auto-updated)
│   ├── CONVENTIONS.md          # Coding standards
│   └── GLOSSARY.md             # Project-specific terms
├── tasks/
│   ├── inbox/                  # Drop YAML files here
│   ├── active/                 # Currently executing
│   ├── completed/              # Finished successfully
│   └── failed/                 # Failed after all retries
├── projects/
│   └── my-api/                 # Each project gets its own dir
│       ├── CLAUDE.md           # Project-level context
│       └── ...                 # Your project files
├── memory/
│   ├── 2025-02-17.md           # Daily markdown logs
│   ├── logs/                   # JSONL structured logs
│   └── sessions/               # Compressed session archives
├── templates/                  # Custom templates
│   └── my-template/
│       └── PROMPT.md
└── output/                     # Task outputs
```

## Compiled Prompt Pattern

Every task prompt is assembled from multiple sources, in order:

1. `SOUL.md` — personality, communication style, coding philosophy
2. `USER.md` — your profile, preferences, hardware
3. `CONVENTIONS.md` — coding standards
4. `GLOSSARY.md` — domain terms
5. **Hot memory** — MEMORY.md + today/yesterday's daily logs
6. **Project context** — the project's CLAUDE.md and TASKS.md
7. **Template prompt** — the template with your prompt injected

Claude Code receives all of this as a single, structured prompt. You never have to repeat context.

## Communication Providers

### Outbound (notifications)

| Provider | Config Key | Description |
|----------|-----------|-------------|
| Discord Webhook | `discord_webhook` | Rich embeds with color-coded priority |
| ntfy.sh | `ntfy` | Push notifications to phone/desktop |
| Slack Webhook | `slack_webhook` | Slack channel messages |
| Email (SMTP) | `email` | Email notifications (requires nodemailer) |
| Generic Webhook | `webhook_generic` | POST JSON to any URL |

### Inbound (receive commands)

| Provider | Config Key | Description |
|----------|-----------|-------------|
| File Drop | `file_drop` | Always on. Watches `tasks/inbox/` for YAML files. |
| Discord Bot | `discord_bot` | `@forge fix the auth bug in my-api` → parsed to task |
| REST API | `rest_api` | Fastify server on port 8420 |
| Watched Folder | `watched_folder` | Watch any directory for YAML task files |

### Natural Language Parsing

The Discord bot and inbound handlers parse natural language into tasks:

```
@forge research best practices for container orchestration
  → template: research, prompt: "best practices for container orchestration"

@forge fix the login timeout bug in my-api
  → template: bug-hunt, project: my-api, prompt: "fix the login timeout bug"

@forge urgent review the payment module with opus
  → template: code-review, priority: urgent, model: opus
```

## REST API

When enabled (`rest_api` provider), the API runs on port 8420.

```bash
# Submit a task
curl -X POST http://localhost:8420/tasks \
  -H "Content-Type: application/json" \
  -d '{"template": "ralph-loop", "prompt": "Add tests", "project": "my-api"}'

# List tasks
curl http://localhost:8420/tasks?status=completed

# Get task details
curl http://localhost:8420/tasks/task-20250217-abc123

# Cancel a task
curl -X DELETE http://localhost:8420/tasks/task-20250217-abc123

# Search memory
curl -X POST http://localhost:8420/memory/search \
  -H "Content-Type: application/json" \
  -d '{"query": "auth", "limit": 5}'

# Health check
curl http://localhost:8420/health

# Full system status
curl http://localhost:8420/status
```

## Memory System

### Three Tiers

- **Hot** — `MEMORY.md` + daily logs. Loaded into every prompt (~2000 tokens). This is what Claude "remembers" by default.
- **Warm** — JSONL structured logs. Always written, searchable via `tasksmith memory --search`. Optional: mem0 semantic search for vector-based retrieval.
- **Cold** — Compressed JSON session archives. Full task history preserved, gzipped.

### How Memory Accumulates

After every task, the engine writes a summary to all memory tiers: what was attempted, whether it succeeded, error details, iteration count. Over time, MEMORY.md accumulates durable facts (consolidation via the `heartbeat` template prunes stale entries).

## Plugins

TaskSmith is extensible via npm packages. No custom plugin infrastructure — npm handles installation, versioning, and distribution.

### Installing a Plugin

```bash
npm install tasksmith-plugin-proxmox
```

Add to `tasksmith.yaml`:

```yaml
plugins:
  - tasksmith-plugin-proxmox                    # zero-config
  - name: tasksmith-plugin-proxmox              # with options
    config:
      host: "https://pve.lan:8006"
      tokenId: "claude@pve!forge"
```

### Creating a Plugin

```bash
tasksmith plugin create my-thing
```

This scaffolds a complete plugin:

```
tasksmith-plugin-my-thing/
├── package.json        # Manifest with "tasksmith" field
├── index.js            # Plugin entry point
├── README.md
└── templates/
    └── my-thing-default/
        └── PROMPT.md
```

### Plugin API

A plugin is a function that receives a context object:

```js
export default function myPlugin(forge, options) {
  // Add providers
  forge.addOutboundProvider(new MyNotifier(options));
  forge.addInboundProvider(new MyListener(options));
  forge.addMemoryProvider(new MyMemoryBackend(options));

  // Add templates
  forge.addTemplate("my-template", "./templates/my-template");

  // Add CLI commands
  forge.addCommand("my-status", {
    description: "Check my-thing status",
    action: async () => { /* ... */ }
  });

  // Hook into task lifecycle
  forge.addHook("beforeTaskExecute", async (data) => {
    forge.log.info(`Task starting: ${data.taskId}`);
  });

  forge.addHook("afterTaskExecute", async (data) => {
    // Post-process, send custom notifications, etc.
  });
}
```

### Plugin Discovery

Plugins are discovered automatically via:

1. Package name prefix: `tasksmith-plugin-*`
2. Keyword in package.json: `"tasksmith-plugin"`
3. Manifest field: `"tasksmith"` key in package.json

### Available Hooks

| Hook | When | Can Transform |
|------|------|--------------|
| `onStartup` | Engine starts | No |
| `onShutdown` | Engine stops | No |
| `beforeContextAssembly` | Before prompt is built | Yes |
| `afterContextAssembly` | After prompt is built | Yes (modify prompt) |
| `beforeTaskExecute` | Before Claude Code runs | Yes |
| `afterTaskExecute` | After task completes | No |
| `onInboundMessage` | Message received | Yes (transform) |
| `onMemoryFlush` | Memory write | Yes |

## Configuration

`~/.tasksmith/config/tasksmith.yaml` controls everything. The setup wizard generates this, but you can edit it directly.

Key sections:

```yaml
# Task defaults
taskDefaults:
  maxIterations: 5
  timeoutMinutes: 30
  model: sonnet
  priority: normal

# Outbound notifications
communication:
  outbound:
    - provider: ntfy
      enabled: true
      config:
        topic: tasksmith
        server: https://ntfy.sh

# Inbound listeners
  inbound:
    - provider: rest_api
      enabled: true
      config:
        port: 8420

# Memory
memory:
  hot:
    provider: markdown
    config:
      loadDays: 2
      maxHotTokens: 2000

# Model routing
models:
  routing:
    complex_code:
      provider: claude_code
      model: opus
    standard_tasks:
      provider: claude_code
      model: sonnet

# Plugins
plugins:
  - tasksmith-plugin-proxmox
```

## Architecture

```
┌──────────────────────────────────────────┐
│              Coordinator                  │
│  Wires providers, engine, API, plugins   │
├──────────┬───────────┬───────────────────┤
│ Inbound  │  Engine   │    Outbound       │
│ file_drop│  parse →  │ discord_webhook   │
│ discord  │  context →│ ntfy              │
│ rest_api │  invoke → │ slack             │
│ watched  │  validate→│ email             │
│          │  retry →  │ webhook           │
│          │  finalize │                   │
├──────────┴───────────┴───────────────────┤
│            Memory Providers              │
│  hot: markdown │ warm: JSONL │ cold: gz  │
├──────────────────────────────────────────┤
│            Plugin Manager                │
│  discover → load → activate → hooks      │
└──────────────────────────────────────────┘
```

**2,900 lines of TypeScript.** No frameworks beyond Fastify for the API server. Provider interfaces are ABCs — adding a new provider requires zero engine changes.

## Building from Source

If you'd rather build and install from source than use the npm registry:

```bash
git clone https://github.com/yourusername/tasksmith.git
cd tasksmith
npm install
npm run build
npm link        # Makes `tasksmith` and `forge` available globally
```

To verify:

```bash
tasksmith --version   # Should print 0.3.1
tasksmith doctor      # Check prerequisites
```

To unlink later: `npm unlink -g tasksmith`

### Development Workflow

```bash
npm run dev             # Watch mode — recompiles on save
npm run build           # One-shot compile
npm test                # Run tests (vitest)
npm start               # Run CLI from dist/ without global install
```

### Project Structure

```
src/
├── types.ts              # 170 lines  Interfaces & provider contracts
├── config.ts             # 135 lines  YAML config, defaults, workspace scaffold
├── engine.ts             # 372 lines  Task lifecycle, Ralph Loop, CC invocation
├── coordinator.ts        # 248 lines  Wires providers + engine, runs concurrently
├── api.ts                # 174 lines  Fastify REST server (port 8420)
├── cli.ts                # 298 lines  Commander CLI entry point
├── onboarding.ts         # 324 lines  8-step interactive setup wizard
├── plugins.ts            # 565 lines  Plugin loader, lifecycle, scaffolding
├── index.ts              #   7 lines  Package exports
└── providers/
    ├── comms/providers.ts  # 366 lines  6 outbound + 4 inbound providers
    └── memory/providers.ts # 241 lines  Markdown, JSONL, session archiver

templates/                  # Built-in task templates (shipped with package)
├── ralph_loop/PROMPT.md
├── bug_hunt/PROMPT.md
├── code_review/PROMPT.md
├── research/PROMPT.md
├── project_init/PROMPT.md
├── doc_gen/PROMPT.md
└── heartbeat/PROMPT.md
```

Total: ~2,900 lines of TypeScript. The design is deliberately small — every module fits in your head.

### Key Design Decisions

- **Provider interfaces** — Every capability (comms, memory, models) is an interface. Implementations register in dictionaries. Adding a provider requires zero engine changes.
- **Compiled Prompt Pattern** — Context is assembled from directive files, memory, and templates at execution time. The engine never hardcodes prompt structure.
- **Filesystem queue** — Tasks move through `inbox/ → active/ → completed/|failed/` as plain YAML files. No database, no message broker. `ls tasks/active/` tells you what's running.
- **Plugin = function** — A plugin is a single function that receives a context object. No class hierarchies, no lifecycle annotations, no magic. Inspired by Fastify's register pattern.

### Running Tests

```bash
npm test                # Run full suite
npm run test:watch      # Watch mode
```

### Building the npm Package

```bash
npm run build
npm pack                # Creates tasksmith-<version>.tgz
```

Install the local tarball anywhere:

```bash
npm install -g ./tasksmith-cli-0.3.1.tgz
```

## Programmatic Usage

TaskSmith exports its core modules for use in other tools:

```typescript
import { TaskEngine, Coordinator, loadConfig, resolveWorkspace } from "tasksmith";
import { PluginManager } from "tasksmith";

const ws = resolveWorkspace();
const config = loadConfig(ws);
const coordinator = new Coordinator(ws, config);
await coordinator.run();
```

## License

MIT

## Workspace Modes

TaskSmith supports three workspace modes:

### Global (default)
```bash
tasksmith setup   # creates ~/.tasksmith/
tasksmith run     # uses ~/.tasksmith/
```

All config, templates, memory, and tasks live in `~/.tasksmith/`.

### Project-Local
```bash
cd ~/code/my-api
tasksmith init    # creates .tasksmith/ in current directory
tasksmith run     # auto-detects .tasksmith/, uses project-local config
```

Project-local settings override global settings. Great for per-project templates, conventions, and task queues.

### Custom Workspace
```bash
tasksmith run --dir /path/to/workspace
# or
export TASKSMITH_DIR=/path/to/workspace
tasksmith run
```

### Workspace Override

By default, projects live inside the workspace (`~/.tasksmith/projects/`). Override this:

```yaml
# ~/.tasksmith/config/tasksmith.yaml
workspace:
  projectsDir: ~/code              # your projects live here
  templatesDir: ~/my-templates     # additional template search path
```

## Template System

Templates are resolved in priority order:

1. **Project-local:** `.tasksmith/templates/` (in current project)
2. **Workspace:** `<workspace>/templates/`
3. **Custom:** path from `workspace.templatesDir` config
4. **Global:** `~/.tasksmith/templates/`
5. **Built-in:** shipped with the npm package

Override any built-in template by placing your version higher in the chain:

```bash
# Override ralph_loop for this project only
mkdir -p .tasksmith/templates/ralph_loop
cp "$(npm root -g)/tasksmith-cli/templates/ralph_loop/PROMPT.md" .tasksmith/templates/ralph_loop/
vim .tasksmith/templates/ralph_loop/PROMPT.md
```

List all available templates:
```bash
tasksmith templates
```

## Task File Formats

TaskSmith supports both YAML and JSON task files:

```yaml
# task.yaml
template: ralph-loop
prompt: "Add input validation to /users"
project: my-api
model: sonnet
params:
  validation_command: "npm test"
```

```json
{
  "template": "ralph-loop",
  "prompt": "Add input validation to /users",
  "project": "my-api",
  "model": "sonnet",
  "params": { "validation_command": "npm test" }
}
```

Drop either format in `tasks/inbox/`. Both are processed identically.

## New CLI Commands

```bash
tasksmith init        # Initialize project-local config (.tasksmith/)
tasksmith templates   # List all templates with sources
tasksmith info        # Show workspace resolution details
```
