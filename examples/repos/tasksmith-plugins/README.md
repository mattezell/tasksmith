# TaskSmith Plugins

## Official Plugins (Bundled)

These ship with `tasksmith-cli` — no separate install needed. Enable them in your config:

```yaml
# ~/.tasksmith/config/tasksmith.yaml
plugins:
  - github
  - metrics
  - docker
```

| Plugin | Description | Config Required |
|--------|-------------|-----------------|
| **github** | GitHub Issues/PR integration — auto-create issues on failure, comment results on linked issues, close on success | `token`, `owner`, `repo` |
| **metrics** | Task execution metrics — success rates, timing, model/template breakdown. Includes `tasksmith metrics` CLI command | None (works out of the box) |
| **docker** | Docker container isolation — run tasks in sandboxed containers with resource limits | Docker must be installed |

### GitHub Plugin

```yaml
plugins:
  - name: github
    config:
      token: ""                         # or set GITHUB_TOKEN env var
      owner: "your-username"
      repo: "your-repo"
      createIssuesOnFailure: true       # auto-create issues for failed tasks
      closeIssuesOnSuccess: true        # close linked issues on task success
      commentOnIssues: true             # comment results on linked issues
      labels: ["tasksmith", "automated"]
```

Link a task to an issue by adding `github_issue` to params:

```yaml
# task.yaml
template: ralph-loop
prompt: "Fix the login validation bug"
params:
  validation_command: "npm test"
  github_issue: 42                     # will comment results and close on success
```

### Metrics Plugin

```yaml
plugins:
  - name: metrics
    config:
      metricsFile: "metrics.json"      # relative to workspace
      retainDays: 90                   # how long to keep records
      trackModels: true                # breakdown by model
      trackTemplates: true             # breakdown by template
```

View metrics: `tasksmith metrics` or `tasksmith metrics --json`

### Docker Plugin

```yaml
plugins:
  - name: docker
    config:
      image: "node:22-slim"            # default container image
      mountProject: true               # mount project dir into container
      resourceLimits:
        cpus: "2"
        memory: "4g"
      autoCleanup: true                # remove containers after execution
      networkMode: "host"              # or "none" for full isolation
```

Override per-task:

```yaml
# task.yaml
params:
  docker_image: "python:3.12-slim"
  docker_network: "none"
```

## Community Plugins

Community plugins install via npm and are auto-discovered:

```bash
npm install tasksmith-plugin-my-thing
```

Or from the `@tasksmith-dev` scope:

```bash
npm install @tasksmith-dev/plugin-my-thing
```

### Creating a Plugin

```bash
tasksmith plugin create my-thing
```

This scaffolds a publishable plugin. See the [Plugin API docs](https://tasksmith.dev) for the full hook system, provider registration, and template bundling.

### Available Hooks

| Hook | Args | When |
|------|------|------|
| `beforeTaskExecute` | `(task)` | Before Claude Code runs |
| `afterTaskExecute` | `(result)` | After task completion |
| `onTaskFail` | `(task, error)` | After task failure |
| `onValidationFail` | `(task, output, iteration)` | Ralph Loop validation failure |
| `onMemoryStore` | `(entry)` | Before memory is stored |
| `onStartup` | `(config)` | Engine startup |
| `onShutdown` | `()` | Engine shutdown |

## Plugin Ideas

Looking to contribute? Here are some ideas:

- **JIRA** — bidirectional ticket sync
- **Postgres/SQLite** — task result storage in a database
- **Proxmox** — VM provisioning for isolated execution
- **Linear** — issue tracking integration
- **Sentry** — error reporting from failed tasks
- **Grafana** — metrics export for dashboards

Submit a PR to add your plugin here.
