# TaskSmith Roadmap

## Version History

| Version | Status | Highlights |
|---------|--------|-----------|
| 0.1.0 | ✅ Done | Initial structure, types, config |
| 0.2.0 | ✅ Done | Task engine, Ralph Loop, memory, 10 notification providers |
| 0.3.0 | ✅ Done | Plugin system (npm-based) |
| 0.3.1 | ✅ Done | Renamed to TaskSmith |
| 0.4.0 | ✅ Done | Project-local mode, config layering, template chain, JSON support |
| 0.5.0 | ✅ Done | 6 bundled plugins (GitHub, Metrics, Docker, JIRA, Postgres, Proxmox) |
| 0.5.2 | ✅ Done | Clean shutdown, dynamic version, banner formatting |
| 0.5.3 | ✅ Done | Cloudflare plugin (7th bundled) |
| 0.6.0 | ✅ Done | Scheduled tasks (cron), semantic memory, automated stats |
| 0.7.0 | ✅ Done | Parallel execution (worker pool), git worktree isolation, multi-provider embeddings |
| 0.7.2 | ✅ Done | CLI --param flag, JSON inbound, NL param extraction, green field projects, security docs |
| **0.8.0** | ✅ Done | Permission modes (supervised/autonomous/yolo), `EngineConfig`, CLI `--mode` flag |
| **0.8.1** | ✅ Done | OS-level sandbox isolation, `addCommandWrapper` plugin hook |
| **0.8.2** | ✅ Done | Async concurrent execution, project-aware worktrees, rate limit auto-pause, CC output visibility, WSL2 bug fixes |
| **0.8.3** | ✅ Done | Auto-commit before merge, worktree reuse on restart, stale worktree cleanup CLI |
| **0.8.4** | ✅ Done | Input sanitization, MCP server mode (stdio, 8 tools, 2 resources) |

---

## v0.8.x — Security Hardening (Next)

The execution layer now has two complementary security controls: **permission modes** (v0.8.0) control Claude Code's tool access via CLI flags, and the **sandbox plugin** (v0.8.1) adds OS-level filesystem/network boundaries. These gaps remain:

- ~~**Input sanitization**~~ — ✅ Done in v0.8.4. Allowlist-based validation layer for all inbound providers. Trust-level system (local vs external), path traversal prevention, command injection protection, permission escalation blocking, type coercion, and length limits.
- **REST API authentication** — Port 8420 has no auth by default. Token-based auth with middleware.
- **Discord bot channel scoping** — Bot currently accepts commands from anyone in the server. Guild + channel allowlist enforcement.
- **Human-in-the-loop approval gates** — High-risk task types (e.g., `auto-merge` worktree strategy) should require explicit human confirmation before execution.
- **Prompt injection documentation** — Expand SECURITY.md with concrete examples and mitigation patterns.

---

## v0.8.x / v0.9.0 — Power Features (Next)

~~**MCP server mode**~~ ✅ Done in v0.8.4 — `tasksmith mcp` starts stdio MCP server with 8 tools and 2 resources. Any MCP client can submit tasks, check status, search memory.

**Smart model routing**
Route tasks to models based on complexity signals: prompt length, template type, retry count. Cheap model first, escalate on failure. Haiku for heartbeat/code-review, Sonnet for ralph-loop, Opus for complex multi-file refactors.

**Task DAG (dependency workflows)**
Chain tasks with explicit dependencies. `task-b` starts only after `task-a` completes successfully. Failure propagates. Each step in its own worktree. Visualize with `tasksmith dag`.

**Cost tracking**
Per-iteration cost is now logged from Claude Code's JSON output (v0.8.2). Remaining: aggregate cost per task, per project, per template. `tasksmith metrics --cost`. Supports Anthropic API pricing table.

---

## v1.0.0 — Ecosystem

**Template marketplace**
Curated community template registry at tasksmith.dev/templates. Pay-to-list for premium templates (monetization surface). Free tier for community contributions.

**Community template repo**
Official `@tasksmith-dev/templates` GitHub org. PR-based submissions, quality bar, automated testing.

**Cloud sync**
Sync memory, task history, and config across machines. Encrypted. Optional.

**CI/CD automation**
`tasksmith ci` — drops tasks from GitHub Actions, GitLab CI, or any webhook. Native PR comment trigger.

**Context asset generation**
`tasksmith context generate` — scaffolds SOUL.md, USER.md, CONVENTIONS.md from a questionnaire. Smart defaults from detected project stack.

---

## Milestone: Dogfooding

Use TaskSmith to develop TaskSmith.

- Submit feature tasks via Discord bot
- Validate with `tsc && npm test` in Ralph Loop
- PRs opened automatically via worktree `pr` strategy
- Nightly memory consolidation via heartbeat template
- Metrics dashboard on tasksmith.dev

Target: after v0.8.x security pass.

---

## v0.8.x Backlog — Known Improvements

Collected during the v0.8.2 development session. These are concrete, scoped items ready for implementation.

### Worktree Resilience

- ~~**Reuse existing worktrees on restart**~~ — ✅ Done in v0.8.3
- ~~**Stale worktree cleanup CLI**~~ — ✅ Done in v0.8.3

### Multi-Instance / Multi-Account

- **Multiple TaskSmith instances against the same repo** — Each instance uses its own Claude Code account (separate API keys / rate limits). All instances share the same git repo, relying on worktree isolation to prevent conflicts. Design questions:
  - Shared inbox vs. per-instance inboxes?
  - Lock file / claim protocol to prevent two instances from picking up the same task?
  - Instance ID in worktree branch names to avoid collisions (e.g., `tasksmith/inst-01/ralph-loop/task-xxx`)?
  - Shared vs. separate memory tiers?
  - Coordination via filesystem (lock files) vs. lightweight IPC?
- **Use case**: Multiply throughput by running N instances with N different Anthropic accounts, each burning their own rate limit independently. Combined with worktree isolation, all instances can safely target the same monorepo.

### Engine Improvements

- ~~**Auto-commit before merge**~~ — ✅ Done in v0.8.3
- **Worktree-aware execution after branch failure** — Currently if worktree creation fails, the task runs in the project directory directly (no isolation). Should either retry with a unique branch suffix or clearly warn that isolation is lost.
- **Graceful iteration resume** — Track iteration progress in the task YAML so restarted tasks can resume from the last completed iteration instead of starting over.
- **Per-task cost aggregation** — Sum `total_cost_usd` across all iterations for a task and write it to the completed task YAML. Feeds into the v0.9.0 cost tracking feature.

---

## Out of Scope (Intentionally)

- **Custom plugin registry** — npm IS the plugin manager. No plans to change this.
- **GUI/dashboard** — tasksmith.dev is a landing page, not a web app. CLI first.
- **Hosted execution** — TaskSmith runs on your machine, with your credentials, your code. That's the point.
- **Multi-user access control** — Solo developer / small team tool. Not an enterprise platform.
