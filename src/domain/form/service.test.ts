import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvocationContext } from "@azure/functions";
import { SEED_ORGANIZATION_ID } from "../../seed";

/* Publish-flow tests. The Cosmos containers are faked in memory so the journal
   sequence (stage → migrate → atomic finalise → history) is exercised without
   an emulator, matching the rest of the suite. `platform/cosmos` constructs its
   client at import time, hence the dummy connection string set before importing
   the modules under test. */

process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdA==";

type Doc = Record<string, unknown> & { id: string; organizationId?: string };

const store = {
    settings: new Map<string, Doc>(),
    tasks: new Map<string, Doc>(),
    history: new Map<string, Doc>(),
    batchCalls: [] as string[][],
    failures: [] as { matchId?: string; code: number }[],
};

function key(id: string, organizationId: string): string {
    return `${organizationId}/${id}`;
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function peekFailure(ids: string[]): number | undefined {
    const index = store.failures.findIndex((failure) => !failure.matchId || ids.includes(failure.matchId));
    if (index === -1) return undefined;
    const [failure] = store.failures.splice(index, 1);
    return failure.code;
}

function fakeContainer(collection: Map<string, Doc>) {
    return {
        item: (id: string, organizationId: string) => ({
            read: vi.fn(async () => {
                const resource = collection.get(key(id, organizationId));
                return resource ? { resource: clone(resource) } : { resource: undefined };
            }),
            replace: vi.fn(async (body: Doc) => {
                collection.set(key(id, organizationId), clone(body));
                return { resource: body };
            }),
            patch: vi.fn(async (operations: { path: string; value: unknown }[]) => {
                const current = collection.get(key(id, organizationId)) ?? { id, organizationId };
                const next = { ...current } as Doc;
                for (const operation of operations) {
                    next[operation.path.slice(1)] = clone(operation.value);
                }
                collection.set(key(id, organizationId), next);
                return { resource: next };
            }),
            delete: vi.fn(async () => {
                collection.delete(key(id, organizationId));
                return {};
            }),
        }),
        items: {
            create: vi.fn(async (body: Doc) => {
                collection.set(key(body.id, String(body.organizationId)), clone(body));
                return { resource: body };
            }),
            upsert: vi.fn(async (body: Doc) => {
                collection.set(key(body.id, String(body.organizationId)), clone(body));
                return { resource: body };
            }),
            query: vi.fn((spec: { query: string; parameters: { name: string; value: unknown }[] }) => ({
                fetchAll: async () => {
                    // Only the tasks query performed by the rename migration is
                    // exercised here; match its IS_DEFINED shape.
                    const match = /customFields\["(.+)"\]/.exec(spec.query);
                    const org = spec.parameters.find((p) => p.name === "@org")?.value;
                    const resources = [...collection.values()].filter((doc) => {
                        if (doc.organizationId !== org) return false;
                        if (!match) return true;
                        const customFields = (doc.customFields ?? {}) as Record<string, unknown>;
                        return Object.prototype.hasOwnProperty.call(customFields, match[1]);
                    });
                    return { resources: clone(resources) };
                },
            })),
            batch: vi.fn(async (operations: Doc[], organizationId: string) => {
                const ids = operations.map((op) => `${String(op.id)}:${String(op.operationType)}`);
                store.batchCalls.push(ids);

                const failureCode = peekFailure(operations.map((op) => String(op.id)));
                if (failureCode !== undefined) {
                    const error = Object.assign(new Error("batch failed"), { code: failureCode });
                    throw error;
                }

                const result = operations.map((op: Doc) => {
                    const id = String(op.id);
                    const type = String(op.operationType);
                    if (type === "Replace" || type === "Create") {
                        collection.set(key(id, organizationId), clone(op.resourceBody as Doc));
                        return { statusCode: type === "Create" ? 201 : 200, requestCharge: 1 };
                    }
                    if (type === "Delete") {
                        collection.delete(key(id, organizationId));
                        return { statusCode: 204, requestCharge: 1 };
                    }
                    if (type === "Patch") {
                        const body = op.resourceBody as { operations: { path: string; value: unknown }[] };
                        const current = collection.get(key(id, organizationId)) ?? { id, organizationId };
                        const next = { ...current } as Doc;
                        for (const operation of body.operations) {
                            next[operation.path.slice(1)] = clone(operation.value);
                        }
                        collection.set(key(id, organizationId), next);
                        return { statusCode: 200, requestCharge: 1 };
                    }
                    return { statusCode: 200, requestCharge: 1 };
                });
                return { result };
            }),
        },
    };
}

vi.mock("../../platform/cosmos", () => ({
    getTasksContainer: () => fakeContainer(store.tasks),
    getFormSettingsContainer: () => fakeContainer(store.settings),
    getFormSettingsHistoryContainer: () => fakeContainer(store.history),
}));

const { publishFormSettings } = await import("./service");
const { ConflictError } = await import("../../platform/http");

const ORG = SEED_ORGANIZATION_ID;

function context(): InvocationContext {
    return { log: vi.fn(), error: vi.fn() } as unknown as InvocationContext;
}

function settingsDoc(version: number, key = "client_email") {
    return {
        id: "task-form",
        organizationId: ORG,
        version,
        title: "Task Form",
        description: "",
        coreFields: [{ key: "title", label: "Title", visible: true, width: 1 }],
        customFields: [
            {
                id: "c1",
                key,
                label: "Client email",
                type: "email",
                required: false,
                width: 1,
                active: true,
            },
        ],
        rows: [{ id: "row-1", fieldIds: ["c1"] }],
        updatedAt: "2026-10-27T00:00:00.000Z",
    };
}

function incoming(version: number, fieldKey = "client_email") {
    return { ...settingsDoc(version, fieldKey) };
}

function seedTask(id: string, customFields: Record<string, string | null>) {
    store.tasks.set(key(id, ORG), {
        id,
        organizationId: ORG,
        title: `Task ${id}`,
        status: "todo",
        customFields,
        createdAt: "2026-10-01T00:00:00.000Z",
    });
}

function reset() {
    store.settings.clear();
    store.tasks.clear();
    store.history.clear();
    store.batchCalls.length = 0;
    store.failures.length = 0;
}

describe("publishFormSettings", () => {
    beforeEach(reset);

    it("publishes a first version, writes history and clears the journal", async () => {
        const result = await publishFormSettings(ORG, incoming(0) as never, context());

        expect(result.settings.version).toBe(0);
        expect(store.settings.has(key("task-form", ORG))).toBe(true);
        expect(store.settings.has(key("task-form-staging", ORG))).toBe(false);
        expect(store.history.get(key("0", ORG))).toMatchObject({ version: 0, publishedBy: null });
    });

    it("increments the version and snapshots the published definition", async () => {
        store.settings.set(key("task-form", ORG), { ...settingsDoc(3), _etag: '"e3"' });

        const result = await publishFormSettings(ORG, incoming(3) as never, context());

        expect(result.settings.version).toBe(4);
        const snapshot = store.history.get(key("4", ORG)) as { definition: { version: number } };
        expect(snapshot.definition.version).toBe(4);
    });

    it("rejects a stale version before writing anything", async () => {
        store.settings.set(key("task-form", ORG), { ...settingsDoc(3), _etag: '"e3"' });

        await expect(publishFormSettings(ORG, incoming(2) as never, context())).rejects.toBeInstanceOf(ConflictError);
        expect(store.batchCalls).toHaveLength(0);
        expect(store.settings.has(key("task-form-staging", ORG))).toBe(false);
    });

    it("migrates renamed keys before publishing", async () => {
        store.settings.set(key("task-form", ORG), { ...settingsDoc(1, "client_email"), _etag: '"e1"' });
        seedTask("t1", { client_email: "a@acme.io" });
        seedTask("t2", { client_email: "b@acme.io" });

        const result = await publishFormSettings(ORG, incoming(1, "client_mail") as never, context());

        expect(result.migrations).toEqual([
            { fieldId: "c1", key: "client_mail", renamedFrom: "client_email", migratedTasks: 2 },
        ]);
        expect((store.tasks.get(key("t1", ORG))?.customFields as Record<string, unknown>).client_mail).toBe("a@acme.io");
        expect(store.settings.get(key("task-form", ORG))?.version).toBe(2);
    });

    it("leaves the published definition untouched when the final batch conflicts", async () => {
        store.settings.set(key("task-form", ORG), { ...settingsDoc(1), _etag: '"e1"' });
        store.failures.push({ matchId: "task-form", code: 412 });

        await expect(publishFormSettings(ORG, incoming(1) as never, context())).rejects.toBeInstanceOf(ConflictError);

        expect(store.settings.get(key("task-form", ORG))?.version).toBe(1);
        expect(store.settings.has(key("task-form-staging", ORG))).toBe(true);
        expect(store.history.size).toBe(0);
    });

    it("refuses a second publish while a live journal exists", async () => {
        store.settings.set(key("task-form", ORG), { ...settingsDoc(1), _etag: '"e1"' });
        store.settings.set(key("task-form-staging", ORG), {
            id: "task-form-staging",
            organizationId: ORG,
            baseVersion: 1,
            targetVersion: 2,
            definition: settingsDoc(2),
            renames: [],
            cursor: { renameIndex: 0, migratedTasks: 0 },
            state: "pending",
            startedAt: new Date().toISOString(),
        });

        await expect(publishFormSettings(ORG, incoming(1) as never, context())).rejects.toBeInstanceOf(ConflictError);
    });

    it("discards an abandoned journal instead of blocking forever", async () => {
        store.settings.set(key("task-form", ORG), { ...settingsDoc(1), _etag: '"e1"' });
        store.settings.set(key("task-form-staging", ORG), {
            id: "task-form-staging",
            organizationId: ORG,
            baseVersion: 1,
            targetVersion: 2,
            definition: settingsDoc(2),
            renames: [],
            cursor: { renameIndex: 0, migratedTasks: 0 },
            state: "pending",
            startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        });

        const result = await publishFormSettings(ORG, incoming(1) as never, context());

        expect(result.settings.version).toBe(2);
        expect(store.settings.has(key("task-form-staging", ORG))).toBe(false);
    });

    it("finalises settings, history and journal in one batch", async () => {
        store.settings.set(key("task-form", ORG), { ...settingsDoc(1), _etag: '"e1"' });

        await publishFormSettings(ORG, incoming(1) as never, context());

        expect(store.batchCalls.at(-1)).toEqual([
            "task-form:Replace",
            "2:Create",
            "task-form-staging:Delete",
        ]);
    });
});
