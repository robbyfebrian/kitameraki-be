import { InvocationContext } from "@azure/functions";
import { getTasksContainer } from "../../platform/cosmos";
import { assertCustomAnswers } from "./answerGuard";
import { deleteTask, deleteTasks, insertTask, item, patchTask } from "./repo";
import { Task, TaskInput, TaskPatch, toTask } from "./schema";
import {
    DEFAULT_PAGE_SIZE,
    PagedQuerySpec,
    buildTaskQuery,
    clampPage,
    countQuery,
    definedCountQuery,
    legAQuery,
    legBQuery,
    mergeLegSlices,
    pageFetchPlan,
    pagedNoSortQuery,
    TaskQuery,
} from "./query";

/* Task use-cases. Routes stay thin: they validate input, call one of these and
   wrap the result. The paged read is a deliberate two-leg design: Cosmos
   ORDER BY accepts a property path only (no CASE/COALESCE) and unreliably
   returns items that miss the sort field, so a page is served by a sorted leg
   over items that have the field plus a stable `createdAt DESC` leg over the
   rest, merged nulls-last by `mergeLegSlices`. */

export interface TaskPage {
    items: Task[];
    total: number;
    page: number;
    pageSize: number;
}

async function scalarCount(spec: PagedQuerySpec, organizationId: string): Promise<number> {
    const { resources } = await getTasksContainer()
        .items.query(spec, { partitionKey: organizationId })
        .fetchAll();
    return resources[0] ?? 0;
}

async function fetchSlice(spec: PagedQuerySpec, organizationId: string): Promise<Task[]> {
    const { resources } = await getTasksContainer()
        .items.query(spec, { partitionKey: organizationId })
        .fetchAll();
    return resources.map((resource) => toTask(resource));
}

/* The `page`-less path keeps the historical full-partition Task[] response
   (board, builder and migration flows rely on it). */
export async function listAllTasks(organizationId: string): Promise<Task[]> {
    const scope = buildTaskQuery(organizationId, {});
    const { resources } = await getTasksContainer()
        .items.query(
            {
                query: `SELECT * FROM c WHERE ${scope.where}`,
                parameters: scope.parameters,
            },
            { partitionKey: organizationId }
        )
        .fetchAll();

    return resources.map((resource) => toTask(resource));
}

export async function listTaskPage(organizationId: string, parsed: TaskQuery): Promise<TaskPage> {
    const pageSize = parsed.pageSize ?? DEFAULT_PAGE_SIZE;
    const plan = buildTaskQuery(organizationId, parsed);
    const requestedPage = parsed.page ?? 1;

    const total = await scalarCount(countQuery(plan), organizationId);
    // For a non-nullable sort the two counts coincide, so only one count query
    // runs; null-item count = total - definedCount.
    const definedCount = plan.nullableSort
        ? await scalarCount(definedCountQuery(plan), organizationId)
        : total;

    const page = clampPage(requestedPage, pageSize, total);
    const offset = (page - 1) * pageSize;

    let items: Task[];
    if (plan.sortField === null) {
        items = await fetchSlice(pagedNoSortQuery(plan, offset, pageSize), organizationId);
    } else {
        const fetchPlan = pageFetchPlan(offset, pageSize, definedCount);
        const [defined, missing] = await Promise.all([
            fetchPlan.a
                ? fetchSlice(legAQuery(plan, fetchPlan.a.offset, fetchPlan.a.limit), organizationId)
                : Promise.resolve([]),
            fetchPlan.b
                ? fetchSlice(legBQuery(plan, fetchPlan.b.offset, fetchPlan.b.limit), organizationId)
                : Promise.resolve([]),
        ]);
        items = mergeLegSlices(defined, missing, definedCount, offset, pageSize);
    }

    return { items, total, page, pageSize };
}

export async function getTask(id: string, organizationId: string): Promise<Task | undefined> {
    const { resource } = await item(id, organizationId).read();
    return resource ? toTask(resource) : undefined;
}

export async function createTask(organizationId: string, input: TaskInput): Promise<Task> {
    // Enforce the published form's field rules server-side, so an answer that
    // never went through the browser cannot be stored.
    await assertCustomAnswers(organizationId, input.customFields);
    return insertTask(organizationId, input);
}

export async function updateTask(id: string, organizationId: string, body: TaskPatch): Promise<Task> {
    // Validate the answers against the published form only when the patch
    // touches them, and against the MERGED result so required/date-bounds are
    // judged on what the task will actually store, not on the partial patch.
    if (body.customFields) {
        const { resource } = await item(id, organizationId).read();
        const stored = (resource as { customFields?: Record<string, string | null> } | undefined)?.customFields ?? {};
        await assertCustomAnswers(organizationId, { ...stored, ...body.customFields });
    }

    return patchTask(id, organizationId, body);
}

export async function removeTask(id: string, organizationId: string): Promise<void> {
    await deleteTask(id, organizationId);
}

export async function removeTasks(
    ids: string[],
    organizationId: string,
    context: InvocationContext
): Promise<void> {
    await deleteTasks(ids, organizationId);
    context.log(`bulk deleted ${ids.length} task(s) org=${organizationId}`);
}
