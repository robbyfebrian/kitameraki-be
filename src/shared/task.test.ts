import { describe, expect, it } from "vitest";
import { stripMetadata, taskInputSchema, taskPatchSchema, taskSchema, toTask } from "./task";

const validTask = {
    id: "a1b2c3d4-e5f6-4a7b-8c9d-000000000001",
    organizationId: "8f14e45f-ceea-4c28-9d6f-2b1c0c4c9d10",
    title: "Write docs",
    status: "todo",
    customFields: {},
};

describe("taskInputSchema", () => {
    it("accepts a minimal body and applies no defaults to optional fields", () => {
        const parsed = taskInputSchema.parse({ title: "Write docs" });
        expect(parsed.title).toBe("Write docs");
        expect(parsed.status).toBeUndefined();
    });

    it("rejects an empty title and an unknown status", () => {
        expect(taskInputSchema.safeParse({ title: "" }).success).toBe(false);
        expect(taskInputSchema.safeParse({ title: "x", status: "archived" }).success).toBe(false);
    });

    it("enforces the title length cap", () => {
        expect(taskInputSchema.safeParse({ title: "x".repeat(101) }).success).toBe(false);
    });

    it("accepts null custom field values", () => {
        const parsed = taskInputSchema.parse({ title: "x", customFields: { client_email: null, department: "Ops" } });
        expect(parsed.customFields).toEqual({ client_email: null, department: "Ops" });
    });
});

describe("taskPatchSchema", () => {
    it("allows an empty patch (partial)", () => {
        expect(taskPatchSchema.safeParse({}).success).toBe(true);
    });

    it("still validates the fields it is given", () => {
        expect(taskPatchSchema.safeParse({ status: "completed" }).success).toBe(true);
        expect(taskPatchSchema.safeParse({ status: "nope" }).success).toBe(false);
    });
});

describe("stripMetadata", () => {
    it("drops Cosmos system keys and keeps everything else", () => {
        const cleaned = stripMetadata({ _rid: "x", _etag: "y", _ts: 1, title: "t", status: "todo" });
        expect(cleaned).toEqual({ title: "t", status: "todo" });
    });

    it("keeps keys that merely contain an underscore", () => {
        expect(stripMetadata({ custom_field: 1 })).toEqual({ custom_field: 1 });
    });
});

describe("toTask", () => {
    it("parses a Cosmos document into the task contract, stripping metadata", () => {
        const task = toTask({ ...validTask, _rid: "x", _etag: "y" });
        expect(task).toEqual(validTask);
        expect("_rid" in task).toBe(false);
    });

    it("throws when the document does not satisfy the contract", () => {
        expect(() => toTask({ ...validTask, status: "archived" })).toThrow();
    });
});

describe("taskSchema", () => {
    it("requires the fields every stored task must have", () => {
        expect(taskSchema.safeParse(validTask).success).toBe(true);
        expect(taskSchema.safeParse({ ...validTask, id: undefined }).success).toBe(false);
        expect(taskSchema.safeParse({ ...validTask, organizationId: undefined }).success).toBe(false);
    });
});
