import { randomUUID } from "crypto";
import { getTasksContainer } from "../../platform/cosmos";
import { BatchOperation, runBatch } from "../../platform/batch";
import { Task, TaskInput, toTask } from "./schema";

/* I/O for task documents. This is the only module that talks to the Tasks
   container on behalf of the HTTP routes, so batching and partition-key rules
   live in one place. Single-document operations are already atomic in Cosmos;
   multi-document writes go through `runBatch` (one partition, all-or-nothing). */

export function item(id: string, organizationId: string) {
    return getTasksContainer().item(id, organizationId);
}

export async function insertTask(organizationId: string, input: TaskInput): Promise<Task> {
    const now = new Date().toISOString();
    const created = await getTasksContainer().items.create({
        id: randomUUID(),
        organizationId,
        customFields: {},
        ...input,
        createdAt: now,
        updatedAt: now,
    });
    return toTask(created.resource ?? {});
}

export async function patchTask(id: string, organizationId: string, body: Partial<TaskInput>): Promise<Task> {
    // "add" upserts the path, so a patch can introduce fields the stored
    // document does not have yet (e.g. `position` on an older task). "replace"
    // fails when the node is absent.
    const patch = Object.entries({ ...body, updatedAt: new Date().toISOString() }).map(([key, value]) => ({
        op: "add" as const,
        path: `/${key}`,
        value,
    }));

    const updated = await item(id, organizationId).patch(patch);
    return toTask(updated.resource ?? {});
}

export async function deleteTask(id: string, organizationId: string): Promise<void> {
    await item(id, organizationId).delete();
}

/* One transactional batch (at most 100 deletes because the route caps the body
   at 100 id) instead of one request per id: all-or-nothing, fewer round trips
   and less RU. A 404 is accepted so deleting an already-deleted id, or retrying
   an aborted call, stays idempotent. */
export async function deleteTasks(ids: string[], organizationId: string): Promise<void> {
    const operations: BatchOperation[] = ids.map((id) => ({ operationType: "Delete", id }));
    await runBatch(getTasksContainer(), operations, organizationId, { accept: [404] });
}
