#!/usr/bin/env bash
set -euo pipefail

# Wipes every task in the seed organization and writes the seed tasks plus the
# seed form settings, straight to whatever Cosmos endpoint the backend is
# pointed at. Uses the compiled seed module, so the schemas are enforced.
#
# Usage (from kitameraki-be/):
#   ./infra/seed.sh            # reseed
#   ./infra/seed.sh --clear    # wipe tasks only, do not seed
#
# Reads COSMOS_* from local.settings.json when not set in the environment, so
# it works against the emulator and a real account alike.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -z "${COSMOS_CONNECTION_STRING:-}" ] && [ -f local.settings.json ]; then
  read_from_settings() {
    node -e "process.stdout.write(String(require('./local.settings.json').Values.$1 || ''))"
  }
  COSMOS_CONNECTION_STRING="$(read_from_settings COSMOS_CONNECTION_STRING)"
  COSMOS_EMULATOR="${COSMOS_EMULATOR:-$(read_from_settings COSMOS_EMULATOR)}"
  COSMOS_DATABASE="${COSMOS_DATABASE:-$(read_from_settings COSMOS_DATABASE)}"
  COSMOS_TASKS_CONTAINER="${COSMOS_TASKS_CONTAINER:-$(read_from_settings COSMOS_TASKS_CONTAINER)}"
  COSMOS_FORM_SETTINGS_CONTAINER="${COSMOS_FORM_SETTINGS_CONTAINER:-$(read_from_settings COSMOS_FORM_SETTINGS_CONTAINER)}"
  export COSMOS_DATABASE COSMOS_TASKS_CONTAINER COSMOS_FORM_SETTINGS_CONTAINER
fi

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING is empty. Fill it in local.settings.json first." >&2
  exit 1
fi

# The emulator serves a self-signed certificate. Accept it only when the caller
# opts in; real accounts keep full TLS checks.
if [ "${COSMOS_EMULATOR:-}" = "true" ]; then
  export NODE_TLS_REJECT_UNAUTHORIZED=0
fi

export COSMOS_CONNECTION_STRING

npm run build >/dev/null

if [ "${1:-}" = "--clear" ]; then
  node dist/src/infra/clear.js
else
  node dist/src/infra/reseed.js
fi
