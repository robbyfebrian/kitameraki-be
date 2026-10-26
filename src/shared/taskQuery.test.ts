import { describe, expect, it } from "vitest";
import {
    DEFAULT_PAGE_SIZE,
    buildTaskQuery,
    clampPage,
    countQuery,
    definedCountQuery,
    legAQuery,
    legBQuery,
    mergeLegSlices,
    pageFetchPlan,
    pagedNoSortQuery,
    shiftDate,
    taskQuerySchema,
} from "./taskQuery";
import { SEED_ORGANIZATION_ID } from "../seed";

const ORG = SEED_ORGANIZATION_ID;
const TODAY = "2026-10-26";

function plan(overrides: Record<string, unknown> = {}) {
    return buildTaskQuery(ORG, { ...overrides } as never, TODAY);
}

describe("taskQuerySchema", () => {
    it("coerces numeric query-string values", () => {
        const parsed = taskQuerySchema.parse({ page: "3", pageSize: "25" });
        expect(parsed).toEqual({ page: 3, pageSize: 25 });
    });

    it("rejects an unknown status enum value", () => {
        expect(taskQuerySchema.safeParse({ status: "archived" }).success).toBe(false);
    });

    it("rejects a non-positive or fractional page", () => {
        expect(taskQuerySchema.safeParse({ page: "0" }).success).toBe(false);
        expect(taskQuerySchema.safeParse({ page: "-1" }).success).toBe(false);
        expect(taskQuerySchema.safeParse({ page: "1.5" }).success).toBe(false);
    });

    it("rejects pageSize outside 1-100", () => {
        expect(taskQuerySchema.safeParse({ pageSize: "0" }).success).toBe(false);
        expect(taskQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
        expect(taskQuerySchema.safeParse({ pageSize: "100" }).success).toBe(true);
    });

    it("rejects an unknown due window and sort direction", () => {
        expect(taskQuerySchema.safeParse({ due: "quarter" }).success).toBe(false);
        expect(taskQuerySchema.safeParse({ sortDirection: "up" }).success).toBe(false);
    });
});

describe("buildTaskQuery", () => {
    it("scopes the query to the organization and nothing else by default", () => {
        const result = plan();
        expect(result.where).toBe("c.organizationId = @org");
        expect(result.parameters).toEqual([{ name: "@org", value: ORG }]);
        expect(result.sortField).toBeNull();
        expect(result.nullableSort).toBe(false);
    });

    it("adds equality filters for status and priority", () => {
        const result = plan({ status: "in-progress", priority: "high" });
        expect(result.where).toBe("c.organizationId = @org AND (c.status = @status) AND (c.priority = @priority)");
        expect(result.parameters).toEqual([
            { name: "@org", value: ORG },
            { name: "@status", value: "in-progress" },
            { name: "@priority", value: "high" },
        ]);
    });

    it("treats the all sentinel as absent", () => {
        const result = plan({ status: "all", priority: "all", due: "any" });
        expect(result.where).toBe("c.organizationId = @org");
    });

    it("emits the full overdue condition with the server-side today", () => {
        const result = plan({ due: "overdue" });
        expect(result.where).toBe(
            'c.organizationId = @org AND ((c.dueDate < @today) AND ((NOT IS_DEFINED(c.status)) OR (c.status != "completed")))'
        );
        expect(result.parameters).toEqual([
            { name: "@org", value: ORG },
            { name: "@today", value: TODAY },
        ]);
    });

    it("computes the week and month windows from UTC today", () => {
        const week = plan({ due: "week" });
        expect(week.where).toBe("c.organizationId = @org AND ((@today <= c.dueDate) AND (c.dueDate < @weekEnd))");
        expect(week.parameters).toEqual([
            { name: "@org", value: ORG },
            { name: "@today", value: TODAY },
            { name: "@weekEnd", value: "2026-11-02" },
        ]);

        const month = plan({ due: "month" });
        expect(month.parameters).toEqual([
            { name: "@org", value: ORG },
            { name: "@today", value: TODAY },
            { name: "@monthEnd", value: "2026-11-25" },
        ]);
    });

    it("emits the none window for missing or empty dueDate", () => {
        const result = plan({ due: "none" });
        expect(result.where).toBe('c.organizationId = @org AND ((NOT IS_DEFINED(c.dueDate)) OR (c.dueDate = ""))');
    });

    it("maps sort keys to Cosmos paths and defaults to ascending", () => {
        expect(plan({ sortKey: "dueDate" })).toMatchObject({
            sortField: "c.dueDate",
            sortDirection: "asc",
            nullableSort: true,
        });
        expect(plan({ sortKey: "requestedDate" })).toMatchObject({
            sortField: 'c.customFields["requested_at"]',
            nullableSort: true,
        });
        expect(plan({ sortKey: "title" })).toMatchObject({
            sortField: "c.title",
            nullableSort: false,
        });
        expect(plan({ sortKey: "title", sortDirection: "desc" }).sortDirection).toBe("desc");
    });
});

describe("paged query builders", () => {
    it("builds leg A with the IS_DEFINED filter and per-leg offset/limit parameters", () => {
        const p = plan({ sortKey: "dueDate", sortDirection: "desc" });
        const spec = legAQuery(p, 20, 10);
        expect(spec.query).toBe(
            "SELECT * FROM c WHERE " + p.where + " AND IS_DEFINED(c.dueDate) ORDER BY c.dueDate desc OFFSET @offset LIMIT @limit"
        );
        expect(spec.parameters.slice(-2)).toEqual([
            { name: "@offset", value: 20 },
            { name: "@limit", value: 10 },
        ]);
    });

    it("builds leg B stable-ordered by createdAt with the negated IS_DEFINED filter", () => {
        const p = plan({ sortKey: "requestedDate" });
        const spec = legBQuery(p, 0, 5);
        expect(spec.query).toBe(
            "SELECT * FROM c WHERE " + p.where + ' AND NOT IS_DEFINED(c.customFields["requested_at"]) ORDER BY c.createdAt DESC OFFSET @offset LIMIT @limit'
        );
    });

    it("builds the no-sort paged query without an ORDER BY on the sort field", () => {
        const p = plan({ status: "todo" });
        const spec = pagedNoSortQuery(p, 12, DEFAULT_PAGE_SIZE);
        expect(spec.query).toBe(
            "SELECT * FROM c WHERE " + p.where + " ORDER BY c.createdAt DESC OFFSET @offset LIMIT @limit"
        );
    });

    it("builds the plain and defined-only count queries", () => {
        const p = plan({ due: "overdue", sortKey: "dueDate" });
        expect(countQuery(p).query).toBe("SELECT VALUE COUNT(1) FROM c WHERE " + p.where);
        expect(definedCountQuery(p).query).toBe(
            "SELECT VALUE COUNT(1) FROM c WHERE " + p.where + " AND IS_DEFINED(c.dueDate)"
        );
    });

    it("keeps every plan parameter in front of the paging parameters", () => {
        const p = plan({ sortKey: "dueDate", status: "todo", priority: "low", due: "week" });
        const spec = legAQuery(p, 0, 10);
        const names = spec.parameters.map((parameter) => parameter.name);
        expect(names).toEqual(["@org", "@status", "@priority", "@today", "@weekEnd", "@offset", "@limit"]);
    });
});

describe("page math", () => {
    it("shifts dates across month and year boundaries in UTC", () => {
        expect(shiftDate("2026-10-31", 7)).toBe("2026-11-07");
        expect(shiftDate("2026-12-28", 7)).toBe("2027-01-04");
        expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    });

    it("takes from leg A first and spills the remainder into leg B", () => {
        expect(pageFetchPlan(2, 4, 3)).toEqual({ a: { offset: 2, limit: 1 }, b: { offset: 0, limit: 3 } });
        expect(pageFetchPlan(0, 4, 10)).toEqual({ a: { offset: 0, limit: 4 }, b: undefined });
        expect(pageFetchPlan(3, 2, 3)).toEqual({ a: undefined, b: { offset: 0, limit: 2 } });
        expect(pageFetchPlan(5, 3, 3)).toEqual({ a: undefined, b: { offset: 2, limit: 3 } });
    });

    it("still returns the leg B fetch past the end (it yields no rows anyway)", () => {
        expect(pageFetchPlan(10, 5, 0)).toEqual({ a: undefined, b: { offset: 10, limit: 5 } });
    });

    it("merges pages straddling the A/B boundary: null items always last", () => {
        const defined = ["d1", "d2", "d3", "d4", "d5", "d6"];
        const missing = ["m1", "m2", "m3"];
        const fetchLeg = (items: string[], leg?: { offset: number; limit: number }) =>
            leg ? items.slice(leg.offset, leg.offset + leg.limit) : [];

        // Page 2 of size 4 starts at offset 4, inside leg A, and straddles.
        const straddle = pageFetchPlan(4, 4, 6);
        expect(straddle).toEqual({ a: { offset: 4, limit: 2 }, b: { offset: 0, limit: 2 } });
        expect(
            mergeLegSlices(fetchLeg(defined, straddle.a), fetchLeg(missing, straddle.b), 6, 4, 4)
        ).toEqual(["d5", "d6", "m1", "m2"]);

        // First page sits fully inside leg A and never fetches leg B.
        const first = pageFetchPlan(0, 4, 6);
        expect(mergeLegSlices(fetchLeg(defined, first.a), fetchLeg(missing, first.b), 6, 0, 4)).toEqual([
            "d1",
            "d2",
            "d3",
            "d4",
        ]);

        // Past leg A entirely: only leg B is fetched.
        const tail = pageFetchPlan(6, 3, 6);
        expect(mergeLegSlices(fetchLeg(defined, tail.a), fetchLeg(missing, tail.b), 6, 6, 3)).toEqual([
            "m1",
            "m2",
            "m3",
        ]);
    });
});

describe("clampPage", () => {
    it("reports the clamped effective page like the FE paginate", () => {
        expect(clampPage(1, 12, 100)).toBe(1);
        expect(clampPage(3, 12, 30)).toBe(3);
        expect(clampPage(9, 12, 30)).toBe(3);
        expect(clampPage(5, 12, 0)).toBe(1);
    });
});
