import { describe, expect, it } from "vitest";
import { FormSettings } from "./formSettings";
import { countTasksUsingKey, diffCustomFieldKeys, renameKeyOnTask } from "./migrateKeys";
import { Task } from "./task";

const ORG = "8f14e45f-ceea-4c28-9d6f-2b1c0c4c9d10";

function field(id: string, key: string, label = key) {
    return {
        id,
        key,
        label,
        type: "text" as const,
        required: false,
        width: 1 as const,
        active: true,
    };
}

function settings(customFields: ReturnType<typeof field>[]): FormSettings {
    return {
        id: "task-form",
        organizationId: ORG,
        version: 1,
        title: "Task",
        description: "",
        coreFields: [],
        customFields,
        rows: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
    };
}

function task(id: string, customFields: Record<string, string | null>): Task {
    return { id, organizationId: ORG, title: id, status: "todo", customFields };
}

describe("diffCustomFieldKeys", () => {
    it("returns nothing when there is no previous definition", () => {
        expect(diffCustomFieldKeys(undefined, settings([field("f1", "a")]))).toEqual([]);
    });

    it("detects a key change by stable field id", () => {
        const previous = settings([field("f1", "client_email")]);
        const next = settings([field("f1", "email_klien")]);
        expect(diffCustomFieldKeys(previous, next)).toEqual([
            { fieldId: "f1", from: "client_email", to: "email_klien" },
        ]);
    });

    it("ignores label-only edits and newly added fields", () => {
        const previous = settings([field("f1", "a", "A")]);
        const next = settings([field("f1", "a", "Renamed"), field("f2", "b")]);
        expect(diffCustomFieldKeys(previous, next)).toEqual([]);
    });

    it("still reports a rename when the field was temporarily hidden", () => {
        const previous = settings([field("f1", "a")]);
        const hidden = { ...field("f1", "a"), active: false };
        expect(diffCustomFieldKeys(previous, settings([hidden]))).toEqual([]);
        expect(diffCustomFieldKeys(previous, settings([{ ...hidden, key: "b" }]))).toEqual([
            { fieldId: "f1", from: "a", to: "b" },
        ]);
    });
});

describe("renameKeyOnTask", () => {
    it("moves the value from the old key to the new one", () => {
        const result = renameKeyOnTask(task("t1", { a: "hello", other: "keep" }), { from: "a", to: "b" });
        expect(result?.customFields).toEqual({ b: "hello", other: "keep" });
    });

    it("keeps null values in place, so a cleared answer stays cleared", () => {
        const result = renameKeyOnTask(task("t1", { a: null }), { from: "a", to: "b" });
        expect(result?.customFields).toEqual({ b: null });
    });

    it("returns null when the task never had the old key", () => {
        expect(renameKeyOnTask(task("t1", { other: "x" }), { from: "a", to: "b" })).toBeNull();
    });

    it("lets the renamed value win over a stale target value", () => {
        const result = renameKeyOnTask(task("t1", { a: "new", b: "stale" }), { from: "a", to: "b" });
        expect(result?.customFields).toEqual({ b: "new" });
    });

    it("does not mutate the input task", () => {
        const original = task("t1", { a: "x" });
        renameKeyOnTask(original, { from: "a", to: "b" });
        expect(original.customFields).toEqual({ a: "x" });
    });
});

describe("countTasksUsingKey", () => {
    it("counts only tasks with a non-empty value", () => {
        const tasks = [task("t1", { a: "x" }), task("t2", { a: "" }), task("t3", { a: null }), task("t4", {})];
        expect(countTasksUsingKey(tasks, "a")).toBe(1);
    });
});
