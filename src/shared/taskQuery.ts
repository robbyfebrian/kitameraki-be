import { z } from "zod";

/* Wire contract for the paged/filtered/sorted task table. Mirrors the FE
   `taskQuerySchema` in kitameraki-fe/src/contracts/task.ts — the FE owns the
   contract, the BE mirrors it.

   Server-side offset paging is built as pure SQL-building functions below so
   every filter/sort/leg combination is unit-testable without Cosmos. */

export const taskQuerySchema = z.object({
    search: z.string().optional(),
    status: z.enum(["todo", "in-progress", "completed", "all"]).optional(),
    priority: z.enum(["low", "medium", "high", "all"]).optional(),
    due: z.enum(["any", "overdue", "week", "month", "none"]).optional(),
    sortKey: z.enum(["title", "dueDate", "requestedDate"]).optional(),
    sortDirection: z.enum(["asc", "desc"]).optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

type TaskQuery = z.infer<typeof taskQuerySchema>;

/* Used when `page` is present but `pageSize` is not (chosen here so the FE can
   send only `page`); pageSize without page is ignored — the response is then
   the legacy full-partition array. */
export const DEFAULT_PAGE_SIZE = 12;

export interface QueryParameter {
    name: string;
    value: string | number;
}

export interface TaskQueryPlan {
    where: string;
    parameters: QueryParameter[];
    /* Cosmos ORDER BY accepts a property path only; expressions (CASE,
       COALESCE) and unreliably-returned missing fields make the ordering of a
       nullable property impossible in one query — hence the two-leg design. */
    sortField: string | null;
    sortDirection: "asc" | "desc";
    /* True when some tasks may miss the sort field and a second leg is needed. */
    nullableSort: boolean;
}

/* Cosmos sort is case-sensitive ordinal; the FE lowercases titles for sort.
   Accepted tolerance: mixed-case titles can interleave differently on the BE. */
const SORT_FIELDS: Record<NonNullable<TaskQuery["sortKey"]>, string> = {
    title: "c.title",
    dueDate: "c.dueDate",
    // Bracket access with a quoted key is standard Cosmos syntax.
    requestedDate: 'c.customFields["requested_at"]',
};

export function shiftDate(today: string, days: number): string {
    const base = new Date(`${today}T00:00:00.000Z`);
    return new Date(base.getTime() + days * 86400000).toISOString().slice(0, 10);
}

export function buildTaskQuery(
    organizationId: string,
    params: TaskQuery,
    today: string = new Date().toISOString().slice(0, 10)
): TaskQueryPlan {
    const conditions = ["c.organizationId = @org"];
    const parameters: QueryParameter[] = [{ name: "@org", value: organizationId }];

    const status = params.status && params.status !== "all" ? params.status : undefined;
    const priority = params.priority && params.priority !== "all" ? params.priority : undefined;

    if (status) {
        conditions.push("(c.status = @status)");
        parameters.push({ name: "@status", value: status });
    }
    if (priority) {
        conditions.push("(c.priority = @priority)");
        parameters.push({ name: "@priority", value: priority });
    }

    const search = params.search?.trim();
    if (search) {
        // CONTAINS with a third `true` argument is case-insensitive; COALESCE
        // covers tasks without a description property. If a live backend ever
        // rejects the COALESCE form, the documented fallback is dropping the
        // second CONTAINS (title-only search), not a quiet rewrite.
        conditions.push('(CONTAINS(c.title, @search, true) OR CONTAINS(COALESCE(c.description, ""), @search, true))');
        parameters.push({ name: "@search", value: search });
    }

    switch (params.due) {
        case "overdue":
            // A completed task is never overdue, mirroring the FE isOverdue.
            conditions.push('((c.dueDate < @today) AND ((NOT IS_DEFINED(c.status)) OR (c.status != "completed")))');
            parameters.push({ name: "@today", value: today });
            break;
        case "week":
            conditions.push("((@today <= c.dueDate) AND (c.dueDate < @weekEnd))");
            parameters.push(
                { name: "@today", value: today },
                { name: "@weekEnd", value: shiftDate(today, 7) }
            );
            break;
        case "month":
            conditions.push("((@today <= c.dueDate) AND (c.dueDate < @monthEnd))");
            parameters.push(
                { name: "@today", value: today },
                { name: "@monthEnd", value: shiftDate(today, 30) }
            );
            break;
        case "none":
            conditions.push('((NOT IS_DEFINED(c.dueDate)) OR (c.dueDate = ""))');
            break;
        // "any" and absent: no condition.
    }

    const sortField = params.sortKey ? SORT_FIELDS[params.sortKey] : null;
    return {
        where: conditions.join(" AND "),
        parameters,
        sortField,
        sortDirection: params.sortDirection ?? "asc",
        // `title` is required on every task; dueDate and the requested_at
        // custom field can be missing, so they page through two legs.
        nullableSort: sortField !== null && sortField !== SORT_FIELDS.title,
    };
}

export interface PagedQuerySpec {
    query: string;
    parameters: QueryParameter[];
}

/* Shared shape of the three paged SELECT builders: the plan's WHERE (plus a
   per-leg suffix), one ORDER BY, then the plan's parameters with @offset and
   @limit appended. */
function pagedSpec(plan: TaskQueryPlan, whereSuffix: string, orderBy: string, offset: number, limit: number): PagedQuerySpec {
    return {
        query: `SELECT * FROM c WHERE ${plan.where}${whereSuffix} ORDER BY ${orderBy} OFFSET @offset LIMIT @limit`,
        parameters: [
            ...plan.parameters,
            { name: "@offset", value: offset },
            { name: "@limit", value: limit },
        ],
    };
}

/* Items WITH the sort field, sorted properly. ORDER BY takes a property path
   only, so the IS_DEFINED filter in the WHERE (not an expression in ORDER BY)
   keeps leg A deterministic. */
export function legAQuery(plan: TaskQueryPlan, offset: number, limit: number): PagedQuerySpec {
    return pagedSpec(plan, ` AND IS_DEFINED(${plan.sortField})`, `${plan.sortField} ${plan.sortDirection}`, offset, limit);
}

/* Items WITHOUT the sort field, kept stable by createdAt DESC. Nulls last
   regardless of direction — the merge below decides the order. */
export function legBQuery(plan: TaskQueryPlan, offset: number, limit: number): PagedQuerySpec {
    return pagedSpec(plan, ` AND NOT IS_DEFINED(${plan.sortField})`, "c.createdAt DESC", offset, limit);
}

/* No sortKey: no ORDER BY on the sort field, but a fixed createdAt DESC keeps
   pages stable while the user moves between them. */
export function pagedNoSortQuery(plan: TaskQueryPlan, offset: number, limit: number): PagedQuerySpec {
    return pagedSpec(plan, "", "c.createdAt DESC", offset, limit);
}

export function countQuery(plan: TaskQueryPlan): PagedQuerySpec {
    return { query: `SELECT VALUE COUNT(1) FROM c WHERE ${plan.where}`, parameters: plan.parameters };
}

export function definedCountQuery(plan: TaskQueryPlan): PagedQuerySpec {
    return {
        query: `SELECT VALUE COUNT(1) FROM c WHERE ${plan.where} AND IS_DEFINED(${plan.sortField})`,
        parameters: plan.parameters,
    };
}

export interface LegFetch {
    offset: number;
    limit: number;
}

/* Walking the global page slice through the two legs is pure math above —
   the handler only runs the Cosmos queries this plan describes. */
export function pageFetchPlan(offset: number, limit: number, definedCount: number): { a?: LegFetch; b?: LegFetch } {
    const a: LegFetch | undefined = offset < definedCount
        ? { offset, limit: Math.min(limit, definedCount - offset) }
        : undefined;
    const fromA = a?.limit ?? 0;
    const b: LegFetch | undefined = limit - fromA > 0
        ? { offset: Math.max(0, offset - definedCount), limit: limit - fromA }
        : undefined;
    return { a, b };
}

/* Glues the two per-leg slices into one page. Items missing the sort field
   always come after those that have it, whatever the sort direction.
   MUST keep a unit test with a page straddling the A/B boundary. */
export function mergeLegSlices<T>(definedSlice: T[], missingSlice: T[], definedCount: number, offset: number, limit: number): T[] {
    const fromDefined = offset < definedCount ? Math.min(limit, definedCount - offset) : 0;
    const fromMissing = Math.max(0, limit - fromDefined);
    return [...definedSlice.slice(0, fromDefined), ...missingSlice.slice(0, fromMissing)];
}

/* Mirrors the FE paginate: report the clamped effective page, never one past
   the last page (and never below 1 for an empty result set). */
export function clampPage(page: number, pageSize: number, total: number): number {
    const last = Math.max(1, Math.ceil(total / pageSize));
    return Math.min(page, last);
}
