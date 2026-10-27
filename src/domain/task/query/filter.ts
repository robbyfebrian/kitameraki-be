import { z } from "zod";

/* Wire contract for the paged/filtered/sorted task table. Mirrors the FE
   `taskQuerySchema` in kitameraki-fe/src/contracts/task.ts — the FE owns the
   contract, the BE mirrors it.

   This file turns a query into a WHERE clause (pure string building); page
   assembly lives in `paging.ts` so every filter/sort combination stays
   unit-testable without Cosmos. */

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

export type TaskQuery = z.infer<typeof taskQuerySchema>;

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
        // CONTAINS with a third `true` argument is case-insensitive. Cosmos SQL
        // has no COALESCE (the emulator rejects it with SC2005), so the missing
        // description is guarded with IS_DEFINED instead: a task without the
        // property simply fails the description arm and still matches on title.
        conditions.push(
            '(CONTAINS(c.title, @search, true) OR (IS_DEFINED(c.description) AND CONTAINS(c.description, @search, true)))'
        );
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
