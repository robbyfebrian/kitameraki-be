import { InvocationContext } from "@azure/functions";
import { getTasksContainer } from "../../platform/cosmos";
import { BatchOperation, MAX_BATCH_OPERATIONS, runBatch } from "../../platform/batch";
import { KeyMigrationReport, KeyRename, renameKeyOnTask } from "../form/keyMigration";
import { Task, toTask } from "./schema";

/* Persist side of the key rename: instead of reading the whole partition, query
   per old key with IS_DEFINED over the bracketed key (dynamic keys need the
   quoted bracket form; the keys come from the server-side definition diff, so
   the identifier is never client-supplied). Tasks without the old key are
   therefore never read at all.

   Writes go out as transactional batches of up to 100 patches inside the
   organization partition, so a batch is all-or-nothing and costs one request
   instead of one per document. The caller may persist progress after each
   committed batch, which is what lets a failed publish resume where it stopped
   instead of restarting: the rename is idempotent, so replaying is always safe. */

export interface MigrationProgress {
    /* Renames already fully applied, in definition order. */
    renameIndex: number;
    /* Total tasks patched so far, across all renames. */
    migratedTasks: number;
}

export interface MigrateOptions {
    /* Start point for a resumed publish. Renames before `renameIndex` are
       skipped; `migratedTasks` is carried forward so the report stays cumulative. */
    resumeFrom?: MigrationProgress;
    /* Called after every committed batch. Must persist before resolving, since
       the publish cannot proceed until progress is durable. */
    onBatchCommitted?: (reports: KeyMigrationReport[], progress: MigrationProgress) => Promise<void>;
}

async function listTasksWithKey(organizationId: string, key: string): Promise<Task[]> {
    const { resources } = await getTasksContainer()
        .items.query(
            {
                query: `SELECT * FROM c WHERE c.organizationId = @org AND IS_DEFINED(c.customFields["${key}"])`,
                parameters: [{ name: "@org", value: organizationId }],
            },
            { partitionKey: organizationId }
        )
        .fetchAll();
    return resources.map((resource) => toTask(resource));
}

export async function migrateRenamedKeys(
    organizationId: string,
    renames: KeyRename[],
    context: InvocationContext,
    options: MigrateOptions = {}
): Promise<KeyMigrationReport[]> {
    if (renames.length === 0) return [];

    const startIndex = options.resumeFrom?.renameIndex ?? 0;
    let migratedTasks = options.resumeFrom?.migratedTasks ?? 0;
    const patches: { id: string; customFields: Task["customFields"] }[] = [];
    const reports: KeyMigrationReport[] = [];

    for (let index = startIndex; index < renames.length; index += 1) {
        const rename = renames[index];
        const tasks = await listTasksWithKey(organizationId, rename.from);
        let renamedForField = 0;
        for (const task of tasks) {
            // A task can be touched by more than one rename in a single save.
            // Apply each rename to the already-patched copy so the last write
            // for a task contains every change, not just the latest rename.
            const existing = patches.find((entry) => entry.id === task.id);
            const source: Task = existing ? { ...task, customFields: existing.customFields } : task;
            const renamed = renameKeyOnTask(source, rename);
            if (!renamed) continue;

            if (existing) existing.customFields = renamed.customFields;
            else patches.push({ id: task.id, customFields: renamed.customFields });

            renamedForField += 1;
        }

        if (renamedForField > 0) {
            reports.push({ fieldId: rename.fieldId, key: rename.to, renamedFrom: rename.from, migratedTasks: renamedForField });
        }
    }

    for (let start = 0; start < patches.length; start += MAX_BATCH_OPERATIONS) {
        const chunk = patches.slice(start, start + MAX_BATCH_OPERATIONS);
        const operations: BatchOperation[] = chunk.map((entry) => ({
            operationType: "Patch",
            id: entry.id,
            resourceBody: { operations: [{ op: "set", path: "/customFields", value: entry.customFields }] },
        }));

        await runBatch(getTasksContainer(), operations, organizationId);

        migratedTasks += chunk.length;
        if (options.onBatchCommitted) {
            await options.onBatchCommitted(reports, { renameIndex: renames.length, migratedTasks });
        }
    }

    context.log(
        `migrated ${patches.length} task(s) across ${renames.length} renamed key(s) org=${organizationId}`
    );
    return reports;
}
