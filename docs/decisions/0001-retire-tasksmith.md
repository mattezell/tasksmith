# 0001: Retire TaskSmith in favor of Hermes Agent

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

TaskSmith was a standalone unattended operations layer for Claude Code. It accepted work from file drops, chat integrations, webhooks, REST, MCP, CI, and schedules; queued that work; ran agents in isolated worktrees; validated their output; retried failures with validation feedback; recorded task history and costs; sent notifications; and could prepare branches for review.

That system was valuable when the agent runtime did not provide durable orchestration primitives. It is now a parallel control plane beside Hermes Agent, which creates duplicated state, configuration, integration code, security boundaries, and operational maintenance.

Hermes now provides the native systems needed for this role:

- **Kanban** provides a durable task board, task dependencies, worker profiles, comments, audit history, reruns, and restart-safe coordination.
- **Cron** provides durable scheduled runs, project-aware working directories, skills, scripts, chained outputs, and delivery.
- **Webhooks** turn authenticated external events into filtered agent runs or direct deliveries.
- **The verification ledger** records structured evidence about commands and outcomes.

These capabilities share Hermes profiles, skills, memory, gateway delivery, and operational state. Keeping TaskSmith as a second orchestrator would require maintaining adapters between overlapping systems without creating a distinct product advantage.

One important gap remains: Hermes records verification evidence, but task completion does not yet use that evidence to gate a Kanban task's transition to `done` or feed failed validation into bounded retries.

## Decision

Retire TaskSmith in favor of Hermes Agent's native orchestration systems.

TaskSmith will receive no further feature development and must not be recommended for new deployments. The repository remains available as a historical reference while existing TaskSmith workloads are migrated to Hermes Kanban, cron, webhooks, and verification evidence.

The migration boundary is capability-based rather than a direct configuration conversion:

| TaskSmith responsibility | Hermes replacement |
| --- | --- |
| Durable task queue and worker coordination | Kanban |
| Dependency workflows and handoffs | Kanban task links, comments, and worker profiles |
| Scheduled tasks | Cron |
| Event-driven intake | Webhook subscriptions |
| Run evidence and validation records | Verification ledger |
| Notifications and result delivery | Hermes gateway delivery |

TaskSmith will not become a compatibility wrapper around Hermes. A wrapper would preserve two public models and their maintenance burden while hiding the native systems operators need to understand.

## Salvaged design

The validated-retry pattern is the part of TaskSmith that should survive:

1. Run a worker attempt.
2. Execute or inspect explicit validation evidence.
3. Permit completion only when the requested validation is green.
4. On failure, return bounded command output to the next attempt as repair context.
5. After the retry limit, block the task with the last evidence attached instead of marking it done.

That pattern has been proposed upstream in [NousResearch/hermes-agent#70806](https://github.com/NousResearch/hermes-agent/issues/70806), "verified completion with failure-fed retries." The issue is open and awaiting a maintainer decision. This decision record does not claim that Hermes currently implements the pattern or that the proposal will be accepted unchanged.

## Alternatives considered

### Continue maintaining TaskSmith

Rejected. The product would duplicate Hermes orchestration and require continued maintenance of queues, schedulers, integrations, state, security controls, and agent-runtime compatibility.

### Reduce TaskSmith to a thin Hermes wrapper

Rejected. This would retain a second interface and migration surface without retaining an independent capability boundary.

### Freeze TaskSmith and migrate the distinctive pattern upstream

Accepted. It removes duplicate infrastructure while preserving the validated-retry design in the system that now owns orchestration.

## Consequences

### Positive

- Hermes becomes the single operational control plane for durable agent work.
- Scheduling, event intake, coordination, evidence, skills, memory, and delivery can evolve together.
- TaskSmith-specific integrations and state no longer need parallel maintenance.
- The strongest TaskSmith idea has a concrete upstream proposal rather than remaining trapped in retired code.

### Negative

- Existing TaskSmith users must translate workloads; there is no automatic or drop-in migration.
- Historical documentation and examples remain useful as reference but no longer describe a recommended deployment.
- Verified Kanban completion is not yet available upstream. Until that gap is resolved, operators must require explicit verification in task instructions and review evidence before treating completion claims as authoritative.
- Upstream maintainers may change or decline the proposal in issue #70806.

## Non-goals

This decision does not:

- delete the source or its history;
- unpublish the npm package;
- archive the GitHub repository as part of this change;
- provide an automated TaskSmith-to-Hermes migration tool; or
- represent issue #70806 as implemented or accepted.

## References

- [Hermes Kanban documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
- [Hermes cron documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- [Validated completion proposal: NousResearch/hermes-agent#70806](https://github.com/NousResearch/hermes-agent/issues/70806)
