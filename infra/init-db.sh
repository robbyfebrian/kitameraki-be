#!/usr/bin/env bash
set -euo pipefail

# Creates the TaskApp database and its Tasks / FormSettings /
# FormSettingsHistory containers
# (partition key /organizationId) on whatever Cosmos endpoint the backend is
# pointed at, using the backend's own connection string.
#
# Usage (from kitameraki-be/):
#   ./infra/init-db.sh
#
# Reads COSMOS_CONNECTION_STRING from local.settings.json when not already set
# in the environment, so it works against the local emulator and a real account.

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
  COSMOS_FORM_SETTINGS_HISTORY_CONTAINER="${COSMOS_FORM_SETTINGS_HISTORY_CONTAINER:-$(read_from_settings COSMOS_FORM_SETTINGS_HISTORY_CONTAINER)}"
  export COSMOS_DATABASE COSMOS_TASKS_CONTAINER COSMOS_FORM_SETTINGS_CONTAINER COSMOS_FORM_SETTINGS_HISTORY_CONTAINER
fi

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING is empty. Fill it in local.settings.json first." >&2
  exit 1
fi

# The emulator serves a self-signed certificate. Accept it only when the caller
# opts in by exporting COSMOS_EMULATOR=true; real accounts keep full TLS checks.
if [ "${COSMOS_EMULATOR:-}" = "true" ]; then
  export NODE_TLS_REJECT_UNAUTHORIZED=0
fi

export COSMOS_CONNECTION_STRING

node -e '
const { CosmosClient } = require("@azure/cosmos");

const databaseId = process.env.COSMOS_DATABASE ?? "TaskApp";
const containers = [
  process.env.COSMOS_TASKS_CONTAINER ?? "Tasks",
  process.env.COSMOS_FORM_SETTINGS_CONTAINER ?? "FormSettings",
  process.env.COSMOS_FORM_SETTINGS_HISTORY_CONTAINER ?? "FormSettingsHistory",
];

(async () => {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);

  const { database } = await client.databases.createIfNotExists({ id: databaseId });
  console.log(`database ready: ${databaseId}`);

  for (const id of containers) {
    await database.containers.createIfNotExists({
      id,
      partitionKey: { paths: ["/organizationId"] },
    });
    console.log(`container ready: ${id} (partition key /organizationId)`);
  }
})().catch((err) => {
  console.error("init-db failed:", err.message);
  process.exit(1);
});
' "$@"
