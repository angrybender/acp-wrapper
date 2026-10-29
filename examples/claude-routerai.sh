#!/usr/bin/env bash
# Launch the installed ACP fork with an isolated RouterAI configuration.
set -euo pipefail

binary="${ACP_CLAUDE_BINARY:-$HOME/.local/bin/claude-agent-acp-wait}"
if [[ ! -x "$binary" ]]; then
    printf 'ACP executable is missing or not executable: %s\n' "$binary" >&2
    exit 1
fi

if [[ -n "${ACP_ROUTERAI_TOKEN_FILE:-}" ]]; then
    if [[ ! -r "$ACP_ROUTERAI_TOKEN_FILE" ]]; then
        printf 'RouterAI token file is not readable.\n' >&2
        exit 1
    fi
    ANTHROPIC_AUTH_TOKEN="$(cat -- "$ACP_ROUTERAI_TOKEN_FILE")"
fi
if [[ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
    printf 'Set ANTHROPIC_AUTH_TOKEN or ACP_ROUTERAI_TOKEN_FILE.\n' >&2
    exit 1
fi

export ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_API_KEY=''
# Claude SDK appends /v1/messages itself.
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://routerai.ru/api}"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-anthropic/claude-sonnet-4.6}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-$ANTHROPIC_MODEL}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-$ANTHROPIC_MODEL}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-$ANTHROPIC_MODEL}"
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.config/acp-wrapper/routerai}"
export CLAUDE_AGENT_ACP_PROTOCOL=v1
mkdir -p -- "$CLAUDE_CONFIG_DIR"

exec "$binary" "$@"
