# Using TaskSmith in an Existing Project

This walkthrough shows how to add TaskSmith to an existing Node.js project.

## Scenario

You have a REST API project at `~/code/my-api/` and want to use TaskSmith
to automate coding tasks, run validation loops, and get notifications.

## Step 1: Install TaskSmith

```bash
npm install -g tasksmith-cli
```

## Step 2: Global Setup (one time)

```bash
tasksmith setup
```

This creates `~/.tasksmith/` with your global config, SOUL.md, USER.md, etc.
These are shared across ALL your projects.

Your `~/.tasksmith/` will look like:

```
~/.tasksmith/
├── config/
│   └── tasksmith.yaml       # Global config (providers, models, defaults)
├── directives/
│   ├── SOUL.md               # How Claude should behave (personality)
│   ├── USER.md               # Your preferences (name, stack, style)
│   ├── CONVENTIONS.md         # Global coding conventions
│   └── MEMORY.md             # Persistent memory across all projects
├── templates/                 # Your custom global templates
├── memory/
│   ├── logs/                  # JSONL searchable logs
│   └── sessions/              # Compressed session archives
└── tasks/                     # Global task queue (if not using project-local)
```

## Step 3: Configure Your Workspace

By default, TaskSmith uses `~/.tasksmith/` for everything. But you probably
don't want your projects living inside a dotfolder.

Edit `~/.tasksmith/config/tasksmith.yaml`:

```yaml
workspace:
  projectsDir: ~/code          # Where your projects actually live
  templatesDir: ~/code/shared-templates  # Optional shared template dir
```

Now when you reference `project: my-api`, TaskSmith looks for `~/code/my-api/`.

## Step 4: Initialize in Your Project (optional but recommended)

```bash
cd ~/code/my-api
tasksmith init
```

This creates `.tasksmith/` inside your project:

```
~/code/my-api/
├── .tasksmith/
│   ├── config/
│   │   └── tasksmith.yaml     # Project-specific overrides
│   ├── templates/             # Project-specific templates
│   ├── directives/            # Project-specific SOUL/USER/CONVENTIONS
│   └── tasks/
│       ├── inbox/             # Drop tasks here
│       ├── active/
│       ├── completed/
│       └── failed/
├── src/
├── tests/
├── package.json
└── ...
```

**Why init?**

- Templates in `.tasksmith/templates/` override built-in ones (and global ones)
- Directives in `.tasksmith/directives/` are project-specific context
- Config in `.tasksmith/config/tasksmith.yaml` overrides global settings
- When you `cd` into the project, TaskSmith auto-detects the local config

## Step 5: Add Project Context

Create project-specific directives:

```bash
cd ~/code/my-api

# Project conventions
cat > .tasksmith/directives/CONVENTIONS.md << 'EOF'
# my-api Conventions

- Express.js 4.x with TypeScript
- All routes in src/routes/, one file per resource
- Zod for request validation
- Prisma ORM, PostgreSQL
- Tests: Jest with supertest
- Error responses: { error: string, code: string, details?: object }
- Auth: JWT in Authorization header
EOF

# Project-specific CLAUDE.md (loaded as project context)
cat > CLAUDE.md << 'EOF'
# my-api

REST API for the TaskMaster application.

## Stack
- Express.js 4.19 + TypeScript 5.4
- Prisma 5.x + PostgreSQL 16
- Redis for caching and rate limiting
- Jest + Supertest for testing

## Key Files
- src/app.ts — Express setup and middleware
- src/routes/ — Route handlers (auth, users, tasks, admin)
- src/middleware/ — Auth, validation, error handling
- src/db/ — Prisma client and helpers
- prisma/schema.prisma — Database schema
EOF
```

## Step 6: Submit Tasks

### From CLI:

```bash
# Quick one-liner
tasksmith submit -p "Add input validation to POST /users" --project my-api

# From a YAML file
tasksmith submit -f tasks/add-auth.yaml

# Interactive mode (prompts for details)
tasksmith submit
```

### From a task file (drop in inbox):

```yaml
# .tasksmith/tasks/inbox/add-validation.yaml
template: ralph-loop
prompt: |
  Add Zod validation schemas to all route handlers in src/routes/users.ts.
  Each endpoint should validate request body, query params, and URL params.
  Return 400 with descriptive errors for invalid input.
project: my-api
model: sonnet
max_iterations: 5
params:
  validation_command: "npm test -- --grep users"
```

### From JSON (same thing, different format):

```json
{
  "template": "ralph-loop",
  "prompt": "Add a GET /api/health endpoint that returns system status",
  "project": "my-api",
  "model": "sonnet",
  "params": { "validation_command": "npm test" }
}
```

### From Discord:

```
@forge add rate limiting to POST /auth/login in my-api
```

## Step 7: Run the Engine

```bash
# From your project directory (auto-detects .tasksmith/)
cd ~/code/my-api
tasksmith run

# Or from anywhere with explicit workspace
tasksmith run --dir ~/.tasksmith
```

The engine will:
1. Watch the inbox for new tasks
2. Assemble context (SOUL.md + USER.md + CONVENTIONS.md + MEMORY.md + CLAUDE.md)
3. Invoke Claude Code with the compiled prompt
4. Run validation (e.g., `npm test`)
5. If tests fail, feed errors back and retry (Ralph Loop)
6. Notify you when done (Discord, Slack, ntfy, email, etc.)

## Step 8: Check Status

```bash
tasksmith status     # Queue counts, provider status, directive check
tasksmith templates  # List all available templates and their sources
tasksmith info       # Show workspace resolution and config details
tasksmith doctor     # Diagnose common issues
```

## Template Override Example

Say you want to customize the `ralph-loop` template for this project:

```bash
# Copy the built-in template to your project
mkdir -p .tasksmith/templates/ralph_loop
cp $(npm root -g)/tasksmith-cli/templates/ralph_loop/PROMPT.md .tasksmith/templates/ralph_loop/

# Edit it
vim .tasksmith/templates/ralph_loop/PROMPT.md
```

Now when you use `template: ralph-loop` in this project, it uses YOUR version.
The built-in is still there for other projects.

## Config Override Example

Your global config has notifications going to Discord. But for this project,
you also want Slack notifications:

```yaml
# .tasksmith/config/tasksmith.yaml (project-local)
communication:
  outbound:
    - provider: slack_webhook
      enabled: true
      config:
        webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx"
```

This merges with (doesn't replace) your global config.
