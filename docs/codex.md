# Codex backend

The root backend remains Claude 0.96.0; `codex/` contains the complete Apache-2.0
Codex ACP 2.2.2 source pinned in `codex/UPSTREAM.json`, with local changes applied.
Each backend has its own lockfile, build and executable. There is no runtime
switch that changes an existing session's agent.

```bash
python3 install.py --agent codex --test \
  --prefix "$HOME/.local/share/codex-acp-wrapper-2.2.2-r2" \
  --bin "$HOME/.local/bin/acp-codex-wrapper"
```

Use Node.js 22+, npm and Python 3. The installer refuses to overwrite existing
paths and records source revision, dirty state, upstream provenance and source
SHA256 in `FORK.json`. A source export without Git metadata records a null
revision. `CODEX_PATH` can select an existing Codex CLI. The VM verification used
CLI 0.163.0; the adapter's locked npm dependency remains separately reproducible.

## Provider and launch

`examples/codex-routerai.sh` accepts `ROUTERAI_API_KEY` or a private
`ACP_ROUTERAI_TOKEN_FILE`, and requires a separate `CODEX_HOME`. It configures
RouterAI's Responses endpoint using an environment key, never a key in arguments.
Set `ACP_CODEX_MODEL`, `ACP_ROUTERAI_HOST`, `ACP_CODEX_BINARY` and `CODEX_PATH` as
needed. The tested model was `openai/gpt-6-luna`. No credentials are distributed.
The orchestrator launches this executable in the task cwd and sends prompts over
ACP `session/prompt` after `session/new` or `session/load`.

## Strict background contract

The client must offer `orchestratorBackgroundTasks: 1` and all three AIR
capabilities: async tasks, native subagent sessions and session failures. Only
then does Codex advertise the extension. `_orchestrator/background` uses the
same snapshot/conditional-close shape as [the Claude contract](protocol.md).
Requests reject unknown fields and invalid types. Without negotiation the RPC
is rejected and ordinary upstream ACP remains available.

Snapshots drain queued notifications and synchronize known native terminals,
including child sessions. Failed and completed tasks remain in history; vanished
terminal entries are never converted to invented `stopped` events. Pending
publications, prompts, children, native tasks and tracked OS work prevent close.
Tokens include event generations and OS identities. Concurrent close and prompt
are fenced: one close can seal a session, and a stale token cannot cancel work.
Registry errors, oversized histories and loss of ownership after app-server
recovery fail closed. Recovery does not silently upgrade an untracked session.

Strict supervision requires Linux `/proc` with readable owned process metadata.
It assigns an isolated session marker through Codex shell environment policy;
`CODEX_HOME/acp-wrapper-scopes` persists ownership across session load. Task
identity includes session ID, task ID, PID and process start time. If the native
API omits an OS PID, only a unique, marked, exact command match is accepted.
Missing or ambiguous ownership cannot produce a successful stop.

Before explicit stop/cancel, the supervisor freezes the verified process tree
and kills it, then verifies absence and reconciles the native API. Freezing is
necessary: killing `sleep` first can wake Bash and execute its trailing command.
Detached descendants retaining the marker remain visible. Separate run markers
clean up internal app-server helpers after shutdown. Unrelated processes are
not selected by process-group proximity. Trusted Codex code-mode host processes
are excluded from idle detection, but included in explicit cleanup.

These markers are cooperative ownership tracking, not a security boundary against
hostile code that changes its environment or escapes supervision. SIGKILL of the
adapter or a lost SSH transport can prevent cleanup. An external supervisor or
cgroup is needed for unconditional host-level termination. The orchestrator must
block retries when stop is unconfirmed. Do not treat `end_turn`, `stopped`, or a
transport error alone as evidence that all work finished.

Codex does not have Claude's autonomous background-result turns. The integration
client issues verification prompts and can observe new native work started by
those prompts. HTTP tests use the explicitly selected `agent-full-access` mode;
this does not change the default mode for other sessions.

## Verification

See [the integration matrix](integration-tests.md). Reusable VM clients are
`codex/tests/integration_vm.py` and `codex/tests/orchestrator_vm.py`. They read SSH
settings from the specified orchestrator, run outside its DB, accept the provider
key through stdin or a private file, and write an explicit results JSON. Run with
`--help` for arguments. Negative cases independently inspect processes; `PASS`
in raw JSON means its guard criterion passed, not unconditional cleanup.

```bash
cd codex
npm ci --ignore-scripts
npm run typecheck
npm test -- --no-file-parallelism
npm run build
```

The full suite includes real Linux child processes, detached descendants,
ownership ambiguity, duplicate terminal IDs in separate sessions, snapshot races,
failed tasks, recovery failure and post-stop delayed-write regressions.
