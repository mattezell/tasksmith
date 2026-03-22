# TaskSmith

Lightweight agent orchestration built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI.

Drop a task file. Walk away. Come back to passing tests.

TaskSmith compiles your project context, coding conventions, and memory into every Claude Code invocation. It validates output, retries on failure, and pings your phone when it's done. Run tasks in parallel with git worktree isolation — each task gets its own branch. Chain tasks with dependency DAGs. Expose everything via MCP so agents can submit tasks to other agents. Schedule recurring tasks with cron. Under 8,000 lines of core TypeScript. 8 bundled plugins. Zero frameworks. Every module fits in your head. MIT licensed.

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

## Adding a Project

TaskSmith needs to know where your code lives. Symlink your project into the projects directory:

```bash
ln -s /home/you/code/my-api ~/.tasksmith/projects/my-api
```

Now you can reference it by name in task files (`project: my-api`), CLI commands (`--project my-api`), and chat messages. Worktrees, validation commands, and project `CLAUDE.md` context all resolve through this symlink automatically.

Add as many as you want:

```bash
ln -s ~/code/frontend    ~/.tasksmith/projects/frontend
ln -s ~/code/shared-lib  ~/.tasksmith/projects/shared-lib
ln -s ~/work/monorepo/packages/api  ~/.tasksmith/projects/api
```

Each symlink points to the **actual git repo root** (or subdirectory) where Claude Code should run. TaskSmith resolves symlinks via `realpathSync`, so worktrees are created in the real repository — not inside `~/.tasksmith/`.

If you'd rather not use symlinks, set `workspace.projectsDir` to the directory your projects already live in:

```yaml
# ~/.tasksmith/config/tasksmith.yaml
workspace:
  projectsDir: ~/code    # every subdirectory becomes a project
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

### Structured Task Logs

Every task gets an append-only JSONL event log at `<workspace>/logs/task-<id>.jsonl`. Each line is a timestamped event:

```jsonl
{"ts":"...","event":"task_start","task":"abc","template":"ralph-loop","model":"opus","project":"my-api","max_iterations":5}
{"ts":"...","event":"iter_start","task":"abc","iter":1,"model":"opus"}
{"ts":"...","event":"cc_complete","task":"abc","iter":1,"turns":33,"cost":1.07,"duration_ms":45000}
{"ts":"...","event":"validation","task":"abc","iter":1,"cmd":"npm test","exit_code":1,"classification":"TEST","contradiction":false}
{"ts":"...","event":"iter_end","task":"abc","iter":1,"passed":false,"failure_class":"TEST","cumulative_cost":1.07}
{"ts":"...","event":"task_end","task":"abc","status":"completed","total_cost_usd":3.21,"iterations_used":3}
```

Survives engine restarts (append-only files, no in-memory state). Use for post-mortem analysis, cost attribution, and debugging without parsing console output.

### Crash Recovery

If the engine crashes or restarts mid-task, orphaned tasks in `tasks/active/` are automatically resumed on next startup. The engine checkpoints iteration progress and cumulative cost after each iteration, so resumed tasks pick up from the last completed iteration — no wasted tokens re-running iterations that already succeeded.

### Parallel Execution

Run multiple tasks simultaneously with a configurable worker pool:

```yaml
engine:
  concurrency: 3    # max parallel tasks (default: 1)
```

Tasks are priority-queued (urgent → high → normal → low). The pool dequeues up to `concurrency` tasks and runs them in parallel. When one finishes, the next in queue starts automatically. Execution is fully async — the Node.js event loop stays free for inbox scanning, file watching, and pool management while Claude Code runs. CLI: `tasksmith workers` shows pool config and active worktrees.

### Task DAG (Dependency Workflows)

Chain tasks with explicit dependencies. Task B starts only after Task A completes. Failure propagates — if A fails, B and all downstream tasks are cancelled.

```yaml
# deploy-pipeline.yaml
dag_id: deploy-pipeline
project: my-api
model: auto

tasks:
  - id: build
    template: ralph-loop
    prompt: "Build the project"
    params:
      validation_command: "npm run build"

  - id: test
    depends_on: [build]
    template: ralph-loop
    prompt: "Run tests"
    params:
      validation_command: "npm test"

  - id: deploy
    depends_on: [test]
    template: ralph-loop
    prompt: "Deploy to staging"
```

Submit via CLI: `tasksmith dag -f deploy-pipeline.yaml`
Submit via inbox: Drop the YAML file in `tasks/inbox/`
Submit via MCP: Use the `submit_dag` tool

Check status: `tasksmith dag --status deploy-pipeline`

DAG state is persisted to `tasks/dags/` so active DAGs survive restarts. Each step can run in its own worktree when worktree isolation is enabled.

### Git Worktree Isolation

When running multiple tasks in parallel, each task gets its own git worktree — preventing concurrent tasks from clobbering each other's work:

```yaml
engine:
  concurrency: 3   # worktree isolation auto-enables when concurrency > 1
```

**How it works:**

1. Before the Ralph Loop starts, the engine creates a worktree: `git worktree add -b tasksmith/<task-id> <repo>/.claude/worktrees/<task-id> HEAD`
2. All Claude Code invocations and validation commands run inside the worktree
3. After the task completes (pass or fail), the worktree is removed

**Behavior:**

- **Auto-enabled** when `engine.concurrency > 1` (multiple tasks would conflict without isolation)
- **Explicit control:** Set `engine.worktree.enabled: true` to force on, or `false` to force off
- **Per-task opt-out:** Set `params.worktree: false` on any task to skip isolation
- **Requires a project:** Tasks without a `project` field have no git repo to isolate, so they run in-place
- **Project-aware:** Project symlinks (e.g., `~/.tasksmith/projects/my-api` → `/home/user/code/my-api`) are resolved via `realpathSync`, so worktrees are created in the actual git repo

**Branch naming:** `tasksmith/<task-id>` — branches are created from HEAD of the project's current branch. After task completion the worktree is removed, but the branch persists for review or PR creation.

**Fallback:** If worktree creation fails (not a git repo, branch name conflict after retry), the task runs in the project directory directly with a console warning. No silent failures.

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

### Human-in-the-Loop Approval Gates

Optionally require explicit approval before executing high-risk tasks. Off by default — zero behavior change unless you enable it.

```yaml
engine:
  approvalGates:
    enabled: true
    timeoutMinutes: 60          # auto-reject after timeout
    requireApproval:
      - template: project-init  # specific task types
      - params: { proxmox: true }  # tasks requesting VM provisioning
      - params: { cf_deploy: true } # tasks triggering deployment
      - source: discord_bot     # all tasks from Discord
```

When a task matches a rule, it's parked in `tasks/pending_approval/` and a notification is sent via all outbound providers with the task details and instructions:

```bash
tasksmith approve <taskId>   # approve and submit to pool
tasksmith reject <taskId>    # reject with optional --reason
```

**Design principles:**
- **Off by default.** If you don't configure gates, they don't exist.
- **Rule-based matching** — gate by template, params, or inbound source.
- **Never interrupts the "just do it" user** — if you've chosen full autonomy and don't enable gates, nothing changes.
- **Auto-rejects on timeout** to prevent orphaned tasks.

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
```

---

## Skills (Task Templates)

TaskSmith ships with 7 Claude Code skills that shape how Claude approaches each task type. Skills are installed to `~/.tasksmith/.claude/skills/` during setup and injected into every Claude Code session via `--add-dir`.

| Skill | Purpose |
|-------|---------|
| `ralph-loop` | Iterate until valid — define a `validation_command`, retries on failure |
| `bug-hunt` | Reproduce, analyze root cause, fix |
| `code-review` | Security, performance, maintainability, convention adherence |
| `research` | Explore → deep-dive → synthesize into markdown |
| `project-init` | Scaffold a new project with tests, CLAUDE.md, and git |
| `doc-gen` | Generate or update documentation |
| `heartbeat` | Scheduled: daily briefing, memory consolidation, health checks |

### Skill Discovery (Three Layers)

Skills are discovered by Claude Code from three locations:

| Layer | Path | Scope |
|-------|------|-------|
| **Global TaskSmith** | `~/.tasksmith/.claude/skills/<name>/SKILL.md` | All tasks, all projects |
| **Project TaskSmith** | `<project>/.tasksmith/.claude/skills/<name>/SKILL.md` | Tasks targeting that project |
| **Project native** | `<project>/.claude/skills/<name>/SKILL.md` | CC's native discovery from cwd |

The global layer ships with 7 bundled skills. Add your own by creating a `<name>/SKILL.md` in any layer — project-level skills let you customize task behavior per-project without affecting others.

**Custom skill example:**

```bash
mkdir -p ~/.tasksmith/.claude/skills/deploy/
cat > ~/.tasksmith/.claude/skills/deploy/SKILL.md << 'EOF'
---
name: deploy
description: Deploy to staging with safety checks
---

# Deploy

$ARGUMENTS

## Steps
1. Run the full test suite
2. Build production artifacts
3. Deploy to staging via the deploy script
4. Verify health check endpoint responds
EOF
```

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
@tasksmith create a new TypeScript Express API with auth and tests in my-new-api
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

TaskSmith creates the project directory and passes the `project-init` skill to Claude Code, which generates the scaffold. Typical output includes: project structure, dependency management (package.json / pyproject.toml / etc.), test directory with example tests, CLAUDE.md, .gitignore, and README. Actual output depends on Claude's interpretation of your prompt. Combine with `validation_command` to verify the scaffolded project builds and tests pass before completing.

### Skill File Format

Each skill lives in its own directory with a `SKILL.md` file containing YAML frontmatter:

```
~/.tasksmith/.claude/skills/
├── ralph-loop/SKILL.md
├── bug-hunt/SKILL.md
├── code-review/SKILL.md
├── doc-gen/SKILL.md
├── research/SKILL.md
├── heartbeat/SKILL.md
└── project-init/SKILL.md
```

**Overriding a bundled skill:** Create a skill with the same name in a project-level `.tasksmith/.claude/skills/` directory. Project-level skills take precedence.

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
| **docker** | Container isolation. Resource limits, project mounts, per-task image overrides, auto-cleanup. CLI: `tasksmith plugin run docker` |
| **jira** | JIRA ticket integration. Create on failure, transition to Done on success. Config: `host`, `email`, `apiToken`, `projectKey` |
| **postgres** | PostgreSQL task history. Auto-creates tables, full metadata, SQL queryable. CLI: `tasksmith plugin run pg`. Requires `npm install pg` |
| **proxmox** | Proxmox VM provisioning. Clone from templates, snapshot/rollback, lifecycle management. CLI: `tasksmith plugin run proxmox` |
| **cloudflare** | Cloudflare Pages deployments. Auto-deploy on task success, rollback, cache purge. Uses `wrangler` CLI. CLI: `tasksmith plugin run cf` |
| **semantic-memory** | Vector-based semantic search over task history. Supports Ollama (local), OpenAI, or Gemini embeddings. CLI: `tasksmith plugin run semantic` |

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
| `email` | SMTP email notifications (requires `npm install nodemailer`) |
| `webhook_generic` | POST JSON to any URL |

### Inbound (receive tasks)

| Provider | Description |
|----------|-------------|
| `file_drop` | Always on. Watches `tasks/inbox/` for YAML/JSON files |
| `mcp` | MCP server (stdio). Any MCP client can submit tasks |
| `discord_bot` | `@tasksmith fix the auth bug in my-api` → parsed to task. Guild + channel allowlists. |
| `rest_api` | HTTP server on port 8420 (with optional auth + rate limiting) |
| `github_webhook` | Receives GitHub webhook events — auto-creates tasks from labeled issues and `/tasksmith` comments |
| `slack_events` | Slack Events API listener — responds to @mentions and channel messages with `/tasksmith` prefix |
| `watched_folder` | Watch any directory for task files |

The Discord bot parses natural language, structured YAML, and JSON:

```
# Natural language with auto-detection
@tasksmith fix the login timeout bug in my-api
  → template: bug-hunt, project: my-api

@tasksmith urgent review the payment module with opus
  → template: code-review, priority: urgent, model: opus

# Natural language with params
@tasksmith fix the auth bug, validate with npm test in my-api
  → template: bug-hunt, project: my-api
  → params: { validation_command: "npm test" }

# Paste YAML or JSON for full control
@tasksmith
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
tasksmith submit --from-github-issue 42  # Create task from GitHub issue
tasksmith status             # Queue counts, infrastructure health, directives
tasksmith init               # Initialize project-local config (.tasksmith/)
tasksmith info               # Show workspace resolution and config paths
tasksmith doctor             # Diagnose common issues
tasksmith memory             # Browse/search memory (--hot, --search, --recent)
tasksmith schedule           # Show configured task schedules
tasksmith workers            # Show worker pool config and active worktrees
tasksmith workers --cleanup  # Remove stale worktrees (--dry-run to preview)
tasksmith approve <taskId>      # Approve a task pending review
tasksmith reject <taskId>       # Reject a pending task (--reason "...")
tasksmith dag -f pipeline.yaml  # Submit a DAG workflow
tasksmith dag --list         # List active DAGs
tasksmith dag --status <id>  # Check DAG status
tasksmith dag --graph <id>   # Output Mermaid flowchart
tasksmith mcp                # Start MCP server (stdio transport)
tasksmith plugin list           # List bundled + community plugins
tasksmith plugin create <n>    # Scaffold a new plugin
tasksmith plugin run <name>    # Run a plugin command
tasksmith metrics              # Task execution stats + cost tracking
tasksmith insights             # Analyze task history for patterns
tasksmith plugin run docker    # Container status (docker plugin)
tasksmith plugin run pg        # Query task history (postgres plugin)
tasksmith plugin run proxmox   # VM status (proxmox plugin)
tasksmith plugin run cf        # Cloudflare: deploy, status, rollback (cloudflare plugin)
tasksmith plugin run semantic  # Semantic memory search (semantic-memory plugin)
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
@tasksmith fix the auth bug validation_command="npm test" in my-api

# Explicit key=value (unquoted, single-word values)
@tasksmith deploy the site cf_deploy=true

# Natural language validation
@tasksmith fix the login bug, validate with npm run test:auth in my-api
  → params: { validation_command: "npm run test:auth" }

# All NL features combine with template/project/priority detection
@tasksmith urgent fix the race condition, test with pytest in payment-service
  → template: bug-hunt, priority: urgent, project: payment-service
  → params: { validation_command: "pytest" }
```

---

## REST API

Enable the `rest_api` inbound provider for HTTP access on port 8420. Optional bearer token auth and rate limiting available.

```yaml
# tasksmith.yaml
communication:
  inbound:
    - provider: rest_api
      enabled: true
      config:
        port: 8420
        authToken: "${TASKSMITH_API_TOKEN}"  # omit for no auth
        rateLimit: 60                         # requests/min per IP (0 = unlimited)
```

```bash
# Submit a task (with auth)
curl -X POST http://localhost:8420/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token-here" \
  -d '{"template": "ralph-loop", "prompt": "Add tests", "project": "my-api", "params": {"validation_command": "npm test"}}'

# List tasks
curl -H "Authorization: Bearer your-token-here" http://localhost:8420/tasks?status=completed

# Health check (no auth required)
curl http://localhost:8420/health

# Approval workflow
curl -H "Authorization: Bearer your-token-here" http://localhost:8420/tasks/pending
curl -X POST -H "Authorization: Bearer your-token-here" http://localhost:8420/tasks/task-123/approve
curl -X POST -H "Authorization: Bearer your-token-here" -H "Content-Type: application/json" \
  -d '{"reason": "Not ready"}' http://localhost:8420/tasks/task-123/reject
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
| `retry_task` | Retry a failed task (copies back to inbox with a new ID) |
| `search_memory` | Search TaskSmith's memory for past results and learnings |
| `store_memory` | Store a fact, decision, or learning in memory |
| `list_projects` | Show configured projects |
| `queue_status` | System overview: queue counts, directives, memory providers |
| `health_check` | System health and version info |
| `submit_dag` | Submit a task DAG (dependency workflow) |
| `dag_status` | Get status of a running DAG |
| `list_dags` | List all tracked DAGs |

### Resources

| Resource | URI Pattern | Description |
|----------|-------------|-------------|
| System Status | `tasksmith://status` | Queue counts, version, workspace path (JSON) |
| Memory | `tasksmith://memory` | Current MEMORY.md hot memory contents |
| Directives | `tasksmith://directives/{name}` | SOUL.md, USER.md, CONVENTIONS.md, etc. |
| Projects | `tasksmith://projects/{name}` | Project CLAUDE.md and structure |

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

taskDefaults:
  maxIterations: 5
  timeoutMinutes: 30
  model: sonnet
  priority: normal

engine:
  permissionMode: supervised  # supervised | autonomous | yolo
  concurrency: 3              # parallel task slots

scheduling:
  tasks:
    - name: "nightly-consolidation"
      template: heartbeat
      prompt: "Consolidate memory"
      cron: "0 2 * * *"
      enabled: true

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
        authToken: "${TASKSMITH_API_TOKEN}"
        rateLimit: 60
    - provider: github_webhook
      enabled: false
      config:
        port: 8421
        webhookSecret: "${GITHUB_WEBHOOK_SECRET}"
        triggerLabels: ["tasksmith"]
    - provider: slack_events
      enabled: false
      config:
        port: 8422
        signingSecret: "${SLACK_SIGNING_SECRET}"

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

The recommended mode for unattended operation. Passes `--permission-mode acceptEdits` to Claude Code, which auto-approves file edits while still prompting for bash commands and other tool calls.

Configure your Claude Code project or user settings to fine-tune which tools are allowed/denied — TaskSmith delegates all permission enforcement to Claude Code's native permission system.

Best for: solo developer workflows, trusted project codebases, unattended overnight runs.

### yolo

```bash
tasksmith run --mode yolo
```

Passes `--dangerously-skip-permissions` to Claude Code. All permission checks are bypassed — Claude executes any operation without prompting.

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

- **No settings files are written.** TaskSmith passes CLI flags to Claude Code (`--permission-mode`, `--dangerously-skip-permissions`). Your `~/.claude/settings.json` and project `.claude/` directories are never touched.
- **Permission enforcement is delegated to Claude Code.** Configure allowed/denied tools in your Claude Code settings (user or project level). TaskSmith only controls which mode flag is passed.

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
│ rest_api │  │Engine│ │ email, webhook     │
│ mcp      │  │ × N  │ │ webhook           │
│ watched  │  └──────┘ │                   │
│          │ Worktree  │                   │
│          │ Isolation  │                  │
├──────────┴───────────┴───────────────────┤
│   DAG Manager (dependency workflows)     │
├──────────────────────────────────────────┤
│   Input Sanitizer (trust levels)         │
├──────────────────────────────────────────┤
│        Scheduler (cron)                  │
├──────────────────────────────────────────┤
│            Memory (hot/warm/cold)        │
├──────────────────────────────────────────┤
│    Bundled Plugins (github, metrics,     │
│    docker, jira, postgres, proxmox,      │
│    cloudflare, semantic-memory)          │
├──────────────────────────────────────────┤
│    Community Plugins (npm discovery)     │
└──────────────────────────────────────────┘
```

### Source Layout

```
src/
├── engine.ts           ~1,260 lines  Task lifecycle, Ralph Loop, circuit breaker, smart model routing, JSONL task log
├── cli.ts              ~1,020 lines  Commander CLI (submit, dag, metrics, insights, workers, etc.)
├── mcp.ts                ~700 lines  MCP server (stdio), 13 tools, 4+ resource types
├── coordinator.ts        ~700 lines  Wires providers + engine + pool + plugins + DAG
├── plugins.ts            ~566 lines  Plugin loader, lifecycle hooks, scaffolding
├── dag.ts                ~450 lines  Task DAG: dependency resolution, cycle detection, Mermaid export
├── sanitize.ts           ~375 lines  Input sanitization: trust levels, allowlist validation
├── config.ts             ~355 lines  Workspace resolution, config layering, skill installation
├── api.ts                ~300 lines  REST API server (Fastify) — auth + rate limiting + approval
├── onboarding.ts         ~251 lines  Simplified setup wizard
├── scheduler.ts          ~237 lines  Cron-based task scheduling
├── types.ts              ~203 lines  Interfaces, provider contracts
├── pool.ts               ~138 lines  Worker pool, concurrency limiter
├── index.ts               ~13 lines  Package exports
├── providers/
│   ├── comms/            ~790 lines  5 outbound + 7 inbound providers
│   └── memory/           ~241 lines  Markdown, JSONL, compressed archives
└── plugins/bundled/
    ├── index.ts           ~86 lines  Lazy-load registry
    ├── metrics.ts        ~545 lines   Execution analytics, cost tracking, insights engine
    ├── cloudflare.ts     ~487 lines   Cloudflare Pages deployments
    ├── semantic-memory.ts ~451 lines  Vector-based semantic search
    ├── proxmox.ts        ~295 lines   Proxmox VM provisioning
    ├── docker.ts         ~246 lines   Container isolation
    ├── jira.ts           ~243 lines   JIRA ticket integration
    ├── github.ts         ~240 lines   GitHub Issues/PR integration
    └── postgres.ts       ~229 lines   PostgreSQL task history
```

**Under 8,000 lines of core TypeScript** + ~2,800 lines across 8 bundled plugins. Every module fits in your head.

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

**Discord bot scoping.** Configure `allowedGuildIds` and `allowedChannelIds` to restrict which servers and channels can submit tasks. If neither is set, the bot warns on startup and accepts commands from anywhere. The REST API supports bearer token auth + rate limiting (see Configuration).

### Mitigations (Current)

- Claude Code has its own safety layer and permission model
- **Permission modes** control how much autonomy Claude Code gets — `supervised` (default) is most restrictive, `autonomous` auto-approves edits, `yolo` is unrestricted
- Permission enforcement is delegated to Claude Code — configure allowed/denied tools in your CC settings
- **Input sanitization** strips shell metacharacters and validates task fields from external sources
- **REST API auth** — bearer token + sliding-window rate limiting (configure `authToken` before network exposure)
- REST API binds to localhost by default
- **Discord bot guild + channel allowlists** — restrict which servers and channels can submit tasks
- Docker plugin provides optional container isolation
- File drop requires local filesystem access

### Recommendations

- **Start with `supervised` mode** until you're comfortable with how tasks execute
- **Use `autonomous` mode** for unattended operation, combined with Claude Code's native permission settings
- **Only use `yolo` mode** in isolated environments (Docker, VM, disposable worktrees)
- **Enable REST API auth** (`authToken` config) before exposing to the network
- **Restrict Discord bot** with `allowedGuildIds` and `allowedChannelIds` — don't leave it open to any server
- **Use Docker isolation** for untrusted or high-risk tasks
- **Review task files** before dropping them in inbox if they come from external sources

Input sanitization (v0.8.4) validates all inbound task data with a two-tier trust model. REST API bearer token auth and rate limiting (v1.0.0). GitHub webhook HMAC-SHA256 verification. Slack signing secret verification. See [ROADMAP.md](ROADMAP.md) for remaining planned security improvements.

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
tasksmith --version    # 1.0.0
tasksmith doctor       # check prerequisites
```

---

## Prerequisites

- **Node.js 18+** (Claude Code users already have this)
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

Optional:
- [Git](https://git-scm.com/) for worktree isolation (you probably already have this)
- [gh CLI](https://cli.github.com/) for `--from-github-issue` intake
- [Ollama](https://ollama.com/) for local embeddings (semantic-memory plugin)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) for Cloudflare deployments
- [Docker](https://docker.com/) for container isolation plugin
- [PostgreSQL](https://postgresql.org/) for postgres plugin (`npm install pg`)

---

## License

MIT
