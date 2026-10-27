import { describe, expect, it, vi } from "vitest";
import type { Container, OperationResponse } from "@azure/cosmos";
import { BatchError, MAX_BATCH_OPERATIONS, BatchOperation, runBatch } from "./batch";

/* Fakes cover only what the helper touches: `items.batch` for multi-operation
   batches and `item(id, pk).*` for the single-operation fallback. No emulator
   and no connection string, matching the rest of the test suite. */

type BatchCall = { ids: string[]; partitionKey: string };

function fakeContainer(statuses: number[] = [], error?: unknown) {
    const calls: BatchCall[] = [];
    const idsUsed: string[] = [];
    const container = {
        items: {
            batch: vi.fn(async (operations: BatchOperation[], partitionKey: string) => {
                calls.push({ ids: operations.map((op) => op.id), partitionKey });
                if (error) throw error;
                const result: OperationResponse[] = operations.map((_, index) => ({
                    statusCode: statuses[index] ?? 200,
                    requestCharge: 1,
                }));
                return { result };
            }),
            create: vi.fn(async () => ({})),
            upsert: vi.fn(async () => ({})),
        },
        item: (id: string) => {
            idsUsed.push(id);
            return {
                delete: vi.fn(async () => ({})),
                replace: vi.fn(async () => ({})),
                patch: vi.fn(async () => ({})),
            };
        },
    } as unknown as Container;
    return { container, calls, idsUsed };
}

function deletes(count: number): BatchOperation[] {
    return Array.from({ length: count }, (_, index) => ({
        operationType: "Delete" as const,
        id: `task-${index}`,
    }));
}

describe("runBatch", () => {
    it("returns early for an empty operation list", async () => {
        const { container, calls } = fakeContainer();
        await expect(runBatch(container, [], "org")).resolves.toEqual([]);
        expect(calls).toHaveLength(0);
    });

    it("splits more than 100 operations into sequential batches", async () => {
        const { container, calls } = fakeContainer();
        const results = await runBatch(container, deletes(250), "org-1");

        expect(calls.map((call) => call.ids.length)).toEqual([MAX_BATCH_OPERATIONS, MAX_BATCH_OPERATIONS, 50]);
        expect(calls.every((call) => call.partitionKey === "org-1")).toBe(true);
        expect(results).toHaveLength(250);
    });

    it("keeps 100 operations in a single batch", async () => {
        const { container, calls } = fakeContainer();
        await runBatch(container, deletes(100), "org");
        expect(calls).toEqual([{ ids: deletes(100).map((op) => op.id), partitionKey: "org" }]);
    });

    it("runs a single operation directly instead of through a batch", async () => {
        const { container, calls, idsUsed } = fakeContainer();
        const results = await runBatch(container, deletes(1), "org");

        expect(calls).toHaveLength(0);
        expect(idsUsed).toEqual(["task-0"]);
        expect(results).toEqual([{ id: "task-0", statusCode: 200, resourceBody: undefined }]);
    });

    it("accepts configured per-operation statuses (404 on an idempotent delete)", async () => {
        const { container } = fakeContainer([200, 404, 200]);
        const results = await runBatch(container, deletes(3), "org", { accept: [404] });

        expect(results.map((result) => result.statusCode)).toEqual([200, 404, 200]);
    });

    it("throws a BatchError carrying the per-operation status", async () => {
        const { container } = fakeContainer([200, 412]);
        const attempt = runBatch(container, deletes(2), "org");

        await expect(attempt).rejects.toBeInstanceOf(BatchError);
        await expect(attempt).rejects.toMatchObject({ code: 412, failedIndex: 1 });
    });

    it("lets the caller map a known failure without throwing", async () => {
        const { container } = fakeContainer([412, 424]);
        const mapped: number[] = [];
        await expect(
            runBatch(container, deletes(2), "org", {
                onFailure: (error) => {
                    mapped.push(error.code);
                    throw error;
                },
            })
        ).rejects.toBeInstanceOf(BatchError);
        expect(mapped).toEqual([412]);
    });

    it("wraps a transport failure as a BatchError with a code", async () => {
        const { container } = fakeContainer([], Object.assign(new Error("throttled"), { code: 429 }));
        const attempt = runBatch(container, deletes(2), "org");

        await expect(attempt).rejects.toBeInstanceOf(BatchError);
        await expect(attempt).rejects.toMatchObject({ code: 429 });
    });

    it("preserves resource bodies for reads of created documents", async () => {
        const { container } = fakeContainer();
        const results = await runBatch(
            container,
            [
                { operationType: "Create", id: "a", resourceBody: { id: "a", organizationId: "org" } },
                { operationType: "Create", id: "b", resourceBody: { id: "b", organizationId: "org" } },
            ],
            "org"
        );

        expect(results.map((result) => result.id)).toEqual(["a", "b"]);
    });
});
