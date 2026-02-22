# TaskSmith

Lightweight agent orchestration built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI.

Drop a task file. Walk away. Come back to passing tests.

TaskSmith compiles your project context, coding conventions, and memory into every Claude Code invocation. It validates output, retries on failure, and pings your phone when it's done. Run tasks in parallel with git worktree isolation — each task gets its own branch, auto-opens a PR on success. Schedule recurring tasks with cron. Under 5,000 lines of core TypeScript. 9 bundled plugins. Zero frameworks. Every module fits in your head. MIT licensed.

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

### Parallel Execution

Run multiple tasks simultaneously with a configurable worker pool:

```yaml
engine:
  concurrency: 3    # max parallel tasks (default: 1)
```

Tasks are priority-queued (urgent → high → normal → low). The pool dequeues up to `concurrency` tasks and runs them in parallel. When one finishes, the next in queue starts automatically. Execution is fully async — the Node.js event loop stays free for inbox scanning, file watching, and pool management while Claude Code runs. CLI: `tasksmith workers` shows pool config and active worktrees.

### Git Worktree Isolation

Each parallel task can run in its own isolated git worktree — no clobbering:

```yaml
engine:
  concurrency: 3
  worktree:
    enabled: true
    strategy: "pr"           # "pr" | "auto-merge" | "branch-only" | "local"
    baseBranch: "main"
    prLabels: ["tasksmith", "automated"]
```

| Strategy | On success |
|----------|-----------|
| **`pr`** (default) | Commits, pushes, opens a GitHub PR via `gh` CLI |
| **`auto-merge`** | Merges into base branch (falls back to PR on conflicts) |
| **`branch-only`** | Pushes the branch — you decide what to do |
| **`local`** | Purely local — no push, no merge. Worktree and branch stay on disk for manual review |

On failure, the worktree is discarded (except `local`, which always preserves). No damage to main. Override per-task with `params.worktree_strategy` or disable with `params.worktree: false`.

**Project-aware:** Worktrees are created in the actual git repository, not the TaskSmith workspace. Project symlinks (e.g., `~/.tasksmith/projects/my-api` → `/home/user/code/my-api`) are resolved automatically via `realpathSync`.

### Smart Model Routing

Set `model: auto` in your task file to let TaskSmith pick the right model automatically:

| Template | Default Model | Rationale |
|----------|---------------|-----------|
| `heartbeat`, `code-review`, `doc-gen` | Haiku | Fast, cheap — these are simple tasks |
| `ralph-loop`, `bug-hunt`, `research` | Sonnet | Standard complexity |
| `project-init` | Opus | Complex multi-file generation |

**Escalation on failure:** When `model: auto` is set and an iteration fails, TaskSmith escalates to the next tier (Haiku → Sonnet → Opus). This means simple tasks start cheap, and only burn Opus tokens when they actually need the extra capability.

**Complexity signal:** Prompts longer than 5,000 characters are bumped from Haiku to Sonnet automatically.

**Explicit override always wins:** Setting `model: sonnet` (or `opus`, `haiku`) bypasses routing entirely.

### Rate Limit Handling

TaskSmith detects Anthropic API rate limits automatically and pauses until the limit resets:

- Detects "hit your limit" in Claude Code's response
- Parses the reset time (with timezone support)
- Sleeps until reset + 60-second buffer, then retries the same iteration
- Falls back to a 15-minute pause if the time can't be parsed
- Maximum sleep capped at 12 hours

No configuration needed — this is always active. Rate-limited iterations are not counted against `maxIterations`, so no work is lost.

### Claude Code Output Visibility

Each Claude Code iteration logs a summary line:

```
[engine] task-123 iteration 1 — 12 turns, $0.42, 45.2s
```

For deeper debugging, set `system.logLevel: DEBUG` in your config to save the full Claude Code JSON response per iteration to `~/.tasksmith/logs/{task-id}/iteration-{n}.json`.

### Sandbox Isolation

Wrap Claude Code invocations in OS-level process isolation — without Docker. Uses bubblewrap (Linux/WSL2) and Seatbelt (macOS), the same primitives Claude Code uses internally. Zero daemon. Minimal overhead.

```yaml
plugins:
  - name: sandbox
    config:
      enabled: false                    # opt-in per task (recommended)
      allowUnsandboxedCommands: false   # lock the escape hatch
```

**Per-task opt-in:**

```yaml
params:
  sandbox: true
  sandbox_domains: ["pypi.org", "stripe.com"]  # extend allowlist for this task
```

**Per-task opt-out** (when globally enabled):

```yaml
params:
  sandbox: false
```

**What's blocked by default:**

| Category | Blocked |
|----------|---------|
| Filesystem reads | `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.gnupg`, `~/.netrc` |
| Filesystem writes | `.env`, `.env.*`, `~/.bashrc`, `~/.zshrc`, `~/.profile` |
| Network | All domains not on the allowlist |

**What's allowed:** `api.anthropic.com`, `registry.npmjs.org`, `pypi.org`, `github.com` and a few more. Full list in `src/plugins/bundled/sandbox.ts`.

**Escape hatch:** By default (`allowUnsandboxedCommands: false`), Claude Code cannot self-authorize a sandbox bypass. Violations fail hard. Set to `true` only if you need Claude Code to run commands that legitimately need unrestricted access.

**vs. Docker plugin:** Use sandbox for lightweight OS-level isolation on trusted tasks. Use Docker when you need custom base environments, strict resource limits, or DinD. They're complementary — you can run both.

**Install the runtime** (optional but recommended — avoids `npx` overhead):

```bash
npm install @anthropic-ai/sandbox-runtime
```

TaskSmith falls back to `npx srt` automatically when the package isn't installed.

### Scheduled Tasks

Recurring tasks via cron syntax — memory consolidation, health checks, reports:

```yaml
schedules:
  - name: "nightly-consolidation"
    template: heartbeat
    prompt: "Consolidate memory, prune stale entries"
    cron: "0 2 * * *"
    enabled: true

  - name: "weekly-review"
    template: research
    prompt: "Generate weekly progress report"
    cron: "0 9 * * 1"
```

CLI: `tasksmith schedule` shows all configured schedules with human-readable descriptions.

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

### Green Field Projects

The `project-init` template scaffolds new projects from scratch. TaskSmith auto-creates the project directory — no manual setup needed.

**CLI:**

```bash
tasksmith submit -t project-init -p "Express API with JWT auth, Prisma ORM, and Docker" \
  --project my-new-api \
  --param language=TypeScript

tasksmith submit -t project-init -p "CLI tool for converting CSV to JSON" \
  --project csv2json \
  --param language=Python
```

**Chat:**

```
@forge create a new TypeScript Express API with auth and tests in my-new-api
  → template: project-init, project: my-new-api
```

**File drop:**

```yaml
template: project-init
prompt: "FastAPI service with SQLAlchemy, alembic migrations, pytest, Docker"
project: data-service
params:
  language: Python
  validation_command: "pytest"
```

The template generates: idiomatic project structure, dependency management (package.json / pyproject.toml / etc.), test directory with example tests, CLAUDE.md, .gitignore, and README with setup instructions. Combine with `validation_command` to verify the scaffolded project builds and tests pass before completing.

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

8 plugins ship with `tasksmith-cli` — no separate install. Enable in config:

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
| **cloudflare** | Cloudflare Pages deployments. Auto-deploy on task success, rollback, cache purge. Uses `wrangler` CLI. CLI: `tasksmith cf` |
| **semantic-memory** | Vector-based semantic search over task history. Supports Ollama (local), OpenAI, or Gemini embeddings. CLI: `tasksmith semantic` |
| **sandbox** | OS-level process isolation via `@anthropic-ai/sandbox-runtime`. Filesystem + network boundaries. No Docker required. macOS/Linux/WSL2. |

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
| `mcp` | MCP server (stdio). Any MCP client can submit tasks |
| `discord_bot` | `@forge fix the auth bug in my-api` → parsed to task |
| `rest_api` | HTTP server on port 8420 |
| `watched_folder` | Watch any directory for task files |

The Discord bot parses natural language, structured YAML, and JSON:

```
# Natural language with auto-detection
@forge fix the login timeout bug in my-api
  → template: bug-hunt, project: my-api

@forge urgent review the payment module with opus
  → template: code-review, priority: urgent, model: opus

# Natural language with params
@forge fix the auth bug, validate with npm test in my-api
  → template: bug-hunt, project: my-api
  → params: { validation_command: "npm test" }

# Paste YAML or JSON for full control
@forge
template: ralph-loop
prompt: "Refactor the auth module"
project: my-api
params:
  validation_command: "npm test"
  github_issue: 42
```

---

## CLI Reference

```bash
tasksmith setup              # Interactive onboarding wizard
tasksmith run                # Start the engine (with worker pool)
tasksmith run --mode yolo    # Start with YOLO permissions (--dangerously-skip-permissions)
tasksmith run --mode autonomous  # Start with autonomous permissions (acceptEdits + scoped tools)
tasksmith submit             # Submit a task (interactive or with flags)
tasksmith status             # Queue counts, infrastructure health, directives
tasksmith init               # Initialize project-local config (.tasksmith/)
tasksmith templates          # List all templates with sources
tasksmith info               # Show workspace resolution and config paths
tasksmith doctor             # Diagnose common issues
tasksmith memory             # Browse/search memory (--hot, --search, --recent)
tasksmith schedule           # Show configured task schedules
tasksmith workers            # Show worker pool config and active worktrees
tasksmith plugin list        # List bundled + community plugins
tasksmith plugin create <n>  # Scaffold a new plugin
tasksmith metrics            # Task execution stats (metrics plugin)
tasksmith docker             # Container status (docker plugin)
tasksmith pg                 # Query task history (postgres plugin)
tasksmith proxmox            # VM status (proxmox plugin)
tasksmith cf                 # Cloudflare: deploy, status, rollback (cloudflare plugin)
tasksmith semantic           # Semantic memory search (semantic-memory plugin)
```

### Submit Options

```bash
tasksmith submit -p "Your prompt" --project my-api --model opus
tasksmith submit -f path/to/task.yaml
tasksmith submit -t bug-hunt -p "Fix the race condition" --priority high --iterations 8
```

### Passing Parameters

Parameters like `validation_command`, `cf_deploy`, `github_issue`, etc. can be passed through every input path.

**CLI — `--param` flag (repeatable):**

```bash
# Validation command for ralph-loop
tasksmith submit -p "Add input validation to /users" --project my-api \
  --param validation_command="npm test"

# Multiple params
tasksmith submit -t ralph-loop -p "Refactor auth module" --project my-api \
  --param validation_command="npm run test:auth" \
  --param github_issue=42 \
  --param cooldown_seconds=10

# Boolean and numeric values auto-cast
tasksmith submit -p "Deploy the site" --param cf_deploy=true --param cooldown_seconds=5
```

In interactive mode (`tasksmith submit` with no prompt), TaskSmith asks for a validation command automatically when the template is `ralph-loop` or `bug-hunt`.

**File drop — YAML:**

```yaml
template: ralph-loop
prompt: "Add input validation to /users"
project: my-api
params:
  validation_command: "npm test"
  github_issue: 42
  cooldown_seconds: 5
```

**File drop — JSON:**

```json
{
  "template": "ralph-loop",
  "prompt": "Add input validation to /users",
  "project": "my-api",
  "params": {
    "validation_command": "npm test",
    "github_issue": 42
  }
}
```

**REST API:**

```bash
curl -X POST http://localhost:8420/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "template": "ralph-loop",
    "prompt": "Add input validation to /users",
    "project": "my-api",
    "params": {
      "validation_command": "npm test",
      "github_issue": 42
    }
  }'
```

**Chat (Discord, or any inbound provider) — structured:**

Paste YAML or JSON directly into the channel. The bot detects structured input automatically:

```yaml
template: ralph-loop
prompt: "Fix the auth timeout"
project: my-api
params:
  validation_command: "npm test"
```

or JSON:

```json
{"prompt": "Fix the auth timeout", "project": "my-api", "params": {"validation_command": "npm test"}}
```

**Chat — natural language:**

The bot extracts params from natural language in three ways:

```
# Explicit key="value" (quoted)
@forge fix the auth bug validation_command="npm test" in my-api

# Explicit key=value (unquoted, single-word values)
@forge deploy the site cf_deploy=true

# Natural language validation
@forge fix the login bug, validate with npm run test:auth in my-api
  → params: { validation_command: "npm run test:auth" }

# All NL features combine with template/project/priority detection
@forge urgent fix the race condition, test with pytest in payment-service
  → template: bug-hunt, priority: urgent, project: payment-service
  → params: { validation_command: "pytest" }
```

---

## REST API

Enable the `rest_api` inbound provider for HTTP access on port 8420.

```bash
# Submit a task (with params)
curl -X POST http://localhost:8420/tasks \
  -H "Content-Type: application/json" \
  -d '{"template": "ralph-loop", "prompt": "Add tests", "project": "my-api", "params": {"validation_command": "npm test"}}'

# List tasks
curl http://localhost:8420/tasks?status=completed

# Health check
curl http://localhost:8420/health
```

---

## MCP Server

TaskSmith can run as an [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server, letting any MCP client — Claude Code, Cursor, VS Code + Copilot, ChatGPT, etc. — submit tasks, check status, and search memory directly.

```bash
# Start as MCP server (stdio transport)
tasksmith mcp

# With explicit workspace
tasksmith mcp --dir ~/my-workspace
```

### Client Configuration

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tasksmith": {
      "command": "tasksmith",
      "args": ["mcp"]
    }
  }
}
```

### Available Tools

| Tool | Description |
|------|-------------|
| `submit_task` | Submit a new task (prompt, template, project, model, priority, validation command) |
| `get_task_status` | Get details of a specific task by ID |
| `list_tasks` | List tasks filtered by status (pending/active/completed/failed) |
| `cancel_task` | Cancel a pending or active task |
| `search_memory` | Search TaskSmith's memory for past results and learnings |
| `list_templates` | Show available task templates |
| `list_projects` | Show configured projects |
| `queue_status` | System overview: queue counts, directives, memory providers |

### Resources

| Resource | URI | Description |
|----------|-----|-------------|
| System Status | `tasksmith://status` | Queue counts, version, workspace path (JSON) |
| Memory | `tasksmith://memory` | Current MEMORY.md hot memory contents |

Input from MCP clients is sanitized with the same security layer as REST API and Discord inputs (external trust level).

---

## Task File Format

```yaml
id: my-task-id              # Optional — auto-generated if omitted
template: ralph-loop        # Which template to use
prompt: "Your instructions"
project: my-api             # Project directory name
model: auto                 # auto (smart routing), sonnet, opus, haiku
priority: normal            # low, normal, high, urgent
max_iterations: 5           # Max retries for ralph-loop
notify:
  - all                     # Notification targets
params:
  validation_command: "npm test"
  cooldown_seconds: 5       # Pause between retries
  permission_mode: autonomous  # Override engine permission mode for this task
  allowed_tools:             # Additional --allowedTools for this task (autonomous mode)
    - "Bash(python *)"
  disallowed_tools:          # Additional --disallowedTools for this task
    - "Bash(pip install *)"
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

engine:
  permissionMode: supervised  # supervised | autonomous | yolo
  concurrency: 3              # parallel task slots
  permissions:                 # used in autonomous mode
    allow:
      - "Read"
      - "Edit"
      - "Write"
      - "Bash(npm *)"
      - "Bash(git *)"
      - "Bash(node *)"
      - "Bash(ls *)"
      - "Bash(cat *)"
      - "Bash(mkdir *)"
      - "Bash(python *)"
      - "Bash(tsc *)"
    deny:
      - "Bash(rm -rf *)"
      - "Bash(sudo *)"
      - "Bash(curl *)"
      - "Bash(wget *)"
      - "Read(.env*)"
      - "Read(secrets/**)"
  worktree:
    enabled: true           # git worktree isolation
    strategy: "pr"          # "pr" | "auto-merge" | "branch-only"
    baseBranch: "main"

schedules:
  - name: "nightly-consolidation"
    template: heartbeat
    prompt: "Consolidate memory"
    cron: "0 2 * * *"

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
  - name: semantic-memory
    config:
      provider: ollama
  - name: cloudflare
    config:
      pages:
        projectName: "my-site"
        deployDir: "site/"
  - name: sandbox
    config:
      enabled: false                   # true = all tasks, false = opt-in per task
      allowUnsandboxedCommands: false  # lock escape hatch (recommended)
```

Config layering: defaults → global `~/.tasksmith` → project-local `.tasksmith/`

---

## Permission Modes

TaskSmith controls how Claude Code handles permissions during task execution. Since tasks run headlessly via `claude -p`, there's nobody at the keyboard to approve permission prompts — so the permission mode determines how autonomous your tasks can be.

### supervised (default)

```bash
tasksmith run                    # uses engine.permissionMode from config
tasksmith run --mode supervised  # explicit
```

Legacy behavior. Passes `--allowedTools` from the `models.providers.claude_code.config.defaultAllowedTools` setting (defaults to Write, Read, Edit, Bash, Task). Claude Code runs in its default permission mode — tasks will **stall on permission prompts** unless the user has their own Claude Code permissions configured (e.g., in `~/.claude/settings.json`).

Best for: learning the system, environments where you've already configured Claude Code permissions globally.

### autonomous

```bash
tasksmith run --mode autonomous
```

The recommended mode for unattended operation. Passes `--permission-mode acceptEdits` to Claude Code along with scoped tool permissions:

- `--allowedTools` from `engine.permissions.allow` — file operations are auto-approved; bash commands scoped to explicitly allowed patterns
- `--disallowedTools` from `engine.permissions.deny` — destructive commands blocked
- If a task has a `validation_command`, the base command is **automatically added** to the allow list

TaskSmith ships with sensible defaults covering common dev tools (npm, git, python, cargo, go, make, tsc, basic file ops) while denying destructive commands (rm -rf, sudo, curl, wget) and sensitive file reads (.env, secrets/).

Customize per workspace:

```yaml
engine:
  permissionMode: autonomous
  permissions:
    allow:
      - "Bash(npm *)"
      - "Bash(cargo *)"
      - "Bash(docker build *)"
    deny:
      - "Bash(rm -rf *)"
      - "Bash(sudo *)"
```

Or per task:

```yaml
template: ralph-loop
prompt: "Run the ML training pipeline"
params:
  permission_mode: autonomous
  allowed_tools:
    - "Bash(python *)"
    - "Bash(pip install *)"
  disallowed_tools:
    - "Bash(rm -rf *)"
  validation_command: "python -m pytest"
```

Best for: solo developer workflows, trusted project codebases, unattended overnight runs.

### yolo

```bash
tasksmith run --mode yolo
```

Passes `--dangerously-skip-permissions` to Claude Code. All permission checks are bypassed — Claude executes any operation without prompting. The `engine.permissions.deny` list is still applied via `--disallowedTools` (which works even in bypass mode).

Displays a prominent red warning on startup:

```
⚠  YOLO MODE — ALL permission checks disabled.
   Claude Code will execute any operation without prompting.
   Use only in isolated environments (Docker, VM, worktree).
```

Best for: Docker containers, VMs, CI/CD pipelines, or when combined with git worktree isolation where changes land on a branch (not main).

### Mode Resolution Order

Permission mode is resolved per-task with this precedence:

1. **Task-level:** `params.permission_mode` in the task file
2. **CLI flag:** `tasksmith run --mode <mode>` for the current session
3. **Config:** `engine.permissionMode` in tasksmith.yaml
4. **Default:** `supervised`

This means you can run the engine in `supervised` mode but submit individual tasks that escalate to `autonomous` or `yolo` when needed.

### Important Notes

- **No settings files are written.** TaskSmith passes CLI flags to Claude Code (`--permission-mode`, `--allowedTools`, `--disallowedTools`, `--dangerously-skip-permissions`). Your `~/.claude/settings.json` and project `.claude/` directories are never touched.
- **Known issue:** `--allowedTools` may be ignored when combined with `--dangerously-skip-permissions` (Claude Code bug). This is why `yolo` mode uses `--disallowedTools` instead — which works correctly in all modes.
- **Validation commands are auto-allowed.** In `autonomous` mode, if a task has `params.validation_command: "npm test"`, TaskSmith automatically adds `Bash(npm *)` to the allow list so the Ralph Loop can run without stalling.

---

## Architecture

```
┌──────────────────────────────────────────┐
│              Coordinator                 │
│  Wires providers, engine, API, plugins   │
├──────────┬───────────┬───────────────────┤
│ Inbound  │ Worker    │    Outbound       │
│ file_drop│  Pool     │ discord_webhook   │
│ discord  │  ┌──────┐ │ ntfy, slack       │
│ rest_api │  │Engine│ │ email, sms        │
│ watched  │  │ × N  │ │ webhook           │
│          │  └──────┘ │                   │
│          │ Worktree  │                   │
│          │ Isolation  │                  │
├──────────┴───────────┴───────────────────┤
│        Scheduler (cron)                  │
├──────────────────────────────────────────┤
│            Memory (hot/warm/cold)        │
├──────────────────────────────────────────┤
│    Bundled Plugins (github, metrics,     │
│    docker, jira, postgres, proxmox,      │
│    cloudflare, semantic-memory, sandbox) │
├──────────────────────────────────────────┤
│    Community Plugins (npm discovery)     │
└──────────────────────────────────────────┘
```

### Source Layout

```
src/
├── config.ts             427 lines   Workspace resolution, config layering, template chain
├── engine.ts             666 lines   Task lifecycle, Ralph Loop, async CC invocation, rate limits
├── plugins.ts            583 lines   Plugin loader, lifecycle hooks, scaffolding
├── cli.ts                572 lines   Commander CLI (18 commands)
├── pool.ts               528 lines   Worker pool, concurrency, project-aware worktree isolation
├── onboarding.ts         443 lines   9-step interactive setup wizard
├── coordinator.ts        389 lines   Wires providers + engine + pool + plugins
├── scheduler.ts          237 lines   Cron-based task scheduling
├── types.ts              199 lines   Interfaces, provider contracts, permission types
├── api.ts                174 lines   REST API server
├── index.ts                7 lines   Package exports
├── providers/
│   ├── comms/            395 lines   6 outbound + 4 inbound providers
│   └── memory/           241 lines   Markdown, JSONL, compressed archives
└── plugins/bundled/
    ├── index.ts           86 lines   Lazy-load registry
    ├── github.ts         240 lines   GitHub Issues/PR integration
    ├── metrics.ts        296 lines   Execution analytics
    ├── docker.ts         246 lines   Container isolation
    ├── jira.ts           243 lines   JIRA ticket integration
    ├── postgres.ts       229 lines   PostgreSQL task history
    ├── proxmox.ts        295 lines   Proxmox VM provisioning
    ├── cloudflare.ts     487 lines   Cloudflare Pages deployments
    ├── semantic-memory   451 lines   Vector-based semantic search
    └── sandbox.ts        303 lines   OS-level sandbox isolation
```

**Under 5,000 lines of core TypeScript** + 2,892 lines across 9 bundled plugins. Every module fits in your head.

### Design Principles

- **Provider interfaces** — every capability is an interface. Adding a provider requires zero engine changes.
- **Compiled prompts** — context assembled at execution time from directive files, memory, and templates. Never hardcoded.
- **Filesystem queue** — tasks move through `inbox/ → active/ → completed/|failed/` as plain files. No database required. `ls tasks/active/` shows what's running.
- **Plugin = function** — a plugin is a single function receiving a context object. No class hierarchies, no annotations.
- **npm IS the plugin manager** — no custom registry. `npm install` + one line in config.
- **Lazy loading** — bundled plugins import on-demand. Disabled plugins add zero startup cost.

---

## Security

TaskSmith executes AI-generated code on your machine. This is the entire point — and it carries real risks. Understand them before deploying.

### Attack Surface

**Prompt injection.** Inbound messages (Discord, REST API, watched folders) become prompts that drive code execution. A crafted message could manipulate Claude's behavior, override template intent, or inject unexpected instructions.

**Shell execution via params.** `validation_command` is executed as a shell command (`sh -c`). Any input path that can set task params (CLI, REST API, Discord, file drop) can control what runs on your machine.

**Memory poisoning.** Task results are written to memory and loaded into future prompts. A single adversarial task result could influence all subsequent task behavior.

**Git operations.** Worktree PR titles and commit messages include task content. Crafted prompts could inject unexpected content into your git history.

**No authentication.** The REST API (port 8420) has no auth by default. The Discord bot accepts commands from anyone in the configured channel.

### Mitigations (Current)

- Claude Code has its own safety layer and permission model
- **Permission modes** control how much autonomy Claude Code gets — `supervised` (default) is most restrictive, `autonomous` provides scoped access, `yolo` is unrestricted
- `engine.permissions.deny` blocks destructive commands even in `yolo` mode (via `--disallowedTools`)
- Default deny list blocks `rm -rf`, `sudo`, `curl`, `wget`, and `.env`/`secrets/` file reads
- REST API binds to localhost by default
- Discord bot supports channel ID filtering
- Docker plugin provides optional container isolation
- File drop requires local filesystem access
- Git worktree isolation (default `pr` strategy) ensures changes are reviewed before merging

### Recommendations

- **Start with `supervised` mode** until you're comfortable with how tasks execute
- **Use `autonomous` mode** with a restrictive `engine.permissions.allow` list for unattended operation
- **Only use `yolo` mode** in isolated environments (Docker, VM, disposable worktrees)
- **Never expose the REST API to the internet** without adding authentication
- **Restrict Discord bot** to a private channel with trusted users only
- **Use Docker isolation** for untrusted or high-risk tasks
- **Review task files** before dropping them in inbox if they come from external sources
- **Use the `pr` worktree strategy** (default) so changes are reviewed before merging
- **Customize deny lists** per-project to block project-specific sensitive operations

See [ROADMAP.md](ROADMAP.md) for planned security improvements including input sanitization, param allowlists, API authentication, and human-in-the-loop approval gates.

---

## Building from Source

```bash
git clone https://github.com/mattezell/tasksmith.git
cd tasksmith
npm install
npm run build
npm link           # makes `tasksmith` available globally
```

```bash
tasksmith --version    # 0.8.2
tasksmith doctor       # check prerequisites
```

---

## Prerequisites

- **Node.js 18+** (Claude Code users already have this)
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

Optional:
- [Git](https://git-scm.com/) for worktree isolation (you probably already have this)
- [gh CLI](https://cli.github.com/) for automatic PR creation (worktree `pr` strategy)
- [Ollama](https://ollama.com/) for local embeddings (semantic-memory plugin)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) for Cloudflare deployments
- [Docker](https://docker.com/) for container isolation plugin
- [PostgreSQL](https://postgresql.org/) for postgres plugin (`npm install pg`)

---

## License

MIT
