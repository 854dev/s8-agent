# s8 Distributed Multi-Agent Execution Plan

- Status: **Proposed — not implemented**
- Target: `854dev/s8-agent`, existing `main` architecture
- Date: 2026-10-21
- Goal: one orchestrator (Manager) and three independently hosted Workers, with durable task execution and bounded agent-to-agent conversations.

## 1. Scope and non-goals

Extend the **existing** Manager / Projectman / resident Worker / Pi session architecture instead of replacing it with a new agent framework. Preserve single-host operation by default.

**Acceptance goals**
1. Manager can dispatch an approved Projectman task to an explicitly addressed remote Worker.
2. Three workers on separate hosts can receive assignments, claim exactly one current run, execute, and report to Manager without a shared filesystem.
3. Workers can ask each other questions and receive replies without allowing unapproved task delegation.
4. A worker restart, network partition, and broker redelivery do not cause two concurrent authorized executions or lost terminal reports.
5. Cross-host dependent code tasks can import verified Git artifacts; non-code outputs use artifact references.
6. Existing local workflows, approval boundaries, CLI, Telegram and web UI continue to work.

**Non-goals (initial release):** Kubernetes, autonomous peer-to-peer task creation, shared writable workspaces/NFS, distributed Pi session migration, high-availability NATS/PostgreSQL, arbitrary shell commands executed from incoming network messages.

## 2. Existing code and integration seams

| File | Existing responsibility | Required modification |
|---|---|---|
| `pi/extensions/manager.ts` | `run_worker`, `set_worker_mode`, Projectman polling, local Manager inbox | Route remote assignments through transport; list remote status; ingest remote completion notifications |
| `pi/lib/agent/resident.mjs` | 15s loop; local file inbox/mode/state/heartbeat; picks ready tasks | Inject assignment source; durable receipt; publish heartbeat; retain local fallback |
| `pi/lib/agent/work.mjs` | local tmux + worktree, imports dependency patches | Continue **locally on target Worker**; consume remote artifact refs |
| `pi/lib/agent/worker-run.mjs` | Projectman claim and report with persisted request IDs/run IDs | Retain ownership protocol; attach artifact references and report delivery events |
| `pi/extensions/worker.ts` | role/tool guard, claim/report, periodic `stillActive` | Register authorized message tools and safe inbox injection |
| `pi/lib/development/workspace.mjs` | worktrees and patch import | Support Git commit artifact import with provenance/checks |
| `pi/lib/development/outbox.mjs` | persisted result, Projectman/Manager/Telegram delivery | Event notification after Projectman acceptance; independent retry receipts |
| `pi/lib/manager/inbox.mjs` | local durable manager inbox | Bridge network events to same Pi follow-up message contract |
| `pi/lib/config/s8-config.mjs` | strict config validation | Add optional `cluster` config, node IDs and transport settings |
| `pi/bin/s8.mjs` | worker service entrypoint, PID lock, lifecycle | Initialize/shutdown transport in worker service |
| `pi/lib/agent/finish.mjs` | manual stopped-run recovery, local tmux check | For remote runs require verified remote lease/revocation, not only local process status |
| `frontend/src/features/projectman/WorkersPanel.tsx` | Worker UI | Display node/online/assigned/heartbeat after backend exposes data |

Important observations from the existing implementation:
- `queueInstruction()` writes local `.s8-runtime/workers/<id>/inbox/*.json`; it cannot reach remote hosts.
- `residentTick()` removes an instruction before `start(uid)`; failed start currently loses that instruction. Fix the durability boundary for remote delivery.
- `reportWork()` writes `.s8-runtime/runs/<runId>/outbox.json`; Projectman should remain the authoritative workflow status; the report event is a notification, not a second source of truth.
- `importDependencies()` currently relies on local patch files; this will not work across servers without artifact transport.
- `stillActive()` currently tolerates Projectman lookup errors; for distributed operation add a bounded offline execution policy to avoid prolonged split-brain.
- Existing manual `finishStoppedRun()` checks only local tmux, unsuitable as proof that a remote Worker stopped.

## 3. Target topology

```text
Telegram / Web console
        |
  Server 0: s8 Manager + Scheduler + UI
        |          |
        |          +--> Projectman / PH-CMS (authoritative workflow)
        |
    NATS JetStream (durable delivery + routing)
      /      |      \
 Worker A  Worker B  Worker C  (separate machines)
  resident   resident   resident
   -> Pi      -> Pi      -> Pi
   -> repo    -> repo    -> repo
        \      |      /
        Git remote + artifact store
```

Use private host networking (e.g. WireGuard/Tailscale), authenticated NATS with per-node publish/subscribe permissions, and no publicly reachable Worker control ports. Server 0 is initially a **single point of failure**; back up stream state and document restore steps. Do not run an extra authoritative task database: continue using Projectman. Durable chat history may be backed by JetStream with bounded retention and/or an indexed store, but must not mutate Projectman task state by itself.

Each machine runs the same repository revision and has its **own** `.env`, `s8-config.yml`, `.s8-runtime`, workspace, and Pi sessions. Worker tasks are launched by the local `startWork()`; Manager must not attempt remote tmux operations.

## 4. Message model and delivery semantics

Create `pi/lib/transport/types.ts`, `local.mjs`, `nats.ts`, `factory.mjs`. Prefer a schema-validated versioned envelope:

```json
{
  "version": 1,
  "messageId": "uuid",
  "type": "task.assign",
  "from": "manager",
  "to": "worker-a",
  "taskId": "TASK_UID",
  "runId": null,
  "conversationId": "uuid",
  "replyTo": null,
  "sentAt": "2026-10-21T00:00:00Z",
  "expiresAt": "2026-10-22T00:00:00Z",
  "payload": { "uid": "TASK_UID" }
}
```

Types:
- Control: `task.assign`, `task.cancel.request`, `worker.mode.set`
- Conversation: `agent.question`, `agent.reply` (never automatically equivalent to new tasks)
- Observation: `worker.heartbeat`, `task.started`, `task.progress`, `task.completed`, `task.failed`

Define `AgentTransport` with `publish`, `subscribe`, `ack/nak`, `close`; do **not** pretend that a generic `send()` Promise means the Worker started the task. Distinguish **broker accepted**, **recipient durably enqueued**, **task claimed**, **run finished** as separate receipts.

Suggested subjects (scope by cluster and node): `s8.v1.command.worker-a`, `s8.v1.message.worker-a`, `s8.v1.event.manager`, `s8.v1.presence.worker-a`. Configure durable pull consumers per Worker and bounded retention/size; do not mix unbounded chat history with command stream. Heartbeats can use Core NATS; commands, questions and final reports require durable handling.

**Receiver sequence:** validate schema, authenticity, authorization, TTL and idempotency key → durably persist local inbox receipt → ACK broker → asynchronously handle message. On crash between receipt and ACK, duplicate delivery is ignored based on `messageId`; on crash after ACK, local inbox is retried. Keep processed receipt history with bounded TTL. If local persist fails, NAK/retry. Alternatively use an explicit transaction-capable store; do not ACK then write.

**Security:** transport identity binds sender ID; do not trust arbitrary `from` in payload. Manager only can assign/cancel/change mode. Workers may send question/reply and their own run events. Validate target, max message bytes, rate and hop/depth limits; redact secrets and avoid sending raw repository contents in messaging.

## 5. Task ownership, lease and failure policy

Projectman is the final authority for workflow state, grant, revision and claimed `runId`. A NATS assignment is only a *request to attempt claim*, not permission to bypass preflight.

For cluster operation, add an explicit lease/fencing policy to Projectman (or a centralized atomic lease record with comparable enforcement):
- claim is conditional on `ready`, approved plan, grant, assignment and expected revision; only one current `runId`;
- lease has `workerId`, `nodeId`, `runId`, expiry, incrementing fencing generation; renew periodically;
- every report and security-sensitive transition checks current run and fencing generation;
- before reassignment, revoke old generation atomically; late reports are rejected;
- worker pauses new destructive tool operations if lease renewal/ownership checks fail beyond a short configurable grace period; do not treat network errors as unlimited permission;
- process liveness, lease expiry and actual cancellation are distinct concepts.

Keep current Projectman workflow API compatible where possible; gate new lease contract behind feature configuration until server support and migration are available. The first prototype may rely on existing exclusive Projectman claim **without automatic failover**. Do not advertise automatic safe reassignment until lease/fencing integration passes tests.

For `finishStoppedRun()`, remote mode must verify the central run owner and revoke/expire its lease; a local tmux check on Server 0 is not enough.

## 6. Pi session messaging

Register `agent_message` in `pi/extensions/worker.ts` with explicit role whitelist/profile updates. Initial actions: `question`, `reply`, optional `inbox_list`/`message_status`. Message delivery should not start an arbitrary new Pi session or interrupt a running tool:
1. Route message to the target Worker daemon's persistent inbox keyed by `workerId`, `taskId`, `sessionId`.
2. Maintain a one-at-a-time delivery lock per Pi session.
3. Inject via Pi-supported `sendMessage(..., { deliverAs: 'followUp' })` at a safe idle/turn boundary, or the actual supported session control API verified against the installed Pi version.
4. Mark consumed only after durable injection acknowledgement; on restart, replay idempotently or expose a deduplicated unread inbox.
5. Bound token/context growth: summarize old exchanges, set reply timeouts and cross-agent request quotas.
6. For offline/busy target, return queued/unavailable state. Never claim a reply has been read if it has only been accepted by the broker.

Define explicit conversation ownership and correlation IDs; `agent.question` does not confer Projectman task creation or tool execution privileges. Avoid loops where A asks B who asks A indefinitely.

## 7. Cross-host artifacts / Git

Keep `prepareWorktree()` and local patch workflow for single-host mode. For remote mode:
- create a task-specific branch and commit(s) in Worker's local clone;
- push to a restricted remote namespace, e.g. `refs/heads/s8-runs/<runId>`;
- publish artifact metadata: `repo`, `baseCommit`, `commitSha`, `runId`, `taskId`, validation/check results;
- dependent Worker fetches immutable SHA, verifies base/provenance and imports changes in declared dependency order;
- ensure failed fetch, conflicts, or incomplete verification become visible task errors, not silent success;
- never force-push shared integration branches; use protected merge/PR workflow.
- upload binary/log/non-Git artifacts to S3-compatible storage with checksums, bounded size and access controls; messages carry pointers only.

Do **not** mark a task available to downstream dependencies until its artifacts are published and references are persisted with the Projectman report. For work without a Git repository, allow report-only workflows.

## 8. Configuration and operational layout

Proposed **illustrative** per-host `s8-config.yml` extension (final names validated by implementation):

```yaml
cluster:
  enabled: true
  nodeId: worker-a
  role: worker # manager | worker
  transport: nats
  natsUrl: nats://10.0.0.10:4222
workers:
  - id: worker-a
    mode: passive
projectman:
  apiUrl: https://internal.example/api
```

Secrets in `.env` or files with restrictive permissions, not YAML. Add `cluster` to strict top-level schema, validate role, ID and private URL; reject incompatible combinations early. Default `enabled: false` preserves legacy behavior. Single manager: worker IDs must be globally unique across nodes. Only Manager hosts Telegram gateway/scheduler where appropriate, to avoid duplicate cron and bot polling. Extend service CLI with `service worker ID` transport startup/shutdown without changing current single-host command semantics.

Ensure version compatibility at startup with a protocol version/capability handshake; rolling deployment of manager and workers should reject incompatible commands safely.

## 9. Implementation milestones (execute in order)

### P0 — Contract and local adapter

**Files:** new `pi/lib/transport/{types.ts,local.mjs,nats.ts,factory.mjs}`, `pi/lib/config/s8-config.mjs`, `s8-config.example.yml`, transport tests.

Tasks:
- [ ] Document schemas and message validation, authorization matrix, subjects, ACK semantics.
- [ ] Add optional cluster config; keep local default unchanged.
- [ ] Extract `queueInstruction` + Manager inbox behind transport adapters.
- [ ] Add local adapter contract tests and NATS integration test fixture.

**Done when:** existing `npm test`/repo test suites still pass; local Manager–Worker flow unchanged; invalid messages/config rejected.

### P1 — Remote dispatch MVP (no automatic failover)

**Files:** `pi/extensions/manager.ts`, `pi/lib/agent/resident.mjs`, `pi/bin/s8.mjs`, Manager inbox bridge, new integration tests.

Tasks:
- [ ] Dispatch approved `run_worker(workerId)` via NATS to remote durable inbox.
- [ ] Keep local `startWork()` execution on Worker host.
- [ ] Deliver status/heartbeats and show transport/claim/run distinctions.
- [ ] Forward accepted Projectman completion to Manager inbox via event bridge.
- [ ] Handle duplicate, expired, malformed and unauthorized commands.
- [ ] Add explicit offline/recovery procedure; defer automated reassignment.

**Done when:** real 1 Manager + 3 Workers can dispatch and report across four hosts; restarting Manager or NATS causes no lost command or duplicated active run; original local workflow still works.

### P2 — Remote code/result artifacts

**Files:** `pi/lib/development/workspace.mjs`, `outbox.mjs`, `worker-run.mjs`, artifact helper module and tests.

Tasks:
- [ ] Publish immutable Git commits and run metadata, fetch dependencies by SHA.
- [ ] Define handling for branch collisions, private repositories, credentials and conflict resolution.
- [ ] Store and retrieve non-Git files as checksummed artifacts.
- [ ] Ensure output is published *before* reporting upstream task ready for dependencies.

**Done when:** Worker B can implement a dependent task based on Worker A's committed result on another machine; integration tests verify conflicts and unavailable artifacts.

### P3 — Agent-to-agent conversation

**Files:** `pi/extensions/worker.ts`, Worker profile allowlist/system prompt, new inbox/session bridge, messaging tests.

Tasks:
- [ ] Register scoped `agent_message(question/reply)` and delivery statuses.
- [ ] Queue while Pi busy; inject only at safe turn boundary.
- [ ] Add bounded cross-agent messages, timeout, loop prevention and audit trail.
- [ ] Verify worker cannot assign task or bypass approval through chat text.

**Done when:** A asks B, B responds in correct conversation, A sees the answer in its task context, and no existing active tool turn is corrupted.

### P4 — Safe remote recovery and operational UI

**Files:** Projectman lease API/schema (if needed), `worker-run.mjs`, `finish.mjs`, `WorkersPanel.tsx`, operations docs.

Tasks:
- [ ] Implement atomic lease + fencing and controlled cancellation/revocation.
- [ ] Restrict recovery when node is partitioned or status unknown.
- [ ] Show host, mode, heartbeat, queue, current run, broker connectivity and last error.
- [ ] Log message IDs, task/run IDs, node IDs, delivery latency, token usage and retry metrics.
- [ ] Provide Tailscale/WireGuard, credential rotation, backup and disaster restore guide.

**Done when:** worker crash/partition/fencing test proves at most one authorized run and late result rejection; operator can diagnose and recover stopped tasks without relying on local tmux checks.

## 10. Testing matrix

| Scenario | Expected outcome |
|---|---|
| No `cluster` configuration | Legacy local behavior unchanged |
| Manager dispatches one approved UID to A | A durably receives, claims and runs; Projectman records ownership |
| Duplicate NATS delivery | Same message not executed twice |
| Crash after inbox write but before ACK | Redelivery deduplicated, command retained |
| Crash after ACK but before local launch | Durable inbox restarted and processed |
| Busy Worker receives question | Queued; delivered after safe boundary, no nested Pi turn |
| Unauthorized Worker assigns task | Rejected and audited |
| A finishes, B requires its code | B fetches verified SHA and imports safely |
| Artifact upload fails | No false completed/dependency-ready status |
| Broker unavailable | New dispatch visibly fails/queues; no silent loss |
| Worker loses Projectman connectivity | Stops privileged operations after grace; no automatic split brain |
| Remote Worker still running; Manager tries finish | Operation refused until ownership revoked |
| Three Workers race for a ready task | One authoritative claim wins; other workers stand down |
| Mixed protocol versions | Safe rejection with actionable error |

Run unit tests (Node test runner per existing `pi/test`), mocked Pi session tests, local multi-process integration tests, then four-machine smoke tests. Record the actual verification commands and outputs in PRs. Do not mark work complete solely from static review.

## 11. Deployment and rollback

1. Back up Projectman and s8 runtime state; record existing branch SHA and config.
2. Deploy P0 local-compatible version everywhere with cluster disabled; run regression tests.
3. Start private NATS and enable one Worker as passive; prove single remote UID end-to-end.
4. Enable other two Workers; run duplicate/restart tests; then activate cross-agent messaging.
5. Keep Manager-only Telegram/scheduler ownership and retain network ACLs.
6. Roll back by disabling cluster routing and draining remote commands before returning to local mode; do not move an in-progress run without explicit recovery and artifact reconciliation.

**Decision log before implementation:**
- Choose NATS hosting, durable retention limits, credentials and backups.
- Confirm Projectman can store lease/fencing and artifact metadata; otherwise specify additive API changes.
- Select Git push permissions and artifact store, plus retention/purge policy.
- Verify exact installed Pi version's safe session injection API.
- Define whether `active` auto-polling can be enabled in distributed mode; start with `passive` to avoid unintended competition.

## 12. Recommended first pull request

Implement **P0 only**, including a local adapter, protocol schema, NATS adapter behind feature flag, config validation, and tests. No modifications to Projectman state machine, no automatic failover, and no change to the default CLI behavior. Follow with separate reviewable PRs for P1–P4; each must include backward compatibility and rollback notes.
