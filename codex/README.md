# Codex ACP backend

Pinned source fork of codex-acp **2.2.2**, upstream revision
`202e66e63343ec4f5a5e35ab590251d813d129ca`. The Claude backend remains in the
repository root. Both expose `orchestratorBackgroundTasks` v1 over ACP v1.

Install on the machine that runs the agent, from the repository root:

```bash
python3 install.py --agent codex --test \
  --prefix "$HOME/.local/share/codex-acp-wrapper-2.2.2-r2" \
  --bin "$HOME/.local/bin/acp-codex-wrapper"
```

Node.js 22+, npm, Python 3 and Linux `/proc` are required for strict drain.
Existing destinations and executables are never overwritten. `CODEX_PATH`
can select an installed Codex CLI; otherwise the locked npm dependency is used.
The tested CLI version, results and limitations are in [../docs/codex.md](../docs/codex.md).

The installer builds the local source checkout, records its revision and source
hash, and runs typecheck and focused tests with `--test`. It does not modify
Claude installations or publish upstream npm packages. Upstream release workflows
are stored only as reference under docs/upstream-workflows.

Set the orchestrator's Agent shell to the installed executable. Enable its ACP
background waiting option. No shell prompt substitution is required: prompts
arrive through session/new or session/load followed by session/prompt.

Strict drain adds session-owned shell environment markers, retained terminal
results, a bounded snapshot and token-checked close. Stop/cancel verify native
processes across process-group changes. An unknown PID, ambiguous command owner,
unavailable registry or unconfirmed cleanup never authorizes successful close.
Ownership metadata lives under CODEX_HOME/acp-wrapper-scopes and contains no API key.
Keep CODEX_HOME private to the agent user.

The default root installation now includes this backend and accepts
`claude-agent-acp-wait /usr/bin/codex --yolo`. See [native selection and arguments](../docs/launcher.md).
Standalone Codex installation remains supported. Native model, permission and
configuration flags also work on this backend; `--yolo` sets the ACP session's
initial mode to `agent-full-access`.

Ordinary clients that do not negotiate the contract keep upstream behavior.
The contract supervises native local shell workloads with inherited ownership;
it cannot cover hostile removal of the marker or external Docker/SSH services.
Permission modes are explicit ACP session settings; changing sandbox_mode in a
config file alone does not change the ACP default mode.

Development:

```bash
cd codex
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
```

The original upstream documentation is preserved in README.upstream.md.
