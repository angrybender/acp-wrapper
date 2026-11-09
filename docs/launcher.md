# Native agent selection

The default installation contains both ACP backends. Its executable keeps its
existing name but accepts an optional native agent as the first argument:

```bash
/home/user/.local/bin/claude-agent-acp-wait /usr/bin/codex --yolo
/home/user/.local/bin/claude-agent-acp-wait /usr/local/bin/claude --dangerously-skip-permissions
```

The launcher resolves an executable path or command in PATH and probes its
`--version` with a five-second limit. It recognizes native Claude Code/Codex
signatures, including renamed symlinks and paths with spaces. Quote paths and
values normally. Missing, unsupported or unresponsive executables fail with
stderr and a nonzero exit; they never silently select Claude. Pass a native CLI,
not another ACP adapter.

Without a path the original Claude invocation, wrapper `--version`/`-v` and
`--cli` behavior remains available. Backend selection happens once at startup.
Saved Claude session IDs cannot be resumed by Codex, or vice versa.

## Arguments

Argument arrays preserve spaces, repeated flags and literal shell substitutions.
For Codex, interactive switches become App Server config and ACP defaults:

| Native argument                                        | ACP behavior                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `--yolo`, `--dangerously-bypass-approvals-and-sandbox` | `agent-full-access`, `never` approvals, unrestricted sandbox                                             |
| `--sandbox`, `-s`                                      | Initial sandbox mode                                                                                     |
| `--ask-for-approval`, `-a`                             | Approval policy used for turns                                                                           |
| `--full-auto`                                          | Workspace sandbox, on-request approvals                                                                  |
| `--approve-for-me`, `--not-so-yolo`                    | Workspace sandbox, automatic approval review                                                             |
| `--model`, `-m`                                        | Native and ACP model override                                                                            |
| `--config`, `-c`                                       | Original TOML override to App Server; scalar model/provider/permission settings also update ACP defaults |
| `--enable`, `--disable`                                | Repeated native feature switches                                                                         |
| `--search`                                             | Live web search                                                                                          |
| `--add-dir`                                            | Additional writable roots for new/resumed/forked sessions and turns                                      |

CLI choices override corresponding `CODEX_CONFIG`/`INITIAL_AGENT_MODE` defaults.
Launches without flags keep their previous defaults. Restarts preserve startup
arguments; later ACP mode changes remain available. Other switches pass to App
Server unchanged, which reports unsupported arguments. Use passthrough for
TUI-only options. ACP owns cwd and stdio, so `--cd`/`-C`/`--listen`/`--stdio`
are rejected in ACP mode.

For Claude, the path sets `CLAUDE_CODE_EXECUTABLE` for SDK execution and auth
probes. Arguments append to the SDK subprocess argv, including repeated options.
`--model` and `--permission-mode` also set matching SDK/ACP defaults. `--yolo`
aliases `--dangerously-skip-permissions`; native/settings restrictions still
apply. ACP owns resume/session IDs and streaming formats; use passthrough
rather than overriding them.

Internal `ACP_WRAPPER_CLAUDE_ARGS`, `ACP_WRAPPER_APPROVAL_POLICY` and
`ACP_WRAPPER_CODEX_DIRS` carry argv/derived defaults. They require no user setup
and contain no authentication configuration.

## Native passthrough

Explicit `--cli` forwards remaining arguments to the native CLI with inherited
stdio, exit status and signals. Codex's `cli` alias remains supported. Native
commands immediately after the path (`login`, `logout`, `auth`, `exec`, etc.)
and native help/version requests also delegate:

```bash
claude-agent-acp-wait /usr/bin/codex --version
claude-agent-acp-wait /usr/bin/codex --cli exec --yolo "Inspect this project"
claude-agent-acp-wait /usr/local/bin/claude auth status
```

Passthrough is a native CLI invocation, not an ACP server. An orchestrator uses
the path and ACP-compatible flags, without `--cli` or a native subcommand.

## Install and verify

```bash
python3 install.py --test \
  --prefix "$HOME/.local/share/acp-wrapper-next" \
  --bin "$HOME/.local/bin/claude-agent-acp-wait-next"
```

The root installer builds both backends from this checkout, packages Codex under
`<prefix>/codex/`, and installs each backend's locked production dependencies and
provenance. Existing paths are never overwritten. Switch the existing symlink
after validation using README's update procedure. Previously installed runtimes
must be reinstalled. `--agent codex` retains the standalone Codex installation.

Direct development builds need both packages:

```bash
npm ci --ignore-scripts
npm run build
npm --prefix codex ci --ignore-scripts
npm --prefix codex run build
node dist/index.js /path/to/codex --yolo
```

`node scripts/launcher-smoke.mjs [installed-entry]` checks real native selection,
ACP initialize/background negotiation, a Codex session's `--yolo` mode and clean
exit. It uses isolated configuration/auth directories and sends no model prompt.
The launcher adds no finalization prompt and preserves the background contract,
ownership checks and conditional-close rules.
