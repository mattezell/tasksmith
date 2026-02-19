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

---

## v0.8.x — Security Hardening (Next)

The execution layer now has two complementary security controls: **permission modes** (v0.8.0) control Claude Code's tool access via CLI flags, and the **sandbox plugin** (v0.8.1) adds OS-level filesystem/network boundaries. These gaps remain:

- **Input sanitization** — Task params from external sources (Discord, REST API, file drop) pass through without validation. Allowlists for known params, type coercion, and length limits.
- **REST API authentication** — Port 8420 has no auth by default. Token-based auth with middleware.
- **Discord bot channel scoping** — Bot currently accepts commands from anyone in the server. Guild + channel allowlist enforcement.
- **Human-in-the-loop approval gates** — High-risk task types (e.g., `auto-merge` worktree strategy) should require explicit human confirmation before execution.
- **Prompt injection documentation** — Expand SECURITY.md with concrete examples and mitigation patterns.

---

## v0.9.0 — Power Features

**Task DAG (dependency workflows)**
Chain tasks with explicit dependencies. `task-b` starts only after `task-a` completes successfully. Failure propagates. Visualize with `tasksmith dag`.

**MCP server mode**
TaskSmith exposes itself as an MCP server — other agents can submit tasks, query status, and read memory. "Agents helping agents."

**Cost tracking**
Track token usage and estimated cost per task, per project, per template. `tasksmith metrics --cost`. Supports Anthropic API pricing table.

**Smart model routing**
Route tasks to models based on complexity signals: prompt length, template type, retry count. Cheap model first, escalate on failure.

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

## Out of Scope (Intentionally)

- **Custom plugin registry** — npm IS the plugin manager. No plans to change this.
- **GUI/dashboard** — tasksmith.dev is a landing page, not a web app. CLI first.
- **Hosted execution** — TaskSmith runs on your machine, with your credentials, your code. That's the point.
- **Multi-user access control** — Solo developer / small team tool. Not an enterprise platform.
