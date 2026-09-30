---
name: dispatch
description: Use Agent Bridge from the current host agent to delegate scoped tasks to Z Code, Claude Code or Hermes, select a model and reasoning level, verify destination authorization and accept the result.
---

# Agent Bridge

The current host agent owns intake, worker/model selection, user authorization and acceptance. Installation in Codex, Claude Code, Z Code or Hermes does not transfer control to another dispatcher. Bridge provides execution; workers must not delegate recursively. Keep trivial tasks local.

## Dispatch

1. Read the authorized project instructions and current changes. Call `list_workers`; its `host` comes from explicit installation configuration, not trusted client identity. Installed means the runtime exists, not that inference is configured or authorized.
2. Choose one worker and call `list_models` for the absolute project path. Reuse the catalog within the task. Discovery may query a provider catalog but sends no inference prompt; local-config entries do not prove entitlement. Select exact worker/provider/model/effort yourself, respecting explicit user choices. No silent fallback, invented price/quota, or extra router-model call. Use `provider-default` when effort controls are unverified.
3. Write a short task card: objective, acceptance criteria, allowed edits, source entry points, changes to preserve and checks. Declare existing relative `read_scope` paths; `[]` means no source reads and `["."]` means project-wide. Relevant project instructions and task metadata remain readable. Never forward credentials, the full conversation or unrelated content. Use `plan` for analysis and `edit` for authorized changes.
4. Call `prepare_dispatch` with worker/project/task/provider/model/effort/selection_reason/read_scope/mode and optional timeout. It locally resolves the actual endpoint and binds the parameters for 30 minutes without inference. Examine its destination and scope; a worker name such as Claude does not identify the inference provider.
5. Verify direct user authorization covers the actual provider/endpoint, project, content scope and mode. Reuse explicit authorization already given; ask only for a missing or expanded scope, explaining the destination and content. Installation, credentials, plan mode and a prepared reference are not approval. Do not evade host approval or retry a rejected action through another path.
6. After authorization, call `dispatch_task` with the unchanged selection, `prepared_ref`, its actual `endpoint`, and a unique `request_id`. Give a short operational `selection_reason`, not private chain of thought. Changed scope, host, runtime or destination requires new preflight and authorization review.

Tool limits and declared paths are instructions, not an OS sandbox. A worker can send source it reads to its inference provider even in plan mode. Retain host permissions. Worker interaction/approval requests are blockers; never auto-approve them. Claude handles files only; the host runs its tests. Hermes uses an isolated profile with its configured zai route; Z Code uses app-server. Credentials remain in the worker's existing configuration and process memory.

## Collect and accept

- Keep the absolute job path. Use `task_status` with a bounded wait (up to 30 seconds), then `task_result`. These read local artifacts without inference; avoid frequent polling or raw transcripts.
- A lost dispatch response: resend the same request ID and unchanged parameters. `reused: true` returns the original job without new inference, including failed/cancelled jobs. A changed request conflicts; do not automatically resubmit. Preserve IDs while `.ai/tasks/` records exist. This is deduplication, not a cache against changed source.
- `orphaned`: cancel the surviving worker and confirm it ended before another writer. `interrupted`: inspect partial edits and saved results. `recover_result` recovers an ended job's saved result without inference; it cannot override cancellation or timeout. Cancellation does not roll back edits.
- `ready_for_review` means the worker returned. Inspect diff, verify actual worker/provider/model/effort and run appropriate checks before accepting. Do not edit worker files concurrently; use isolated checkouts for concurrent writers.
- On failure, inspect the error and verified progress; the host decides whether to retry, change selection or take over. Follow-ups contain only remaining work. Token counters are not subscription quota or a measured bill.
- One project lock spans all worker adapters. `.ai/zcode-worker.lock` is a legacy filename; it does not lock other apps. Keep `.ai/` prompts/logs/results private and uncommitted; do not automatically change ignore rules.

If MCP is unavailable, reload the host after installation. CLI fallback is `../../scripts/bridge.mjs` relative to this Skill; it requires the same prepare/authorization/submit sequence and explicit selection.
