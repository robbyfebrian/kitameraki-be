#!/usr/bin/env bash
set -euo pipefail

# Provisions an Azure Cosmos DB (SQL API) account for Kitameraki and prints the
# connection string to paste into kitameraki-be/local.settings.json.
#
# Requires the Azure CLI, already logged in:
#   brew install azure-cli
#   az login
#
# Usage:
#   ./infra/provision-cosmos.sh [resource-group] [location] [account-name]
#
# Defaults: rg-kitameraki / southeastasia / kitameraki-cosmos-$RANDOM

RG="${1:-rg-kitameraki}"
LOCATION="${2:-southeastasia}"
ACCOUNT="${3:-kitameraki-cosmos-$RANDOM}"
DATABASE="${COSMOS_DATABASE:-TaskApp}"
TASKS_CONTAINER="${COSMOS_TASKS_CONTAINER:-Tasks}"
FORMS_CONTAINER="${COSMOS_FORM_SETTINGS_CONTAINER:-FormSettings}"

if ! command -v az >/dev/null 2>&1; then
  echo "ERROR: Azure CLI ('az') not found. Install: brew install azure-cli && az login" >&2
  exit 1
fi

echo "==> Resource group: $RG ($LOCATION)"
az group create --name "$RG" --location "$LOCATION" --output none

echo "==> Cosmos DB account: $ACCOUNT (SQL API, serverless)"
# Serverless keeps cost low for dev; swap to --capabilities EnableServerless
# removal + throughput for production provisioned mode.
az cosmosdb create \
  --name "$ACCOUNT" \
  --resource-group "$RG" \
  --kind GlobalDocumentDB \
  --default-consistency-level Session \
  --capabilities EnableServerless \
  --locations regionName="$LOCATION" failoverPriority=0 isZoneRedundant=false \
  --output none

echo "==> Database: $DATABASE"
az cosmosdb sql database create \
  --account-name "$ACCOUNT" \
  --resource-group "$RG" \
  --name "$DATABASE" \
  --output none

echo "==> Container: $TASKS_CONTAINER (partition key /organizationId)"
az cosmosdb sql container create \
  --account-name "$ACCOUNT" \
  --resource-group "$RG" \
  --database-name "$DATABASE" \
  --name "$TASKS_CONTAINER" \
  --partition-key-path "/organizationId" \
  --output none

echo "==> Container: $FORMS_CONTAINER (partition key /organizationId)"
az cosmosdb sql container create \
  --account-name "$ACCOUNT" \
  --resource-group "$RG" \
  --database-name "$DATABASE" \
  --name "$FORMS_CONTAINER" \
  --partition-key-path "/organizationId" \
  --output none

echo ""
echo "==> Connection string (paste into kitameraki-be/local.settings.json -> COSMOS_CONNECTION_STRING):"
az cosmosdb keys list \
  --name "$ACCOUNT" \
  --resource-group "$RG" \
  --type connection-strings \
  --query "connectionStrings[0].connectionString" \
  --output tsv
