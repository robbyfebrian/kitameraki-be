import { InvocationContext } from "@azure/functions";
import { getTasksContainer } from "./cosmos";
import { KeyMigrationReport, KeyRename, renameKeyOnTask } from "./migrateKeys";
import { Task, toTask } from "./task";

/* Persist side of the key rename: walk every task in the organization partition
   and move answers from the old key to the new one. Tasks without the old key
   are skipped, so a rename only rewrites the documents it must.

   Writes are batched to stay inside Cosmos throughput limits and to avoid one
   round trip per task; a failure surfaces to the caller, which keeps the save
   from silently publishing a definition whose answers were not migrated. */
const BATCH_SIZE = 25;

async function listTasks(organizationId: string): Promise<Task[]> {
    const { resources } = await getTasksContainer()
        .items.query(
            {
                query: "SELECT * FROM c WHERE c.organizationId = @org",
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

    const tasks = await listTasks(organizationId);
    const patches: { id: string; customFields: Task["customFields"] }[] = [];
    const reports: KeyMigrationReport[] = [];

    for (const rename of renames) {
        let migratedTasks = 0;
        for (const task of tasks) {
            const renamed = renameKeyOnTask(task, rename);
            if (!renamed) continue;

            // A task can be touched by more than one rename in a single save.
            // Apply each rename to the already-patched copy so the last write
            // for a task contains every change, then update `tasks` in place.
            const existing = patches.find((entry) => entry.id === task.id);
            if (existing) existing.customFields = renamed.customFields;
            else patches.push({ id: task.id, customFields: renamed.customFields });

            task.customFields = renamed.customFields;
            migratedTasks += 1;
        }

        if (migratedTasks > 0) {
            reports.push({ fieldId: rename.fieldId, key: rename.to, renamedFrom: rename.from, migratedTasks });
        }
    }

    const container = getTasksContainer();
    for (let start = 0; start < patches.length; start += BATCH_SIZE) {
        const batch = patches.slice(start, start + BATCH_SIZE);
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
