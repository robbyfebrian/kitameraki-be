# Kitameraki Backend

Azure Functions v4 (Node 20, TypeScript) HTTP API backing the task management
client. Tasks and per-organization form settings are stored in Azure Cosmos DB.

This README covers how to run it locally, what every route does, the design
decisions behind the refactor, and how the project answers the assignment
brief (security, readability, maintainability, Part 2 endpoints).

- [Stack](#stack)
- [Project layout](#project-layout)
- [Run locally](#run-locally)
- [Environment variables](#environment-variables)
- [Seeding data](#seeding-data)
- [API reference](#api-reference)
- [Data model](#data-model)
- [Design decisions](#design-decisions)
- [Testing](#testing)
- [Refactor notes (assignment)](#refactor-notes-assignment)
- [Deploy](#deploy)

## Stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 20 (Azure Functions v4 programming model) |
| Language | TypeScript (strict) |
| Database | Azure Cosmos DB, SQL API, partition key `/organizationId` |
| Validation | Zod schemas, one source of truth per entity |
| Tests | Vitest (unit tests on the pure logic) |

## Project layout

```
src/
  index.ts              Functions host setup (HTTP streaming)
  functions/            One file per HTTP route; thin, no business logic
  shared/
    http.ts             Response helpers, CORS, request wrapper, error mapping
    validate.ts         Zod parse -> typed value or ValidationError
    cosmos.ts           Cosmos client + container accessors (I/O only)
    task.ts             Task contract (schemas + document mapping) - pure
    tasksRepo.ts        Single-document I/O for tasks
    formSettings.ts     Form settings contract (schema) - pure
    taskQuery.ts        Query wire contract + pure SQL/page builders
    tasksMigrate.ts     Key-rename data migration over tasks
    migrateKeys.ts      Rename diff + per-task rewrite - pure
  seed.ts               Seed task + form data used by the seeding script
  infra/
    cosmosTools.ts      Shared wipe/write helpers for the scripts
    reseed.ts           Wipe + seed entrypoint
    clear.ts            Wipe-only entrypoint
infra/
  init-db.sh            Create database + containers
  seed.sh               Reseed entrypoint (wrapper around src/infra)
  provision-cosmos.sh   Provision a Cosmos account on Azure
docker-compose.yml      Local Cosmos DB emulator
```

Routes are deliberately thin: each `functions/*.ts` parses its inputs, calls the
Cosmos container, and returns. Cross-cutting concerns live in `shared/`.

## Run locally

No Azure subscription is required. The local Cosmos DB emulator runs in Docker.

```bash
# 1. Start the emulator (Docker Desktop must be running)
docker compose up -d
curl -fk https://localhost:8081/_explorer/emulator.pem > /dev/null && echo "emulator up"

# 2. Install dependencies and create the database + containers
npm install
cp local.settings.example.json local.settings.json   # emulator defaults, ready to run
./infra/init-db.sh

# 3. (optional) Seed the database with sample tasks + form settings
./infra/seed.sh

# 4. Run the API
npm start          # cleans, builds with tsc, then starts func on :7071
```

The API is then at `http://localhost:7071/api`.

For watch mode, run `npm run watch` in one terminal and `func start` in another.

If `npm start` reports `address already in use`, another Functions host is
already on 7071 — find it with `lsof -nP -iTCP:7071 -sTCP:LISTEN`.

### Host architecture (Apple Silicon vs Intel)

The `vnext` emulator image is published per CPU architecture. `vnext-latest`
defaults to the **arm64** build, which crashes under QEMU on an Intel host, so
`docker-compose.yml` pins the **amd64** build and both are overridable:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COSMOS_EMULATOR_IMAGE` | `...:vnext-latest-amd64` | Emulator image tag; use `vnext-latest-arm64` on Apple Silicon |
| `COSMOS_GATEWAY_PORT` | `8081` | Host port for the HTTPS gateway |
| `COSMOS_HEALTH_PORT` | `8080` | Host port for the health probe |
| `COSMOS_EXPLORER_PORT` | `1234` | Host port for the data explorer |

Set them in a `.env` file (gitignored). If 8080/8081/1234 are already taken on
your machine, shift the host ports only — for example:

```
COSMOS_GATEWAY_PORT=8091
COSMOS_HEALTH_PORT=8090
```

Then point `COSMOS_CONNECTION_STRING` in `local.settings.json` at the same
gateway port (`AccountEndpoint=https://localhost:8091/;...`) and re-run
`./infra/init-db.sh`. Keep the container-side ports fixed; only the host mapping
changes, so the emulator's internal config is untouched.

### Emulator vs. real Azure

`local.settings.json` ships with `COSMOS_EMULATOR=true`, which makes
`src/shared/cosmos.ts` accept the emulator's self-signed certificate. When you
point at a real account, **remove that key** so TLS validation stays on.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `COSMOS_CONNECTION_STRING` | yes | — | Cosmos DB connection string (fails fast if missing) |
| `COSMOS_DATABASE` | no | `TaskApp` | Database name |
| `COSMOS_TASKS_CONTAINER` | no | `Tasks` | Tasks container name |
| `COSMOS_FORM_SETTINGS_CONTAINER` | no | `FormSettings` | Form settings container name |
| `COSMOS_EMULATOR` | no | — | `true` only for the local emulator (relaxes TLS for its self-signed cert) |

The connection string is read from the environment only — never hardcoded.
`local.settings.json` is gitignored; `local.settings.example.json` is the
committed template. In Azure, context these as Application Settings instead.

## Seeding data

`./infra/seed.sh` wipes every task in the seed organization and writes the seed
tasks plus the seed form settings, using the same Cosmos connection the API uses.

```bash
./infra/seed.sh           # wipe tasks for the org, then seed tasks + form
./infra/seed.sh --clear   # wipe the org's tasks only, keep form settings
```

Seed data lives in `src/seed.ts` and is parsed through the live schemas before
it is written, so a schema change breaks the seed loudly rather than writing
drift. The front-end no longer ships a copy of the task seed.

## API reference

All routes are under `/api`, accept and return JSON, and require a valid
`organizationId` UUID query parameter (400 otherwise). Failures return
`{ "error": "..." }`.

| Method | Route | Query | Body | Success | Notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/InsertTask` | `organizationId` | `TaskInput` | 200, created `Task` | Server assigns `id`, `status` (default `todo`), timestamps |
| GET | `/api/GetTasks` | `organizationId` plus optional `search`, `status` (`todo`\|`in-progress`\|`completed`\|`all`), `priority` (`low`\|`medium`\|`high`\|`all`), `due` (`any`\|`overdue`\|`week`\|`month`\|`none`), `sortKey` (`title`\|`dueDate`\|`requestedDate`), `sortDirection` (`asc`\|`desc`), `page` (≥1), `pageSize` (1–100) | — | No `page`: 200, `Task[]`; with `page`: 200, `{ items, total, page, pageSize }` | Whole organization partition when no `page` (legacy shape); a single page when `page` is present |
| GET | `/api/GetTask` | `id`, `organizationId` | — | 200, `Task` / 404 | |
| POST | `/api/UpdateTask` | `id`, `organizationId` | partial `Task` | 200, `Task` | JSON-merge style patch; adds missing fields (e.g. `position`) |
| DELETE | `/api/DeleteTask` | `id`, `organizationId` | — | 200 | |
| DELETE | `/api/BulkDeleteTasks` | `organizationId` | `string[]` (1–100 ids) | 200 | |
| GET | `/api/GetFormSettings` | `organizationId` | — | 200, `FormSettings` / 204 | 204 when the org has no saved form yet |
| PUT | `/api/SaveFormSettings` | `organizationId` | `FormSettings` | 200, saved `FormSettings` / 409 | Version-number check, then a conditional `IfMatch` etag replace (`412` → `409`): two concurrent publishes can't silently clobber each other |

Error codes: `400` validation / bad `organizationId`, `404` missing task,
`409` stale form version or Cosmos conflict, `429` Cosmos throttling
(retry later), `500` unexpected.

### Examples

```bash
ORG="8f14e45f-ceea-4c28-9d6f-2b1c0c4c9d10"

# Create a task
curl -s -X POST "http://localhost:7071/api/InsertTask?organizationId=$ORG" \
  -H "Content-Type: application/json" \
  -d '{"title":"Write docs","description":"Cover local setup","priority":"high","tags":["docs"]}'

# List, read, update, delete
curl -s "http://localhost:7071/api/GetTasks?organizationId=$ORG"
curl -s "http://localhost:7071/api/GetTask?id=<taskId>&organizationId=$ORG"
curl -s -X POST "http://localhost:7071/api/UpdateTask?id=<taskId>&organizationId=$ORG" \
  -H "Content-Type: application/json" -d '{"status":"completed"}'
curl -s -X DELETE "http://localhost:7071/api/DeleteTask?id=<taskId>&organizationId=$ORG"

# Bulk delete
curl -s -X DELETE "http://localhost:7071/api/BulkDeleteTasks?organizationId=$ORG" \
  -H "Content-Type: application/json" -d '["<id1>","<id2>"]'

# Form settings: read (204 when unset), then save
curl -s "http://localhost:7071/api/GetFormSettings?organizationId=$ORG"
curl -s -X PUT "http://localhost:7071/api/SaveFormSettings?organizationId=$ORG" \
  -H "Content-Type: application/json" -d @task-form.json
```

A rejected request:

```bash
curl -s "http://localhost:7071/api/GetTasks?organizationId=nope"
# {"error":"organizationId must be a UUID"}   (HTTP 400)
```

## Data model

**Task** (FE wire contract mirrored by the BE zod modules `src/shared/task.ts`, `src/shared/formSettings.ts`, `src/shared/taskQuery.ts`):
`id`, `organizationId`, `title` (≤100), `description` (≤1000),
`status` (`todo` | `in-progress` | `completed`), `priority`
(`low` | `medium` | `high`), `dueDate`, `tags[]` (each ≤50),
`customFields` (map of `string` → `string` | `null`), `position`,
`createdAt`, `updatedAt`.

**FormSettings** (`src/shared/formSettings.ts`): one document per organization
with a fixed id `task-form`, `version` (optimistic concurrency), `title`,
`description`, `coreFields[]`, `customFields[]`, `rows[]` (layout: rows of up to
two field ids), `updatedAt`.

## Design decisions

- **Partition key = `organizationId`.** Every document is scoped to one
  organization, so reads and writes for an org stay in a single logical
  partition. Queries pass `partitionKey: organizationId`, letting Cosmos serve
  them from one partition instead of fanning out. Both containers use
  `/organizationId`.
- **One schema per entity, shared by the API and the tools.** Request bodies,
  stored documents and seed data all validate against the same Zod schema, so
  the contract cannot drift between layers.
- **Routes are thin; cross-cutting concerns are centralised.** CORS headers,
  error mapping and the one-line request log live in `shared/http.ts`, not
  repeated in every function.
- **I/O is separated from pure logic.** `shared/task.ts` holds only the contract
  and document mapping; the Cosmos client and single-document helpers live in
  `shared/cosmos.ts` / `shared/tasksRepo.ts`. That keeps the testable parts
  testable without a database.
- **Automatic indexing.** The default Cosmos policy indexes all properties,
  which covers the equality filter on `organizationId`; no custom policy needed.
- **CORS allows any origin.** The API is anonymous and carries no credentials,
  so a wildcard origin adds no exposure beyond the API being public. Tightening
  it is a one-line change if an origin allowlist is ever required.
- **Rate limiting is out of scope.** It belongs at the gateway layer (APIM or an
  equivalent front door), not in per-invocation function code.

## Testing

```bash
npm test    # vitest, unit tests on the pure logic
```

Tests cover the parts that carry logic and no I/O: input validation, the
`organizationId` / `id` guards, document mapping (`stripMetadata`, `toTask`),
the task schemas, and the request wrapper's error mapping (400/409/429/500 and
CORS preflight). They run against the TypeScript sources directly and need no
emulator or connection string. Integration tests against Cosmos are
intentionally out of scope for now.

## Refactor notes (assignment)

The brief asked to improve **security, readability and maintainability**, and to
add endpoints that store the form settings.

**Security**

- **Input validation at every trust boundary.** Every body and query parameter
  is validated before it reaches Cosmos (`shared/validate.ts`, Zod schemas).
- **`organizationId` is enforced as a UUID.** The partition key is the tenant
  boundary; validating it prevents requests from scoping to a phantom or
  malformed organization.
- **Secrets come from the environment only.** The Cosmos connection string is
  never hardcoded and the app fails fast if it is missing.
- **TLS stays on for real endpoints.** The self-signed-certificate relaxation
  applies only when `COSMOS_EMULATOR=true`.
- **Errors do not leak internals.** Unexpected failures return a generic 500
  message; the detail is logged server-side, never returned to the client.
- **Authentication is not implemented**, because the assignment specification
  does not ask for it (no login, user or session is part of the acceptance
  criteria). All routes are intentionally `authLevel: "anonymous"`. This is a
  deliberate, documented scope decision, not an oversight; the API is meant to
  run locally or behind a gateway that can add auth. *(Open question for
  review: should end-user authentication be added behind Azure API Management
  or via JWT on the functions themselves?)*

**Readability**

- Each route is a small, focused file (17–37 lines) with a single job.
- Names say what they mean; comments explain *why* (e.g. why a patch uses
  `add`, why form settings answer 204), not *what*.
- The whole backend is roughly 1,200 lines of source (excluding tests), small
  enough to read in one sitting.

**Maintainability**

- One schema per entity, reused by requests, storage and seed data.
- Shared helpers (`handler`, `validate`, `requireOrganizationId`) remove
  duplication and make behaviour uniform across routes.
- I/O and pure logic are separated so logic can be unit-tested without a
  database.
- Centralised error mapping means a new failure mode is handled once, for all
  routes.
- Seeding is scripted and idempotent (`./infra/seed.sh`), so a fresh environment
  is one command away.

**Part 2 — form settings endpoints**

- `GET /api/GetFormSettings` returns the organization's saved form (204 when
  none exists yet).
- `PUT /api/SaveFormSettings` stores it with a two-stage optimistic guard: a
  version-number check first, then a conditional replace (`IfMatch` etag, a
  `412` mapped to `409`), so two concurrent publishes cannot silently clobber
  each other.

## Deploy

The backend targets an Azure Function App. Set the same environment variables as
Application Settings (or use a Key Vault reference for the connection string).

To provision the Cosmos account and containers from scratch (requires an Azure
subscription — a tenant alone cannot create resources):

```bash
az login
./infra/provision-cosmos.sh [resource-group] [location] [account-name]
```

The script creates a serverless Cosmos DB SQL account, the `TaskApp` database,
and the `Tasks` / `FormSettings` containers (partition key `/organizationId`),
then prints the connection string.

Running the functions host in a container on a plain VPS is also possible:
build with `npm run build`, then run
`mcr.microsoft.com/azure-functions/node:4-node20` with `dist/` mounted and
`COSMOS_CONNECTION_STRING` pointed at a real account (the emulator is
development-only). Put a TLS-terminating proxy in front and set the client's
`NEXT_PUBLIC_API_BASE_URL` to the deployed `/api` URL.
