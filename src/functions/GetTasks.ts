import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getTasksContainer } from "../shared/cosmos";
import { handler, ok, requireOrganizationId } from "../shared/http";
import { toTask } from "../shared/task";
import { validate } from "../shared/validate";
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
    taskQuerySchema,
} from "../shared/taskQuery";

/* The `page`-less path keeps the historical full-partition Task[] response
   (board, builder and migration flows rely on it). With `page` present the
   response is { items, total, page, pageSize } — the FE TaskPage contract.

   Paging with a nullable sort field uses a deliberate two-leg design: Cosmos
   ORDER BY accepts a property path only (no CASE/COALESCE expressions) and
   unreliably returns items that miss the sort field, so a page is served by a
   sorted leg over items that have the field plus a stable `createdAt DESC`
   leg over the rest, merged nulls-last by `mergeLegSlices` — which MUST keep
   a unit test with a page straddling the A/B boundary. Until a live Cosmos
   verification happens, the SQL itself is only verified by unit tests on the
   generated strings. */

async function scalarCount(spec: PagedQuerySpec, organizationId: string): Promise<number> {
    const { resources } = await getTasksContainer()
        .items.query(spec, { partitionKey: organizationId })
        .fetchAll();
    return resources[0] ?? 0;
}

async function fetchSlice(spec: PagedQuerySpec, organizationId: string) {
    const { resources } = await getTasksContainer()
        .items.query(spec, { partitionKey: organizationId })
        .fetchAll();
    return resources.map((resource) => toTask(resource));
}

async function GetTasks(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const raw: Record<string, string> = {};
    for (const [key, value] of request.query.entries()) {
        if (key !== "organizationId" && value !== "") raw[key] = value;
    }
    const parsed = validate(taskQuerySchema, raw);

    if (parsed.page === undefined) {
        // The legacy path applies no optional filters, but the scope clause is
        // still built once, by the same buildTaskQuery the paged path uses.
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

        return ok(resources.map((resource) => toTask(resource)));
    }

    const pageSize = parsed.pageSize ?? DEFAULT_PAGE_SIZE;
    const plan = buildTaskQuery(organizationId, parsed);
    const container = getTasksContainer();

    const total = await scalarCount(countQuery(plan), organizationId);
    // For a non-nullable sort the two counts coincide, so only one count query
    // runs; null-item count = total - definedCount.
    const definedCount = plan.nullableSort
        ? await scalarCount(definedCountQuery(plan), organizationId)
        : total;

    const page = clampPage(parsed.page, pageSize, total);
    const offset = (page - 1) * pageSize;

    let items;
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

    return ok({ items, total, page, pageSize });
}

app.http("GetTasks", {
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("GetTasks", GetTasks),
});
