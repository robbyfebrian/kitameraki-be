import { z } from "zod";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getTasksContainer } from "../shared/cosmos";
import { handler, ok, requireOrganizationId } from "../shared/http";
import { validate } from "../shared/validate";
import { COSMOS_BATCH_SIZE } from "../shared/tasksMigrate";

const bodySchema = z.array(z.string()).min(1).max(100);

/* Batches of COSMOS_BATCH_SIZE with sequential awaits between batches, sharing
   the constant with the task migration write batching; one delete per id, no
   unbounded parallelism. */

async function BulkDeleteTasks(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const ids = validate(bodySchema, await request.json());

    const container = getTasksContainer();
    for (let start = 0; start < ids.length; start += COSMOS_BATCH_SIZE) {
        const batch = ids.slice(start, start + COSMOS_BATCH_SIZE);
        await Promise.all(batch.map((id) => container.item(id, organizationId).delete()));
    }

    return ok(undefined, 200);
}

app.http("BulkDeleteTasks", {
    methods: ["DELETE", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("BulkDeleteTasks", BulkDeleteTasks),
});
