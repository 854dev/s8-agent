> 2026-10-22 실행 정책 변경: 워커는 작업 디렉터리에서 직접 실행한다. 아래 초기 구현의 worktree 필수·Git 루트 검사·저장소 전체 보호 경로 검사·원격 매핑 필수·자동 의존 산출물 반영·자동 Git 게시·claim 전/보고 후/조사 도구 차단·소유권 조회 실패 시 도구 차단·검증명 누락 시 자동 실패 정책은 폐기했다. 실행·검증·Git·동시 수정 조정·완료 판단은 시스템 프롬프트와 매니저 지시로 처리한다. 선택적 파일 전달 실패는 완료 상태를 바꾸지 않는다. Projectman 서버의 상태·revision 프로토콜과 통신 인증·입력 형식 검사는 유지한다. 실제 .env·비밀정보 보호와 .env.example 동시 갱신은 AGENTS.md에 따른다. 현재 실행법은 README를 따른다. 기존 worktree 변경은 자동 이동하지 않는다.

# s8 Distributed Multi-Agent Execution Plan

- Status: **P0–P4 implementation and local verification complete; actual multi-machine deployment verification pending**
- Target: `854dev/s8-agent`, existing `main` architecture
- Updated: 2026-10-22
- Goal: one Manager coordinates local and remote Workers over lightweight bidirectional connections, using Projectman for task state and Pi sessions for conversation history.

## 1. Agreed scope and non-goals

Extend the existing Manager / Projectman / resident Worker / Pi / tmux architecture. Support one machine running both Manager and Workers, separate Worker machines, and mixed deployments. A machine does not have an exclusive Manager-or-Worker role.

**Acceptance goals**
1. Manager dispatches an approved Projectman UID to an explicitly addressed Worker; the Worker checks approval and claims before executing.
2. Workers initiate questions, progress/findings, blocker reports, results, and collaboration proposals to Manager.
3. Manager always mediates collaboration. Workers cannot address or directly message other Workers.
4. Manager can request the same research/review from multiple Workers and correlate their individual responses.
5. Projectman task state remains authoritative; Pi session records hold delivered conversations. Do not introduce a duplicate conversation database.
6. Offline delivery is not guaranteed. Disconnected, rejected, pending and uncertain requests are visible instead of reported as successful.
7. Existing local workflows, approval boundaries, CLI, Telegram and web UI continue to work.
8. Cross-host dependent code tasks can consume verified Git artifacts; other outputs use artifact references when required.
9. README documents actual setup and execution for each agent role and deployment layout before implementation is considered complete.

**Non-goals (initial release):** NATS/JetStream or another broker, durable network-message queues, guaranteed offline/restart replay, direct Worker-to-Worker messaging, autonomous task delegation, automatic failover/reassignment, Kubernetes, shared writable workspaces/NFS, distributed Pi session migration, arbitrary shell commands from network payloads, and a new authoritative task database.

Existing Projectman report outbox persistence is retained: relaxing network notification delivery does not relax authoritative task reporting.

## 2. Existing code and integration seams

| File | Existing responsibility | Required modification |
|---|---|---|
| `pi/extensions/manager.ts` | `run_worker`, mode changes, Projectman polling, Manager inbox | Address connected Workers; receive questions/results; mediate collaboration and parallel requests |
| `pi/lib/agent/resident.mjs` | Local inbox/mode/state/heartbeat and task selection | Own Worker WebSocket client, registration, reconnect, status and request tracking |
| `pi/lib/agent/work.mjs` | Local tmux + worktree and dependency imports | Execute on target host; consume verified remote artifact references |
| `pi/lib/agent/worker-run.mjs` | Projectman claim/report with persisted request/run IDs | Keep ownership checks and report recovery; attach artifacts and send best-effort notifications |
| `pi/extensions/worker.ts` | Tool guard, claim/report, `stillActive` | Expose Manager-only communication tool and safe session delivery |
| `pi/lib/development/workspace.mjs` | Worktrees and patch import | Resolve host-local repository paths and verified Git dependency imports |
| `pi/lib/development/outbox.mjs` | Persisted Projectman/Manager/Telegram report delivery | Preserve authoritative report retry; distinguish optional network notification failure |
| `pi/lib/manager/inbox.mjs` | Local durable Manager inbox | Bridge connected-session messages without adding a durable network queue |
| `pi/lib/config/s8-config.mjs` | Strict per-host settings | Validate optional communicator settings, endpoints and local Worker identities |
| `pi/bin/s8.mjs` | Service entrypoints, PID locks | Add communicator service lifecycle; initialize client in resident Worker |
| `pi/lib/runtime/{services,runtime}.mjs` | tmux services and Workers | Start one communicator window alongside Manager; retain local Worker startup |
| `pi/lib/agent/finish.mjs` | Stopped-run recovery using local tmux | Refuse unsafe remote recovery when actual owner/termination is unknown |
| `frontend/src/features/projectman/WorkersPanel.tsx` | Worker UI | Show connected remote and local Workers, pending requests and errors |
| `README.md` | Setup, execution and operations | Document every supported role/layout and its actual commands |

Existing observations:
- `queueInstruction()` writes local files and cannot reach another host. Keep legacy behavior when communication is disabled.
- `residentTick()` removes a local instruction before `start(uid)`; report launch failures explicitly and review this boundary rather than inheriting silent loss.
- Projectman completion is authoritative; a completion message to Manager is only a notification. Manager can reconcile by querying Projectman.
- Dependency patch paths and repository paths on Manager are not automatically valid on another host.
- A local tmux check cannot establish that a remote run has stopped.

## 3. Topology and process ownership

```text
Telegram / Web console
          |
Manager host: Manager Pi <-> communicator (WebSocket server)
                              ^        ^        ^
                              |        |        |
                      resident A  resident B  resident C
                         <-> Pi      <-> Pi      <-> Pi
                       local or remote Worker processes

All task participants -> Projectman API
Workers -> Git remote / artifact storage as needed
```

Workers initiate authenticated connections to the Manager endpoint. No inbound Worker control ports or remote tmux operations are needed. Every Worker-originated agent message targets Manager, even when requesting another Worker's help. Manager chooses whether to answer, ask the user, dispatch a review, summarize results, or reject a proposal.

The communicator is a separate Node.js process so it remains responsive while Manager Pi runs tools. Each resident Worker embeds its own client; do not require an extra client process/window. Both sides bridge messages into the correct Pi session at a supported safe boundary.

Heartbeat, registration and routine status updates are handled by code without invoking a model. Questions and decisions that need reasoning are delivered to Manager Pi.

Use loopback for a local-only deployment and a private reachable interface for remote Workers. Authenticate even on a private network; use WSS when network protection does not provide the required confidentiality. Manager is initially a single coordination point; disconnection does not itself revoke an existing Projectman run.

Each remote machine has its own `.env`, `s8-config.yml`, runtime directories, authentication and repository clones at the same s8 revision. On one machine, a single checkout can host Manager and multiple Workers; distinguish Worker IDs, Pi sessions and task worktrees.

## 4. Lightweight message contract

Add a small transport module, for example `pi/lib/communication/{protocol,server,client,session-bridge}.mjs`, consistent with the repository's runtime module conventions. Keep networking separate from task logic; no broker SDK is required.

Illustrative envelope:

```json
{
  "version": 1,
  "id": "unique-message-id",
  "requestId": "logical-request-id",
  "type": "task.run",
  "from": "manager",
  "to": "a",
  "taskUid": "TASK_UID",
  "runId": null,
  "sessionId": null,
  "replyTo": null,
  "expiresAt": "2026-10-23T00:00:00Z",
  "payload": { "uid": "TASK_UID" }
}
```

Initial message families:
- Connection: registration/capability handshake, heartbeat and `worker.status`.
- Manager control: `task.run`, `worker.mode.set`.
- Agent interaction: `agent.request`, `agent.reply`, `agent.notice`, `agent.proposal`.
- Receipts/results: `request.accepted`, `request.rejected`, `request.result`, request status query/response.
- Run notifications: `task.started`, `task.completed`, `task.failed`.

Bind sender identity to authentication, not the payload's `from`. Workers may only communicate with Manager; reject Worker-addressed peer messages at the server and tool boundary. Manager alone dispatches tasks or changes mode. Validate schema, target session/run, TTL, payload size and request rate. Do not transmit secrets or accept executable shell commands as control messages.

**Delivery states:** distinguish socket write, recipient acceptance, pending Pi injection, Pi injection acknowledgement, Projectman claim, and final result. Acceptance never means execution or that an agent has read the message. Report busy, unavailable, timeout and unknown outcomes explicitly.

Use bounded in-memory pending requests and recent request IDs. Retry only after reconciling status; never blindly replay all commands after reconnect. In-memory deduplication does not survive process restart and must not be advertised as exactly-once execution. Projectman claim/current-run checks protect task execution; interrupted temporary requests can remain unknown and require an explicit new attempt.

No offline network queue or restart replay is required. A busy connected Pi may have a bounded in-memory pending list with an expiry. Failed delivery returns an actionable status. Existing local task/report persistence can remain, but must not imply guaranteed network delivery.

## 5. Two kinds of work and ownership

### Projectman task delegation

Manager sends an approved UID to one Worker. The Worker checks approval, assignment, revision and current ownership, claims through Projectman, then launches locally. A communication request cannot bypass existing preflight or grant permissions.

Do not run the same exclusive Projectman UID concurrently on multiple Workers. For tracked parallel research, create one parent task with independently assigned child tasks through the existing approval flow.

### Temporary parallel research/review

For bounded requests that do not need independent task tracking, Manager fans out an `agent.request` to selected Workers with a common group/correlation ID and distinct per-Worker request IDs. Specify scope, expected output and deadline. Track partial responses, rejection, timeout and unknown outcomes; Manager aggregates the responses it actually receives.

Define whether each request uses an existing safe Pi session or an explicitly created temporary session. Busy Workers can reject or queue within a bounded memory limit. Do not silently interrupt a running Projectman task or reuse its permissions for unrelated work. Temporary sessions have distinct identities and do not impersonate Projectman runs. Their history is stored by Pi, with no duplicate conversation store.

### Failure and recovery

A broken WebSocket means disconnected communication, not stopped execution. A claimed task may continue within existing authorization; a Worker that requires an answer waits or reports blocked. Projectman connectivity/ownership failure requires a bounded policy for privileged operations; network errors do not grant unlimited execution authority.

Keep persisted Projectman report retries. Manager reconciles task status after reconnect; a lost temporary result notification has no guaranteed replay in the initial release.

Do not automatically reassign uncertain runs. Remote `finishStoppedRun()` must require verified ownership and termination/revocation evidence, not just Manager-local tmux absence. If that cannot be established, refuse recovery. Lease/fencing and automatic recovery are a separate future extension requiring central enforcement and tests.

## 6. Manager-mediated Pi messaging

Register a Worker communication tool with Manager as its only destination. Supported actions are question/reply, notice, proposal and request status. Manager tools address specific connected Workers and can fan out requests.

Examples:
- Worker asks Manager to clarify conflicting requirements.
- Worker reports a blocker or a discovery that changes the plan.
- Worker proposes additional research/review; Manager decides and asks another Worker.
- Reviewer responds to Manager; Manager interprets and forwards guidance to the original Worker.

Workers never delegate to or directly converse with peers. A proposal does not expand approved task scope; changes requiring approval go through Projectman.

Session bridge requirements:
1. Resolve Worker/task/run/session identity and validate authorization.
2. Serialize injection per session; use bounded in-memory waiting while busy.
3. Verify the installed Pi API for safe follow-up injection and when session persistence occurs.
4. Acknowledge injection only at the verified API boundary; do not equate queue acceptance with a persisted conversation or read receipt.
5. Correlate replies, bound context growth and enforce timeouts/request quotas.
6. Reject stale sessions and expose pending/unavailable/unknown states after disconnect or restart.

## 7. Cross-host code and artifacts

Keep current local worktree and patch behavior when communication is disabled. For remote dependent tasks:
- Resolve project identity to an explicitly configured host-local repository path; never assume Manager paths exist on Workers.
- Commit results and publish to a restricted run namespace such as `refs/heads/s8-runs/<runId>`.
- Persist repository, base commit, immutable commit SHA, task/run identity and validation metadata with the Projectman report.
- Fetch and verify dependencies in declared order; expose missing artifacts, provenance failures and conflicts as task errors.
- Use protected integration/PR workflows; never force-push shared branches.
- Use checksummed artifact references for non-Git outputs when needed; keep binaries out of communication payloads. Select storage separately rather than requiring a new service for message transport.

Publish required artifacts before reporting a task ready for dependent work. Allow report-only tasks without a repository.

## 8. Configuration, startup and tmux layout

The `communication` schema below is validated by the configuration loader. WebSocket startup, local IPC and Pi session injection are implemented; real cross-host deployment remains unverified. Enabled configuration requires `nodeId`, `managerUrl` and a `credentialsFile` path; credentials are not read during configuration validation.

Manager with local Workers:

```yaml
communication:
  enabled: true
  nodeId: manager-host
  credentialsFile: /home/user/.config/s8/communication-secrets.json
  server:
    bindIp: 127.0.0.1
    port: 8090
  managerUrl: ws://127.0.0.1:8090
workers:
  - id: a
    mode: passive
  - id: b
    mode: passive
projectman:
  apiUrl: https://projectman.internal.example/api/v2
```

Remote Worker-only host:

```yaml
communication:
  enabled: true
  nodeId: worker-host-c
  credentialsFile: /home/user/.config/s8/communication-secrets.json
  managerUrl: ws://10.0.0.10:8090
workers:
  - id: c
    mode: passive
projectman:
  apiUrl: https://projectman.internal.example/api/v2
```

For remote clients, bind Manager's server to its private reachable address and use a reachable `managerUrl` for local clients too. Manager-only hosts use `workers: []`; remote membership comes from authenticated registration, not the local `workers` list. Enforce global Worker-ID uniqueness and reject duplicate live registrations.

There is no mutually exclusive machine-level role. Server configuration and the local Worker list are independent. When enabled, all configured local Workers use the same WebSocket contract as remote Workers. When disabled/absent, preserve existing local behavior. Start Workers in `passive` mode; distributed auto-polling requires an explicit later decision.

Projectman/model secrets remain operator-managed. Communication credentials use a separate owner-only regular JSON file (`{"workers":{"a":"<32–256 URL-safe random characters>"}}`), with each remote host receiving only its own Worker entry. Secrets never belong in YAML. Any added/changed/removed environment variable must update the relevant `.env.example` in the same implementation change. Do not read or print real `.env` secrets; do not bypass protection if an example file is blocked.

Proposed startup behavior:
- `./s8.sh --mode project`: start Manager Pi, scheduler, one communicator server when configured, and configured local resident Workers.
- `./s8.sh service worker c`: run the resident Worker with its embedded client on a Worker-only host.
- `./s8.sh service communicator` runs the server in the foreground for tmux or diagnostics, with a single-owner PID lock and clean shutdown.
- `./start-infra.sh`: retain existing app startup on the Manager host when those apps are needed.
- A standalone `start-manager-agent.sh` or `start-worker-agent.sh` remains an agent-only entrypoint; explicitly document its communication prerequisites and limitations rather than silently claiming it starts the complete managed runtime.

`./s8.sh workers` starts/reuses the managed `s8-workers` session without starting Manager, scheduler or apps. It wraps configured resident services in tmux; README documents the command. Avoid full-runtime restart on a Worker host to start one client. Reuse lifecycle ownership checks and avoid duplicate communicator/listener/client processes.

Target tmux layout (IDs `a`, `b`, `c`; task windows created on demand):

```text
Manager host, optionally also running local Workers
  s8-infra
    router / phcms / kb-browser / frontend / projectman-console / terminal-gateway
  s8-main
    shell / pi / scheduler / communicator
  s8-workers                         # only when local Workers/tasks exist
    shell / worker-a / worker-b / <TASK-UID-1> / <TASK-UID-2>

Remote Worker-only host
  s8-workers
    shell / worker-c / <TASK-UID-3>
```

The communicator is a separate Manager-side window; Worker clients stay inside resident windows. Completed task Pi windows may remain for inspection, as today. Temporary research uses `research-<workerId>-<requestId>` windows, separate working/session directories, and explicit `agent_message(result)` completion. Windows remain for inspection until manually closed. Telegram and scheduler run only on Manager. Version/capability handshake must reject incompatible peers clearly.

## 9. Implementation milestones

### P0 — Protocol and configuration

- [x] Define message schemas, authorization, receipt states, bounded pending/deduplication, timeouts and unknown outcomes.
- [x] Add optional strict configuration and examples without changing default local behavior.
- [x] Define identities and message context for local/remote Workers, Projectman runs and temporary requests. Session IPC paths are owner-only hashed Unix socket names; temporary sessions have request-specific working/session directories and tmux windows.
- [x] Inspect installed Pi 1.3.0 API: extension `sendMessage()` returns void; streaming follow-up is queued in memory, and persistence happens when the custom message is appended. Therefore API invocation alone is not an injection/persistence acknowledgement. P2 runtime tests verify session observation and safe delivery; `injected` is an observed session-history state, not an fsync/read guarantee.

**Done when:** contract/config tests and existing regression checks pass; no broker dependency or offline-delivery guarantee is introduced.

P0 evidence: `pi/test/communication.test.mjs` covers sender authorization, forbidden peer routing, task/reply correlation, expiry, message limits, bounded request memory and disconnect uncertainty. `pi/test/s8-config.test.mjs` covers local/mixed-compatible configuration and invalid settings. Credentials, live registration and exact destination/session routing are runtime requirements for P1/P2, not guarantees of schema validation alone.

### P1 — Communicator and Projectman delegation

- [x] Implement authenticated WebSocket server/client, registration, heartbeat and reconnect.
- [x] Add Manager communicator tmux window and embedded resident clients, with PID ownership and shutdown handling.
- [x] Implement Worker-only managed tmux startup and same-host/mixed deployments.
- [x] Dispatch approved UIDs, execute locally, and return accurate receipt/start/error states.
- [x] Keep report outbox recovery and reconcile Projectman state after reconnect.
- [x] Reject peer routing, invalid/expired messages, duplicate live identities and unauthorized controls.

**Acceptance:** same-host and remote dispatch/report flows work, disconnected/uncertain requests are visible, and exclusive task claim remains enforced without automatic failover. Local isolated runtimes pass; actual separate-host acceptance remains unverified.

### P2 — Manager-mediated questions and parallel research

- [x] Implement Worker-initiated questions, notices, blockers, collaboration proposals and results.
- [x] Safely inject into Manager and Worker Pi sessions; preserve delivered conversations in Pi.
- [x] Support Manager fan-out/aggregation with per-Worker request IDs, deadlines and partial results.
- [x] Support bounded temporary sessions, explicit busy policy, soft response deadlines and tmux cleanup. Retain at most 20 unclosed research sessions per Worker; reconcile surviving sessions after resident restart before new work.
- [x] Distinguish temporary requests from independently claimed Projectman child tasks.
- [x] Avoid model calls for connection/status housekeeping; enforce approval boundaries.

**Done when:** A asks Manager for help, Manager requests B's review and returns guidance to A; parallel research produces correlated results without direct peer traffic or interrupted tool turns.

### P3 — Cross-host artifacts

- [x] Implement host-local repository mapping, immutable Git result publication and verified dependency fetch.
- [x] Handle credentials, branch collisions, conflicts and unavailable artifacts visibly.
- [x] Support checksummed non-Git references where required and publish before dependency-ready reports.

**Done when:** a dependent task on another host consumes verified results, with failure-path integration tests.

### P4 — Operational UI, recovery boundaries and documentation

- [x] Display host, connection, mode, heartbeat, current task/run, pending requests and last error.
- [x] Log correlation/task/run/node IDs and delivery/error states without duplicating conversation contents or secrets.
- [x] Block unsafe remote finish/reassignment; explain manual recovery and Projectman report reconciliation.
- [x] Document private networking, credentials, restart behavior and rollback.
- [x] Update README with role-specific setup/start/stop/restart and tmux inspection instructions, as specified below.

**Acceptance:** operators can run and diagnose each supported topology from README; recovery tests enforce the stated limits. Local command walkthroughs pass; deployed networking/credentials require the actual-host smoke check. Automatic failover/lease-fencing remains deferred.

## 10. Verification matrix

| Scenario | Expected outcome |
|---|---|
| Communication absent/disabled | Existing local behavior unchanged |
| Manager + two Workers on one host | One communicator; separate clients, Pi sessions and worktrees |
| Manager + three remote Workers / mixed topology | Registration, dispatch and results work without shared filesystem |
| Offline target | Explicit unavailable response; no offline queue promise |
| Disconnect after send or restart before reply | Pending request becomes unknown/timeout; no blind replay |
| Duplicate task request | Current Projectman claim/run prevents duplicate authorized execution |
| Duplicate temporary request | Bounded live-process deduplication; restart limitations explicit |
| Busy Pi | Bounded waiting or rejection; no nested tool turn |
| Worker asks for review | Manager mediates request and response with correlation preserved |
| Worker targets another Worker or assigns work | Rejected by server/tool authorization |
| Parallel research | Separate responses, partial completion and timeout tracking; no shared exclusive UID |
| WebSocket disconnect during claimed run | Disconnection does not imply cancellation or reassignment |
| Lost completion notification | Projectman report remains authoritative and can be queried |
| Projectman unavailable | Existing report retry retained; ownership failure policy enforced |
| Missing/conflicting remote artifact | Visible task error; no false dependency-ready status |
| Manager attempts remote finish with unknown owner state | Refused; local tmux absence is insufficient |
| Duplicate Worker identity / incompatible version | Clear rejection |
| README command walkthrough | Actual startup, tmux windows and shutdown match documentation |

Run repository-appropriate unit tests, mocked Pi boundary tests, local multi-process integration tests, and real cross-host smoke tests before claiming distributed verification. Record commands and outputs, and distinguish unperformed cross-host checks from passing local tests.

## 11. Deployment and rollback

1. Record existing revision and back up authoritative task/runtime state.
2. Deploy with communication disabled and verify local regression behavior.
3. Enable Manager communicator and one passive Worker; verify registration, UID claim/report and Worker-to-Manager question/reply.
4. Verify one-machine and mixed layouts, then add other Workers and test parallel requests.
5. Keep Telegram/scheduler on Manager only; retain private-network access controls.
6. On rollback, stop new dispatch and resolve pending/unknown requests. Disable communication only after reconciling active Projectman runs; disconnection is not proof of termination.

Implemented decisions: per-Worker private credential files; a separate Manager communicator with embedded resident clients; idle-only Pi injection observed in session history; request-specific research sessions with soft deadlines and restart reconciliation; explicit repository mappings; immutable Git run refs plus checksummed HTTP blobs; same-node/local-claim and central Worker ownership checks before manual finish. Deployment-specific addresses, TLS/private-network policy, credentials and retention operations must still be selected on the actual hosts. No NATS hosting or durable conversation store is required.

## 12. Required README update and first pull request

The implementation is not complete until `README.md` explains the actual final interfaces for:
- Manager-only host: dependencies, Projectman/KB configuration, communicator address/authentication, app startup, Manager/Telegram/scheduler startup.
- Worker-only host: Pi/model authentication, Projectman access, repository/build environment, Manager URL/Worker ID, managed tmux startup and foreground diagnostics.
- Single host with Manager and multiple Workers, plus mixed local/remote deployment: independent server/local-Worker settings, unique identities and reachable addresses.
- Each agent role (Manager, Worker, existing General agent): supported entrypoints, agent-only versus managed-runtime behavior and communication prerequisites.
- tmux sessions/windows, task and temporary-session lifecycle, status/log inspection, stop/restart/reconnect and duplicate-process prevention.
- Offline delivery limitations, acceptance versus injection versus execution, partial/unknown results, report reconciliation and safe recovery boundaries.
- Configuration/credential examples without real secrets; update relevant `.env.example` alongside any environment-variable changes.

Update README alongside each delivered capability and complete the role/layout walkthrough before final completion. Do not publish proposed commands as already supported. Keep the General agent's existing behavior unless explicitly changed.

First PR: implement **P0 only**, keeping default behavior unchanged and documenting the contract and configuration status. Follow with reviewable P1–P4 changes, including applicable README updates, backward compatibility, verification and rollback notes.

## 13. Implementation evidence and release audit

P0–P4 task checkboxes above describe delivered implementation, not proof of physical deployment. Transport, conversation state and command queues are memory-only. Existing Projectman claim/report outboxes and Pi conversation records retain their original responsibilities. No broker or duplicate conversation database was added.

| Requirement | Authoritative local evidence | Actual-host status |
|---|---|---|
| Manager-only, Worker-only, same-host and mixed configuration | strict config tests; runtime/service tmux tests; role/layout README instructions | Network addresses and deployment credentials not provided |
| Authenticated Manager-mediated communication; no peer routing | protocol/network tests, real sender-spoof rejection, per-Worker credentials | Private networking/TLS deployment unverified |
| Explicit UID dispatch, approval and claim/report | existing Worker ownership tests plus actual CLI/Pi scripted-API runtime test | Real deployed Projectman/host combination unverified |
| Worker questions, Manager counterquestions, evidence and results | actual Manager and Worker Pi CLI conversation; profiles and system prompts | Local fixture model only; no external model evaluation claimed |
| Parallel temporary research and scoped tools | two real research Pi sessions plus tool fan-out/correlation tests; late CLI flag regression test | Three remote machines not available |
| Restart/disconnect, unknown outcomes and report retries | network reconnect/no-replay tests; actual runtime lost-report-response and resident restart checks; startup research reconciliation; same-request lost-claim resume tests in local/distributed mode | Real host outage/partition not tested |
| Safe Pi injection and bounded waiting | installed SDK busy-turn ordering/session-file test, session identity/expiry/inbox bounds | Runtime sessions tested locally |
| Cross-host code and files without shared runtime storage | separate clones and runtime roots; immutable Git refs, checksum downloads, launcher path mapping and conflict/missing/ref-move tests | Real Git server permissions and deployed storage unverified |
| Projectman metadata compatibility | actual sibling PH-CMS `DevelopmentReportSchema` accepts existing `commit`, `baseCommit`, versioned `checkpoint` metadata; test explicitly skips if schema is unavailable | Deployed API must support those existing fields |
| Operator status and recovery boundaries | remote console route tests, UI claim/connection/research tests, refusal of non-owner remote finish | Actual operator walkthrough pending |
| Role-specific setup/start/stop/restart documentation | README, config and environment examples updated alongside code | Actual target addresses still required |

### Artifact contract

`communication.repositories` maps each approved `spec.repoPath` to a host-local `{path, remote, kind}` entry. Git entries require a configured remote name; `kind: files` entries use UID-specific directories without Git initialization. Every participating host must map the same logical source consistently.

Code publication creates a baseline commit and result commit without moving the user's HEAD, then pushes only `refs/heads/s8-runs/<runId>` without force. The report stores the SHA in existing `commit`/`baseCommit` fields and records versioned provenance/file metadata after `S8_ARTIFACT_V1` in `checkpoint` (within its 16000-character limit). Dependency import verifies task/run/source identity, immutable SHA, baseline ancestry, safe changed paths, checksums and conflicts. Its local manifest also records plan/node identity, imported publication signatures and the input tree. A retry checks that workspace before reusing imports, restores file caches through verified transfers, and refuses a changed plan/publication/workspace instead of overwriting it. Tree snapshots share one helper with publication. Local patch generation compares against the actual dependency baseline, including a task reverting its parent to the base version. Publication failure becomes a failed report; it never makes dependencies ready.

Non-Git outputs use authenticated content-addressed HTTP transfers on the same communicator process. Limits: 8 MiB per file, 20 named files per report, four concurrent transfers, 4096 stored files and 256 MiB total storage. Storage is `.s8-runtime/artifacts` on Manager; verified input files are materialized under `.s8-runtime/dependencies/<runId>` on Workers. There is no automatic deletion of referenced artifacts. Operational backup/retention is documented in README.

### Verification records

- Node/agent/gateway regression: `node --test pi/test/*.test.mjs apps/telegram-gateway/gateway.test.mjs` — 194 passed, no skips in the final full run (including the follow-up recovery/import/status regressions).
- Frontend: `npm run test:run --prefix frontend` — 63 passed; lint and build passed. Lint reports the existing Fast Refresh/exhaustive-deps warnings.
- Terminal gateway: `npm test --prefix apps/terminal-gateway` — 5 passed.
- KB Browser: `npm ci --prefix apps/kb-browser` installed the missing locked dependencies, then `npm test --prefix apps/kb-browser` — 3 passed. The initial attempt could not find the uninstalled `tsx` dependency; no lockfile change was needed.
- Shell syntax (`bash -n start-general-agent.sh start-manager-agent.sh start-worker-agent.sh s8.sh start-infra.sh`) and `git diff --check` passed.
- `pi/test/communication-runtime.test.mjs` uses actual Pi CLI, four isolated roots/tmux servers and local scripted model/Projectman endpoints. It proves local process integration, not a physical four-host deployment or live backend DB behavior. The strengthened targeted run also passed with `./s8.sh service communicator` in its actual tmux window, confirmed process shutdown before restart, automatic three-client reconnection, and a real resident restart (one test, approximately 33 seconds).

### Remaining deployment gate

- [ ] Supply actual Manager/three-Worker hosts and approved connection details (without sending secrets in chat).
- [ ] Verify private network/TLS, deployed Projectman compatibility, node credentials, Git run-ref permissions and artifact retention/backup on those hosts.
- [ ] Run four-host dispatch, mediated question/reply, parallel research, dependent artifact import, reconnect and controlled recovery smoke checks.
- [ ] Record actual commands/results and complete the deployed role/layout walkthrough.

The goal must not be reported fully complete while these explicit deployment checks remain unverified. No actual remote hosts have been configured, no deployment was performed, and no real `.env` values were inspected. Further code work remains authorized if the audit exposes a defect.

### Follow-up local audit

Four recovery/import/status cases were reproduced with failing regression tests and fixed:
1. The server accepted a claim but its response was lost: explicit launcher resume now uses the original saved run/request identity, still requiring current ownership/authorization. Both local and communication-enabled cases are tested.
2. A prepared dependency workspace or published metadata changed before retry: import manifests now validate the approved context, input tree and publication identity; missing cached files are re-fetched and verified.
3. A child task reverted a dependency to the original base: local task patches now compare to the dependency input baseline, preserving that reverse change downstream.
4. A new queued request for a previously reported UID inherited the earlier run’s finished/error state: receipts now preserve their queue/start boundary and previous-run context, while an explicit resume still recognizes its unfinished claim.

Targeted artifact/Worker regressions passed (26 tests), request-status regressions passed, and the final full Node/agent/gateway run passed all 194 tests with no skips (approximately 34 seconds). `git diff --check` passed. Frontend, terminal and KB sources were unchanged during this follow-up audit; their previous passing results remain applicable. The public configuration was inspected without loading `.env`: communication is disabled and no Manager endpoint, Workers or Projectman API is configured, so it supplies no actual-host smoke-test targets.

### Deployment handoff

All locally executable implementation and regression work has been completed and revalidated. The only unresolved release gate is the actual Manager/three-Worker deployment check. The current public config contains no communication node/endpoint, configured Workers or Projectman API, and no actual-host connection details have been supplied. The task remains unachieved at that external verification gate; continue when the host addresses/SSH aliases and intended role mapping are available, without requesting or logging secret values.
