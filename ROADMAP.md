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
| **0.8.4** | ✅ Done | Input sanitization, MCP server mode, smart model routing, task DAG |
| **0.8.5** | ✅ Done | Validation worktree targeting, sanitizer local trust bypass, `medium` priority |
| **0.8.6** | ✅ Done | Worktree setup (copy node_modules), circuit breaker, diagnostics fix |
| **1.0.0** | ✅ Done | Unattended ops pivot — stripped CC overlap, Phase 2 differentiators |
| **1.0.1** | ✅ Done | Audit fixes, skill discovery, worktree isolation, approval sync, projectsDir, DAG ordering |

---

## v1.0.0 — The Pivot (Complete)

### Phase 1: Cut CC Overlap ✅
Removed WorktreeManager, permission wrappers, sandbox plugin, template system. Migrated to Claude Code Skills. ~1,985 lines removed.

### Phase 2: Strengthen Differentiators ✅
- ~~**Rich notifications**~~ — ✅ Cost, failure class, circuit breaker, contradictions in notify body.
- ~~**Cost tracking**~~ — ✅ Per-task, per-model, per-template, per-project cost aggregation in metrics plugin.
- ~~**Smart routing savings**~~ — ✅ "Actual cost vs all-opus cost" comparison in `tasksmith metrics`.
- ~~**GitHub issue intake**~~ — ✅ `tasksmith submit --from-github-issue <number>` via gh CLI.
- ~~**GitHub webhook provider**~~ — ✅ InboundCommsProvider with HMAC-SHA256, label-based filtering, comment triggers.
- ~~**Slack Events provider**~~ — ✅ InboundCommsProvider with signing secret verification, app_mention + message handling.
- ~~**DAG visualization**~~ — ✅ `tasksmith dag --graph <dagId>` outputs Mermaid flowchart.
- ~~**Task insights**~~ — ✅ `tasksmith insights` — model comparison, failure patterns, cost outliers, trends.
- ~~**REST API auth**~~ — ✅ Bearer token auth + sliding-window rate limiting. Closes known debt.
- ~~**Input sanitization**~~ — ✅ Done in v0.8.4.
- ~~**MCP server**~~ — ✅ Done in v0.8.4. 13 tools, 5 resources, stdio transport.
- ~~**Smart model routing**~~ — ✅ Done in v0.8.4.
- ~~**Task DAGs**~~ — ✅ Done in v0.8.4.

---

## v1.0.x — Security Remaining

- ~~**Discord bot channel scoping**~~ — ✅ Done. Guild + channel allowlist enforcement. Warns on startup if no restrictions configured.
- ~~**Human-in-the-loop approval gates**~~ — ✅ Done. Rule-based matching (template, params, source). Tasks parked in `pending_approval/`, operator notified. `tasksmith approve`/`reject` CLI. Auto-reject on timeout. Off by default.
- ~~**Prompt injection documentation**~~ — ✅ Done. SECURITY.md with threat model, sanitization details, permission modes, approval gates, channel scoping, 6 concrete prompt injection patterns (attacks, mitigations, residual risks), deployment scenario recommendations.

---

## v1.1.0 — Ecosystem (Next)

~~**Ship as Claude Code plugin**~~ — ✅ Done. `tasksmith cc-install` registers MCP server with Claude Code.

**GitHub Actions integration**
`tasksmith ci` — drops tasks from GitHub Actions workflows. Native PR comment trigger. `tasksmith watch` for auto-submitting labeled issues.

~~**Cost dashboard**~~ — ✅ Done. `tasksmith costs` with time-series, budgets, forecasting.

**Cloud sync**
Sync memory, task history, and config across machines. Encrypted. Optional.

**Context asset generation**
`tasksmith context generate` — scaffolds SOUL.md, USER.md, CONVENTIONS.md from a questionnaire. Smart defaults from detected project stack.

---

## Milestone: Dogfooding ✅

TaskSmith successfully dogfoods its own development as of v1.0.1.

- First batch: 7 audit bug fixes submitted as file_drop tasks, all passed on iteration 1
- Total cost: $0.78 across 7 tasks (~$0.11/task average)
- Validation: `cd /home/matt/w/tasksmith && npm run build && npm test` verified each fix
- Skill injection: all tasks used `ralph-loop` template via compiled prompt
- JSONL logs captured full execution trace for each task
- Discord webhook notifications fired on completion

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
- ~~**Validation worktree targeting**~~ — ✅ Done in v0.8.5. Validation commands with absolute `cd` paths now rewrite to the worktree path so engine validates Claude's actual changes.
- ~~**Sanitizer local trust bypass**~~ — ✅ Done in v0.8.5. Local sources (file_drop, CLI) bypass shell metacharacter stripping. Prevents `&&` from being stripped from validation commands.
- ~~**Worktree-aware execution after branch failure**~~ — ✅ Done. Engine creates worktrees with retry on branch conflict, logs explicit warning when falling back to no isolation.
- ~~**Graceful iteration resume**~~ — ✅ Done in v1.0.1. Engine writes checkpoints to active task YAML after each iteration. On restart, tasks resume from last completed iteration with cumulative cost preserved.
- ~~**Per-task cost aggregation**~~ — ✅ Done. `diagnostics.total_cost_usd` written to completed/failed task YAML. Feeds into metrics plugin.
- ~~**Resume pending tasks on restart**~~ — ✅ Done in v1.0.1. `engine.resumeActive()` scans active/ on startup, coordinator submits orphaned tasks to the worker pool.

### Observability & Human-Readable Logging

Collected during the CCPort Round 2 campaign (v0.8.4). Multiple runs burned significant tokens and API credits due to infrastructure failures (wrong validation target, corrupted commands, missing dependencies) that were invisible in the console output. The operator had to manually inspect task YAML files, grep logs, and cross-reference timestamps to diagnose issues that should have been immediately obvious.

**Problem statement:** The current logging is agent-centric (truncated Claude output, pass/fail booleans) rather than operator-centric. An operator watching the console cannot distinguish "Claude wrote bad code" from "the validation harness is broken" without digging into files. This wastes tokens on doomed iterations and delays diagnosis.

**Design: Three-layer observability**

1. **Console output (real-time, operator-facing)**
   - **Validation failure detail**: When validation fails, log the actual command that was executed, its exit code, and the first 5-10 lines of stderr. Current behavior only logs "validation failed" with no context. The operator should immediately see `"CHROMIUM_BIN not set"` or `"cd: too many arguments"` rather than having to reconstruct it.
   - **Failure classification**: Categorize each failure and tag the log line:
     - `[INFRA]` — validation command itself is broken (non-zero exit before any test runs, missing binary, bad syntax)
     - `[TEST]` — tests actually ran but some failed (exit code from test runner, with fail count)
     - `[BUILD]` — compilation/build step failed (distinguishable from test failures)
     - `[TIMEOUT]` — validation exceeded time limit
     - `[RATE-LIMIT]` — Claude hit API rate limit (already detected, but surface prominently)
   - **Contradiction detection**: When Claude's output claims "all tests pass" but engine validation fails, flag this explicitly: `[WARN] Agent reported success but engine validation failed — likely infrastructure issue, not bad code`. This is the single most expensive failure mode we hit — it burned 8 iterations per task.
   - **Periodic progress dashboard**: Every N minutes (configurable, default 5), print a compact status block:
     ```
     [status] 14:30 | Active: 3/3 | Completed: 8 | Failed: 2 | Queued: 4 | Cost: $18.42
       task-abc (iter 2/8, opus, $3.20)  task-def (iter 1/6, sonnet, $0.45)  task-ghi (iter 4/8, opus, $7.80)
     ```
   - **Warning escalation**: Critical warnings should be visually distinct (not just another `[pool]` line):
     - Missing project path → `[CRITICAL] No project path for "foglifter-client" — running WITHOUT worktree isolation`
     - Sanitizer rewrites → `[WARN] Sanitizer modified validation command — verify intent`
     - Worktree creation failure → `[CRITICAL] Worktree creation failed — falling back to main repo (no isolation)`

2. **Structured task log (per-task, machine-readable)**
   - Write a JSON log file per task: `~/.tasksmith/logs/task-{id}.jsonl`
   - Each line is a timestamped event: iteration start/end, validation command + full output, cost, model used, failure classification, Claude's result summary
   - Enables post-mortem analysis without parsing console output
   - Survives engine restarts (append-only)
   - Schema:
     ```jsonl
     {"ts":"...","event":"iter_start","task":"abc","iter":1,"model":"opus"}
     {"ts":"...","event":"cc_complete","task":"abc","iter":1,"turns":33,"cost":1.07,"result_summary":"..."}
     {"ts":"...","event":"validation","task":"abc","iter":1,"cmd":"...","exit_code":1,"stderr":"No binary for ChromiumHeadless...","classification":"INFRA"}
     {"ts":"...","event":"iter_end","task":"abc","iter":1,"passed":false,"failure_class":"INFRA"}
     ```

3. **Task YAML enrichment (post-mortem, human-readable)**
   - On task completion/failure, write a `diagnostics` section to the task YAML:
     ```yaml
     diagnostics:
       total_cost_usd: 12.45
       iterations_used: 4
       failure_class: INFRA  # or TEST, BUILD, TIMEOUT, RATE_LIMIT, NONE
       last_validation_cmd: "cd /path/to/worktree && ng build && ng test..."
       last_validation_exit_code: 1
       last_validation_stderr_head: "No binary for ChromiumHeadless browser..."
       agent_claimed_success: true
       contradiction_detected: true
     ```
   - This is the data the operator greps when reviewing a batch of completed/failed tasks

**Implementation priority (ordered by "would have saved us the most pain"):**
1. ~~Validation failure detail in console~~ — ✅ Done. Stderr head, exit code, and executed command logged per iteration.
2. ~~Failure classification + contradiction detection~~ — ✅ Done. `[INFRA]`/`[BUILD]`/`[TEST]`/`[TIMEOUT]` tags, agent-vs-engine contradiction warnings.
3. ~~Periodic progress dashboard~~ — ✅ Done. Configurable interval status line with active/queued/completed/failed counts.
4. ~~Structured task log (JSONL)~~ — ✅ Done. Per-task `logs/task-<id>.jsonl` with `task_start`, `iter_start`, `cc_complete`, `validation`, `iter_end`, `rate_limited`, `ejected`, `task_end` events.
5. ~~Task YAML diagnostics~~ — ✅ Done. `diagnostics` section written to completed/failed task YAML.

### Known Debt

- **Context window risk** — No truncation strategy if compiled prompts (directives + memory + task prompt) exceed model context limits. Large projects with extensive SOUL.md/CONVENTIONS.md could silently degrade Claude Code output quality.
- **Test coverage** — Only circuit breaker has unit tests (40 tests). No integration tests, no provider tests, no CLI tests. High-value targets: sanitizer, scheduler cron parsing, DAG cycle detection, config layering.

---

## Out of Scope (Intentionally)

- **Custom plugin registry** — npm IS the plugin manager. No plans to change this.
- **GUI/dashboard** — tasksmith.dev is a landing page, not a web app. CLI first.
- **Hosted execution** — TaskSmith runs on your machine, with your credentials, your code. That's the point.
- **Multi-user access control** — Solo developer / small team tool. Not an enterprise platform.
