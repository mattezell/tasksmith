# TaskSmith

Lightweight agent orchestration built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI.

Drop a task file. Walk away. Come back to passing tests.

TaskSmith compiles your project context, coding conventions, and memory into every Claude Code invocation. It validates output, retries on failure, and pings your phone when it's done. Under 3,000 lines of core TypeScript. Six bundled plugins. Zero frameworks. MIT licensed.

```bash
npm install -g tasksmith-cli
```

🌐 [tasksmith.dev](https://tasksmith.dev) · 📦 [npm](https://www.npmjs.com/package/tasksmith-cli) · 💻 [GitHub](https://github.com/mattezell/tasksmith)

---

## Quick Start

```bash
# Setup (creates ~/.tasksmith/, walks you through config)
tasksmith setup

# Start the engine (watches for tasks)
tasksmith run

# Submit a task (from another terminal)
tasksmith submit -p "Add input validation to /users" --project my-api
```

Or drop a file in the inbox:

```yaml
# ~/.tasksmith/tasks/inbox/fix-auth.yaml
template: ralph-loop
prompt: "Fix the JWT refresh token race condition"
project: my-api
model: opus
params:
  validation_command: "npm test"
```

JSON works too:

```json
{
  "template": "ralph-loop",
  "prompt": "Add a health check endpoint",
  "project": "my-api",
  "params": { "validation_command": "npm test" }
}
```

---

## How It Works

```
Task file (YAML/JSON) → Inbox → Engine picks up →
  Compile prompt (SOUL + USER + CONVENTIONS + MEMORY + project context + template) →
  Invoke Claude Code CLI →
  Run validation command →
  If fail → feed errors back → retry (Ralph Loop) →
  If pass → archive to memory → notify you → done
```

### Compiled Prompts

Every invocation gets your full context automatically:

1. **SOUL.md** — personality, coding philosophy, how Claude should behave
2. **USER.md** — your name, stack, preferences
3. **CONVENTIONS.md** — coding standards
4. **GLOSSARY.md** — domain terms
5. **MEMORY.md** — durable facts + recent daily logs
6. **Project CLAUDE.md** — project-specific context
7. **Template** — task instructions with your prompt injected

You never copy-paste context again.

### Ralph Loop

Define a validation command. TaskSmith runs Claude Code, checks the output, feeds errors back, and retries until tests pass (or max iterations hit).

### Three-Tier Memory

| Tier | What | Loaded into prompt? |
|------|------|-------------------|
| **Hot** | MEMORY.md + daily logs | Yes, always (~2000 tokens) |
| **Warm** | JSONL structured logs | Searchable via `tasksmith memory --search` |
| **Cold** | Compressed JSON archives | Full history, gzipped |

After every task, the engine writes a summary to all tiers. Over time, Claude accumulates real project knowledge.

---

## Workspace Modes

### Global (default)

```bash
tasksmith setup    # creates ~/.tasksmith/
tasksmith run      # uses ~/.tasksmith/
```

### Project-Local

```bash
cd ~/code/my-api
tasksmith init     # creates .tasksmith/ in current project
tasksmith run      # auto-detects local config
```

Project-local settings merge over global. Great for per-project templates, conventions, and task queues.

### Custom

```bash
tasksmith run --dir /path/to/workspace
# or
export TASKSMITH_DIR=/path/to/workspace
```

### Workspace Override

Don't want projects trapped in `~/.tasksmith/projects/`?

```yaml
# ~/.tasksmith/config/tasksmith.yaml
workspace:
  projectsDir: ~/code               # projects live here instead
  templatesDir: ~/shared-templates   # additional template search path
```

---

## Templates

Templates shape how Claude approaches a task. Each is a `PROMPT.md` with `{{prompt}}` and `{{project}}` placeholders.

| Template | Purpose |
|----------|---------|
| `ralph-loop` | Iterate until valid — define a `validation_command`, retries on failure |
| `bug-hunt` | Reproduce, analyze root cause, fix |
| `code-review` | Security, performance, maintainability, convention adherence |
| `research` | Explore → deep-dive → synthesize into markdown |
| `project-init` | Scaffold a new project with tests, CLAUDE.md, and git |
| `doc-gen` | Generate or update documentation |
| `heartbeat` | Scheduled: daily briefing, memory consolidation, health checks |

### Template Resolution Chain

Templates resolve in priority order (first match wins):

1. **Project-local:** `.tasksmith/templates/`
2. **Workspace:** `<workspace>/templates/`
3. **Custom:** path from `workspace.templatesDir` config
4. **Global:** `~/.tasksmith/templates/`
5. **Built-in:** shipped with the npm package

Override any built-in:

```bash
mkdir -p .tasksmith/templates/ralph_loop
cp "$(npm root -g)/tasksmith-cli/templates/ralph_loop/PROMPT.md" .tasksmith/templates/ralph_loop/
# edit to your liking
```

List all templates and their sources: `tasksmith templates`

---

## Official Plugins

Six plugins ship with `tasksmith-cli` — no separate install. Enable in config:

```yaml
plugins:
  - metrics
  - github
  - docker
```

| Plugin | Description |
|--------|-------------|
| **github** | GitHub Issues/PR integration. Auto-create issues on failure, comment results, close on success. Config: `token`, `owner`, `repo` or `GITHUB_TOKEN` env var. |
| **metrics** | Execution analytics. Success rates, timing, model/template/project breakdown. CLI: `tasksmith metrics` |
| **docker** | Container isolation. Resource limits, project mounts, per-task image overrides, auto-cleanup. CLI: `tasksmith docker` |
| **jira** | JIRA ticket integration. Create on failure, transition to Done on success. Config: `host`, `email`, `apiToken`, `projectKey` |
| **postgres** | PostgreSQL task history. Auto-creates tables, full metadata, SQL queryable. CLI: `tasksmith pg`. Requires `npm install pg` |
| **proxmox** | Proxmox VM provisioning. Clone from templates, snapshot/rollback, lifecycle management. CLI: `tasksmith proxmox` |

Plugins with config:

```yaml
plugins:
  - name: github
    config:
      owner: "mattezell"
      repo: "my-project"
      createIssuesOnFailure: true
  - name: metrics
    config:
      retainDays: 180
  - name: docker
    config:
      image: "node:22-slim"
      resourceLimits:
        cpus: "2"
        memory: "4g"
```

Link a task to a GitHub issue or JIRA ticket:

```yaml
params:
  github_issue: 42       # comments results, closes on success
  jira_ticket: "PROJ-123" # same for JIRA
```

### Community Plugins

Anyone can publish plugins via npm:

```bash
npm install tasksmith-plugin-my-thing
# or from the official scope:
npm install @tasksmith-dev/plugin-my-thing
```

Scaffold your own: `tasksmith plugin create my-thing`

---

## Communication

### Outbound (notifications)

| Provider | Description |
|----------|-------------|
| `discord_webhook` | Rich embeds with color-coded priority |
| `ntfy` | Push notifications to phone/desktop via [ntfy.sh](https://ntfy.sh) |
| `slack_webhook` | Slack channel messages |
| `email` | SMTP email notifications |
| `sms_twilio` | SMS via Twilio |
| `webhook_generic` | POST JSON to any URL |

### Inbound (receive tasks)

| Provider | Description |
|----------|-------------|
| `file_drop` | Always on. Watches `tasks/inbox/` for YAML/JSON files |
| `discord_bot` | `@forge fix the auth bug in my-api` → parsed to task |
| `rest_api` | HTTP server on port 8420 |
| `watched_folder` | Watch any directory for task files |

The Discord bot parses natural language:

```
@forge fix the login timeout bug in my-api
  → template: bug-hunt, project: my-api

@forge urgent review the payment module with opus
  → template: code-review, priority: urgent, model: opus
```

---

## CLI Reference

```bash
tasksmith setup              # Interactive onboarding wizard
tasksmith run                # Start the engine
tasksmith submit             # Submit a task (interactive or with flags)
tasksmith status             # Queue counts, infrastructure health, directives
tasksmith init               # Initialize project-local config (.tasksmith/)
tasksmith templates          # List all templates with sources
tasksmith info               # Show workspace resolution and config paths
tasksmith doctor             # Diagnose common issues
tasksmith memory             # Browse/search memory (--hot, --search, --recent)
tasksmith plugin list        # List bundled + community plugins
tasksmith plugin create <n>  # Scaffold a new plugin
tasksmith metrics            # Task execution stats (metrics plugin)
tasksmith docker             # Container status (docker plugin)
tasksmith pg                 # Query task history (postgres plugin)
tasksmith proxmox            # VM status (proxmox plugin)
```

### Submit Options

```bash
tasksmith submit -p "Your prompt" --project my-api --model opus
tasksmith submit -f path/to/task.yaml
tasksmith submit -t bug-hunt -p "Fix the race condition" --priority high --iterations 8
```

---

## REST API

Enable the `rest_api` inbound provider for HTTP access on port 8420.

```bash
# Submit a task
curl -X POST http://localhost:8420/tasks \
  -H "Content-Type: application/json" \
  -d '{"template": "ralph-loop", "prompt": "Add tests", "project": "my-api"}'

# List tasks
curl http://localhost:8420/tasks?status=completed

# Health check
curl http://localhost:8420/health
```

---

## Task File Format

```yaml
id: my-task-id              # Optional — auto-generated if omitted
template: ralph-loop        # Which template to use
prompt: "Your instructions"
project: my-api             # Project directory name
model: sonnet               # opus or sonnet
priority: normal            # low, normal, high, urgent
max_iterations: 5           # Max retries for ralph-loop
notify:
  - all                     # Notification targets
params:
  validation_command: "npm test"
  cooldown_seconds: 5       # Pause between retries
  github_issue: 42          # Link to GitHub issue (github plugin)
  jira_ticket: "PROJ-123"   # Link to JIRA ticket (jira plugin)
  docker_image: "node:22"   # Override container image (docker plugin)
  proxmox: true             # Provision a VM (proxmox plugin)
```

---

## Configuration

`~/.tasksmith/config/tasksmith.yaml` (or `.json`). Generated by `tasksmith setup`.

```yaml
workspace:
  projectsDir: ~/code
  templatesDir: ""

taskDefaults:
  maxIterations: 5
  timeoutMinutes: 30
  model: sonnet
  priority: normal

communication:
  outbound:
    - provider: ntfy
      enabled: true
      config:
        topic: tasksmith
  inbound:
    - provider: rest_api
      enabled: true
      config:
        port: 8420

plugins:
  - metrics
  - github
```

Config layering: defaults → global `~/.tasksmith` → project-local `.tasksmith/`

---

## Architecture

```
┌──────────────────────────────────────────┐
│              Coordinator                  │
│  Wires providers, engine, API, plugins   │
├──────────┬───────────┬───────────────────┤
│ Inbound  │  Engine   │    Outbound       │
│ file_drop│  parse →  │ discord_webhook   │
│ discord  │  context →│ ntfy, slack       │
│ rest_api │  invoke → │ email, sms        │
│ watched  │  validate→│ webhook           │
│          │  retry →  │                   │
│          │  finalize │                   │
├──────────┴───────────┴───────────────────┤
│            Memory (hot/warm/cold)         │
├──────────────────────────────────────────┤
│    Bundled Plugins (github, metrics,     │
│    docker, jira, postgres, proxmox)      │
├──────────────────────────────────────────┤
│    Community Plugins (npm discovery)     │
└──────────────────────────────────────────┘
```

### Source Layout

```
src/
├── config.ts             382 lines   Workspace resolution, config layering, template chain
├── engine.ts             370 lines   Task lifecycle, Ralph Loop, Claude Code invocation
├── plugins.ts            583 lines   Plugin loader, lifecycle hooks, scaffolding
├── cli.ts                416 lines   Commander CLI (14 commands)
├── onboarding.ts         324 lines   8-step interactive setup wizard
├── coordinator.ts        248 lines   Wires providers + engine + plugins
├── types.ts              177 lines   Interfaces and provider contracts
├── api.ts                174 lines   REST API server
├── index.ts                7 lines   Package exports
├── providers/
│   ├── comms/            370 lines   6 outbound + 4 inbound providers
│   └── memory/           250 lines   Markdown, JSONL, compressed archives
└── plugins/bundled/
    ├── index.ts           76 lines   Lazy-load registry
    ├── github.ts         240 lines   GitHub Issues/PR integration
    ├── metrics.ts        296 lines   Execution analytics
    ├── docker.ts         246 lines   Container isolation
    ├── jira.ts           243 lines   JIRA ticket integration
    ├── postgres.ts       229 lines   PostgreSQL task history
    └── proxmox.ts        295 lines   Proxmox VM provisioning
```

**2,681 lines of core TypeScript** + 1,625 lines across 6 bundled plugins. Every module fits in your head.

### Design Principles

- **Provider interfaces** — every capability is an interface. Adding a provider requires zero engine changes.
- **Compiled prompts** — context assembled at execution time from directive files, memory, and templates. Never hardcoded.
- **Filesystem queue** — tasks move through `inbox/ → active/ → completed/|failed/` as plain files. No database required. `ls tasks/active/` shows what's running.
- **Plugin = function** — a plugin is a single function receiving a context object. No class hierarchies, no annotations.
- **npm IS the plugin manager** — no custom registry. `npm install` + one line in config.
- **Lazy loading** — bundled plugins import on-demand. Disabled plugins add zero startup cost.

---

## Building from Source

```bash
git clone https://github.com/mattezell/tasksmith.git
cd tasksmith
npm install
npm run build
npm link           # makes `tasksmith` and `forge` available globally
```

```bash
tasksmith --version    # 0.5.0
tasksmith doctor       # check prerequisites
```

---

## Prerequisites

- **Node.js 18+** (Claude Code users already have this)
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

Optional:
- [Ollama](https://ollama.com/) for local model routing
- [Docker](https://docker.com/) for container isolation plugin
- [PostgreSQL](https://postgresql.org/) for postgres plugin (`npm install pg`)

---

## License

MIT
