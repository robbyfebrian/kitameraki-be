import {
    BulkOperationType,
    Container,
    CreateOperationInput,
    DeleteOperationInput,
    OperationInput,
    OperationResponse,
    PatchOperationInput,
    ReplaceOperationInput,
    UpsertOperationInput,
} from "@azure/cosmos";
import { ValidationError } from "./http";

/* Transactional batch writes for Cosmos DB SQL API.

   A batch is all-or-nothing but only inside ONE logical partition and at most
   100 operations. Every document in this app is partitioned by organizationId,
   so every multi-document write here (bulk delete, key rename, publish
   finalisation) can use it. There is no cross-container transaction in Cosmos,
   so a batch never spans two containers — callers keep such flows transactional
   at the application level (see the form publish journal). */

export const MAX_BATCH_OPERATIONS = 100;

export interface BatchResult<T = Record<string, unknown>> {
    id: string;
    statusCode: number;
    resourceBody?: T;
}

/* Cosmos answers a batch with a per-operation status; when one operation makes
   another fail, the dependent operations report 424. Surface the first real
   failure so the HTTP wrapper can map 412/409/429 as usual instead of turning
   every aborted batch into a 500. */
export class BatchError extends Error {
    constructor(
        message: string,
        readonly code: number,
        readonly failedIndex: number
    ) {
        super(message);
        this.name = "BatchError";
    }
}

/* Every batch operation carries the document id at the top level, so a failure
   stays identifiable even when Cosmos omits the per-operation body. */
export type BatchOperation = OperationInput & { id: string };

export interface RunBatchOptions {
    /* Per-operation statuses listed here are treated as success. Bulk delete
       uses this for 404: deleting an id that is already gone is a no-op. */
    accept?: number[];
    /* A batch can legitimately fail because a guarded replace lost an
       optimistic race (412) or a create hit an existing id (409). Callers map
       those themselves. */
    onFailure?: (error: BatchError) => never;
}

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let start = 0; start < items.length; start += size) {
        chunks.push(items.slice(start, start + size));
    }
    return chunks;
}

/* Run operations in batches of at most 100. `id` is required because a failed
   operation must be identifiable even when Cosmos omits its body. */
export async function runBatch(
    container: Container,
    operations: BatchOperation[],
    partitionKey: string,
    options: RunBatchOptions = {}
): Promise<BatchResult[]> {
    if (operations.length === 0) return [];

    const accepted = new Set(options.accept ?? []);
    const results: BatchResult[] = [];

    for (const batch of chunk(operations, MAX_BATCH_OPERATIONS)) {
        if (batch.length === 1) {
            // Cosmos rejects a one-operation batch in some emulator builds; a
            // single document is already atomic, so run it directly.
            results.push(await runSingle(container, batch[0], partitionKey, accepted, options));
            continue;
        }

        let response;
        try {
            response = await container.items.batch(batch, partitionKey);
        } catch (err) {
            throw asBatchError(err, 0);
        }

        const statuses: OperationResponse[] = response.result ?? [];
        for (let index = 0; index < batch.length; index += 1) {
            const statusCode = statuses[index]?.statusCode ?? 500;
            if (statusCode >= 400 && !accepted.has(statusCode)) {
                const error = new BatchError(
                    `Batch operation ${batch[index].id} failed with status ${statusCode}`,
                    statusCode,
                    index
                );
                if (options.onFailure) options.onFailure(error);
                throw error;
            }
            results.push({
                id: batch[index].id,
                statusCode,
                resourceBody: statuses[index]?.resourceBody as Record<string, unknown> | undefined,
            });
        }
    }

    return results;
}

async function runSingle(
    container: Container,
    operation: BatchOperation,
    partitionKey: string,
    accepted: Set<number>,
    options: RunBatchOptions
): Promise<BatchResult> {
    const item = container.item(operation.id, partitionKey);
    let statusCode = 200;
    try {
        switch (operation.operationType) {
            case BulkOperationType.Delete:
                await item.delete();
                break;
            case BulkOperationType.Replace:
                await item.replace((operation as ReplaceOperationInput).resourceBody);
                break;
            case BulkOperationType.Patch:
                await item.patch((operation as PatchOperationInput).resourceBody);
                break;
            case BulkOperationType.Create:
                await container.items.create((operation as CreateOperationInput).resourceBody);
                break;
            case BulkOperationType.Upsert:
                await container.items.upsert((operation as UpsertOperationInput).resourceBody);
                break;
            default:
                throw new ValidationError("Unsupported single operation in batch");
        }
    } catch (err) {
        const cosmosCode = (err as { code?: number }).code;
        statusCode = cosmosCode ?? 500;
        const acceptedStatus = cosmosCode !== undefined && accepted.has(statusCode);
        if (!acceptedStatus) {
            const error =
                cosmosCode === undefined
                    ? asBatchError(err, 0)
                    : new BatchError(`Operation ${operation.id} failed with status ${statusCode}`, statusCode, 0);
            if (options.onFailure) options.onFailure(error);
            throw error;
        }
    }
    return { id: operation.id, statusCode };
}

function asBatchError(err: unknown, index: number): BatchError {
    const code = (err as { code?: number }).code ?? 500;
    const message = err instanceof Error ? err.message : "Batch failed";
    return new BatchError(message, code, index);
}
