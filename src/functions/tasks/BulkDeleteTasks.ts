import { z } from "zod";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok } from "../../platform/http";
import { requireOrganizationId } from "../../platform/ids";
import { validate } from "../../platform/validate";
import { removeTasks } from "../../domain/task/service";

const bodySchema = z.array(z.string()).min(1).max(100);

/* One transactional batch per request: a 100-id body fits Cosmos' 100-operation
   batch limit and stays inside a single organization partition, so the delete
   is all-or-nothing instead of partially applied when a later id fails. */

async function BulkDeleteTasks(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const ids = validate(bodySchema, await request.json());

    await removeTasks(ids, organizationId, context);

    return ok(undefined, 200);
}

app.http("BulkDeleteTasks", {
    methods: ["DELETE", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("BulkDeleteTasks", BulkDeleteTasks),
});
