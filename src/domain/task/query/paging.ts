import { QueryParameter, TaskQueryPlan } from "./filter";

/* Page assembly for the two-leg paging design, kept apart from the SQL builder
   because it is pure arithmetic: given a page offset and the per-leg counts, it
   says which slices to fetch and how to glue them back together. */

export interface PagedQuerySpec {
    query: string;
    parameters: QueryParameter[];
}

/* Shared shape of the three paged SELECT builders: the plan's WHERE (plus a
   per-leg suffix), one ORDER BY, then the plan's parameters with @offset and
   @limit appended. */
export function pagedSpec(plan: TaskQueryPlan, whereSuffix: string, orderBy: string, offset: number, limit: number): PagedQuerySpec {
    return {
        query: `SELECT * FROM c WHERE ${plan.where}${whereSuffix} ORDER BY ${orderBy} OFFSET @offset LIMIT @limit`,
        parameters: [
            ...plan.parameters,
            { name: "@offset", value: offset },
            { name: "@limit", value: limit },
        ],
    };
}

/* A task "has" the sort field only when it is present AND non-null. A stored
   custom field is often explicitly null (the FE serializes an empty answer as
   null), and IS_DEFINED alone counts that as present — which put nulls first
   under ORDER BY ASC. The two legs are exact complements of this predicate. */
export function hasSortField(field: string): string {
    return `IS_DEFINED(${field}) AND NOT IS_NULL(${field})`;
}

/* Items WITH the sort field, sorted properly. ORDER BY takes a property path
   only, so the IS_DEFINED/IS_NULL filter in the WHERE (not an expression in
   ORDER BY) keeps leg A deterministic. */
export function legAQuery(plan: TaskQueryPlan, offset: number, limit: number): PagedQuerySpec {
    return pagedSpec(plan, ` AND ${hasSortField(plan.sortField!)}`, `${plan.sortField} ${plan.sortDirection}`, offset, limit);
}

/* Items WITHOUT the sort field, kept stable by createdAt DESC. Nulls last
   regardless of direction — the merge below decides the order. */
export function legBQuery(plan: TaskQueryPlan, offset: number, limit: number): PagedQuerySpec {
    return pagedSpec(plan, ` AND NOT (${hasSortField(plan.sortField!)})`, "c.createdAt DESC", offset, limit);
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
        query: `SELECT VALUE COUNT(1) FROM c WHERE ${plan.where} AND ${hasSortField(plan.sortField!)}`,
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
