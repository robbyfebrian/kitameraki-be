import { InvocationContext } from "@azure/functions";
import { JSONObject } from "@azure/cosmos";
import { getFormSettingsContainer, getFormSettingsHistoryContainer } from "../../platform/cosmos";
import { BatchOperation, runBatch } from "../../platform/batch";
import { ConflictError, ValidationError } from "../../platform/http";
import { KeyMigrationReport, diffCustomFieldKeys } from "./keyMigration";
import {
    FORM_SETTINGS_ID,
    FormSettings,
    FormSettingsHistory,
    FormSettingsStaging,
    STAGING_FORM_ID,
    formDefinitionSchema,
} from "./schema";
import {
    assertNoLivePublish,
    clearStaging,
    listHistory,
    readFormSettings,
    readHistory,
    writeStaging,
} from "./repo";
import { migrateRenamedKeys } from "../task/migration";

/* Publishing a form definition.

   Cosmos has no cross-container transaction, so migrating stored answers (Tasks
   container) and publishing the definition (FormSettings) cannot commit
   together. The flow is therefore journaled:

     1. persist a staging document with the intended definition and the renames,
     2. migrate answers in transactional batches, checkpointing progress,
     3. finalise atomically IN ONE CONTAINER: replace the definition (guarded by
        the etag read in step 1), snapshot the version into history, delete the
        staging document.

   If step 2 or 3 fails, the published definition is unchanged, so no reader ever
   sees a definition whose answers were not migrated, and the answer rename is
   additive and replayable, so a retry resumes instead of corrupting data. */

export interface PublishResult {
    settings: FormSettings;
    migrations: KeyMigrationReport[];
    resumed: boolean;
}

function assertVersionMatches(existing: FormSettings | undefined, requestedVersion: number): void {
    if (existing && requestedVersion !== existing.version) {
        throw new ConflictError(`Version conflict: expected ${existing.version}, got ${requestedVersion}`);
    }
}

export async function publishFormSettings(
    organizationId: string,
    body: FormSettings,
    context: InvocationContext
): Promise<PublishResult> {
    const { settings: existing, etag: existingEtag } = await readFormSettings(organizationId);
    assertVersionMatches(existing, body.version);

    // A live journal means another publish is mid-migration; a stale one is
    // discarded by the repo so a crashed worker cannot block publishing.
    const liveStaging = await assertNoLivePublish(organizationId);

    // Renaming a custom field's key would orphan the answers stored under the
    // old key. Diff the persisted definition against the incoming one and
    // migrate every task BEFORE publishing, so the published form never points
    // at keys the data has not caught up with.
    const renames = liveStaging ? liveStaging.renames : diffCustomFieldKeys(existing, body);
    const targetVersion = existing ? existing.version + 1 : body.version ?? 0;

    const saved: FormSettings = {
        ...body,
        id: FORM_SETTINGS_ID,
        organizationId,
        version: targetVersion,
        updatedAt: new Date().toISOString(),
    };

    const staging: FormSettingsStaging = liveStaging ?? {
        id: STAGING_FORM_ID,
        organizationId,
        baseVersion: existing?.version ?? -1,
        targetVersion,
        baseEtag: existingEtag,
        definition: saved,
        renames,
        cursor: { renameIndex: 0, migratedTasks: 0 },
        state: "pending",
        startedAt: new Date().toISOString(),
    };

    // A resumed publish keeps the journal's base definition so the guard still
    // matches the version the caller originally read.
    if (!liveStaging) {
        await writeStaging(staging);
    } else if (liveStaging.baseVersion !== (existing?.version ?? -1)) {
        // The definition changed since the journal started: the journal is void.
        await clearStaging(organizationId);
        throw new ConflictError("Version conflict: the form settings changed concurrently, reload and retry");
    }

    const migrations = await migrateRenamedKeys(organizationId, staging.renames, context, {
        resumeFrom: staging.cursor,
        onBatchCommitted: async (reports, progress) => {
            await writeStaging({ ...staging, cursor: progress, state: "pending" });
        },
    });

    await finalizePublish(staging, saved, migrations, organizationId, context);

    return { settings: saved, migrations, resumed: Boolean(liveStaging) };
}

/* Step 3: the definition and the journal share the FormSettings container and
   the organization partition, so swapping them really is one atomic batch:
   either the new version is published and the journal is gone, or neither
   happened. The history snapshot lives in another container (no cross-container
   transaction in Cosmos) and is written right after; losing it must not fail a
   publish that already committed. */
async function finalizePublish(
    staging: FormSettingsStaging,
    saved: FormSettings,
    migrations: KeyMigrationReport[],
    organizationId: string,
    context: InvocationContext
): Promise<void> {
    const history: FormSettingsHistory = {
        id: String(saved.version),
        organizationId,
        version: saved.version,
        definition: formDefinitionSchema.parse({
            version: saved.version,
            title: saved.title,
            description: saved.description,
            coreFields: saved.coreFields,
            customFields: saved.customFields,
            rows: saved.rows,
        }),
        migrations,
        publishedAt: saved.updatedAt,
        publishedBy: null,
    };

    const container = getFormSettingsContainer();
    const operations: BatchOperation[] = [
        staging.baseEtag
            ? {
                  // Replace with an etag guard is the last optimistic check.
                  operationType: "Replace",
                  id: FORM_SETTINGS_ID,
                  resourceBody: asBody(saved),
              }
            : {
                  operationType: "Create",
                  id: FORM_SETTINGS_ID,
                  resourceBody: asBody(saved),
              },
        {
            operationType: "Create",
            id: history.id,
            resourceBody: asBody(history),
        },
        {
            operationType: "Delete",
            id: STAGING_FORM_ID,
        },
    ];

    const conflict = () =>
        new ConflictError("Version conflict: the form settings changed concurrently, reload and retry");

    try {
        await runBatch(container, operations, organizationId, {
            onFailure: (error) => {
                if (error.code === 412 || error.code === 409) throw conflict();
                throw error;
            },
        });
    } catch (err) {
        // Cosmos can also reject the whole batch as a transport error (no
        // per-operation statuses) with the same codes; map those identically.
        const code = (err as { code?: number }).code;
        if (code === 412 || code === 409) throw conflict();
        throw err;
    }

    // History lives in its own container, which the batch above cannot include.
    // It is written after the atomic commit; a failure here leaves the definition
    // published, so it must not fail the request.
    try {
        await getFormSettingsHistoryContainer().items.upsert(history);
    } catch (err) {
        context.error("form history write failed", { org: organizationId, version: saved.version, err });
    }
}

function asBody(document: object): JSONObject {
    return document as unknown as JSONObject;
}

export async function getFormSettings(organizationId: string): Promise<FormSettings | undefined> {
    const { settings } = await readFormSettings(organizationId);
    return settings;
}

export async function getHistory(organizationId: string, version?: number): Promise<FormSettingsHistory[]> {
    if (version !== undefined) {
        const entry = await readHistory(organizationId, version);
        if (!entry) throw new ValidationError(`No published version ${version}`);
        return [entry];
    }
    return listHistory(organizationId, 20);
}
