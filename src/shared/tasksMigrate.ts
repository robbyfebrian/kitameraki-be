import { InvocationContext } from "@azure/functions";
import { getTasksContainer } from "./cosmos";
import { KeyMigrationReport, KeyRename, renameKeyOnTask } from "./migrateKeys";
import { Task, toTask } from "./task";

/* Persist side of the key rename: instead of reading the whole partition, query
   per old key with IS_DEFINED over the bracketed key (dynamic keys need the
   quoted bracket form; the keys come from the server-side definition diff, so
   the identifier is never client-supplied). Tasks without the old key are
   therefore never read at all. Writes are batched with the shared
   COSMOS_BATCH_SIZE to stay inside Cosmos throughput limits; a failure
   surfaces to the caller, which keeps the save from silently publishing a
   definition whose answers were not migrated. */
export const COSMOS_BATCH_SIZE = 25;

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
    context: InvocationContext
): Promise<KeyMigrationReport[]> {
    if (renames.length === 0) return [];

    const patches: { id: string; customFields: Task["customFields"] }[] = [];
    const reports: KeyMigrationReport[] = [];

    for (const rename of renames) {
        const tasks = await listTasksWithKey(organizationId, rename.from);
        let migratedTasks = 0;
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

            migratedTasks += 1;
        }

        if (migratedTasks > 0) {
            reports.push({ fieldId: rename.fieldId, key: rename.to, renamedFrom: rename.from, migratedTasks });
        }
    }

    const container = getTasksContainer();
    for (let start = 0; start < patches.length; start += COSMOS_BATCH_SIZE) {
        const batch = patches.slice(start, start + COSMOS_BATCH_SIZE);
        await Promise.all(
            batch.map((entry) =>
                container.item(entry.id, organizationId).patch({
                    operations: [{ op: "set", path: "/customFields", value: entry.customFields }],
                })
            )
        );
    }

    context.log(
        `migrated ${patches.length} task(s) across ${renames.length} renamed key(s) org=${organizationId}`
    );
    return reports;
}
