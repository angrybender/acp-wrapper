#!/usr/bin/env bash
# Use an isolated Codex home and pass the provider key through the environment.
set -euo pipefail
umask 077
binary="${ACP_CODEX_BINARY:-$HOME/.local/bin/acp-codex-wrapper}"
[[ -x "$binary" ]] || { printf 'Codex ACP executable is missing.\n' >&2; exit 1; }
[[ -n "${CODEX_HOME:-}" ]] || { printf 'Set a separate CODEX_HOME.\n' >&2; exit 1; }
if [[ -n "${ACP_ROUTERAI_TOKEN_FILE:-}" ]]; then
    [[ -r "$ACP_ROUTERAI_TOKEN_FILE" ]] || { printf 'Token file is not readable.\n' >&2; exit 1; }
    ROUTERAI_API_KEY="$(cat -- "$ACP_ROUTERAI_TOKEN_FILE")"
fi
[[ -n "${ROUTERAI_API_KEY:-}" ]] || { printf 'Set ROUTERAI_API_KEY or ACP_ROUTERAI_TOKEN_FILE.\n' >&2; exit 1; }
export ROUTERAI_API_KEY CODEX_HOME
export ACP_ROUTERAI_HOST="${ACP_ROUTERAI_HOST:-https://routerai.ru/api/v1}"
export ACP_CODEX_MODEL="${ACP_CODEX_MODEL:-openai/gpt-6-luna}"
mkdir -p -- "$CODEX_HOME"
CODEX_CONFIG="$(python3 - <<'PY'
import json, os
config = json.loads(os.environ.get('CODEX_CONFIG', '{}'))
providers = config.setdefault('model_providers', {})
providers['routerai'] = {'name': 'RouterAI', 'base_url': os.environ['ACP_ROUTERAI_HOST'],
                        'env_key': 'ROUTERAI_API_KEY', 'wire_api': 'responses'}
config.update(model=os.environ['ACP_CODEX_MODEL'], model_provider='routerai')
print(json.dumps(config))
PY
)"
export CODEX_CONFIG
exec "$binary" "$@"
