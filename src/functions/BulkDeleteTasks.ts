import { z } from "zod";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getTasksContainer } from "../shared/cosmos";
import { handler, ok, requireOrganizationId } from "../shared/http";
import { validate } from "../shared/validate";

const bodySchema = z.array(z.string()).min(1).max(100);

async function BulkDeleteTasks(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const ids = validate(bodySchema, await request.json());

    const container = getTasksContainer();
    await Promise.all(ids.map((id) => container.item(id, organizationId).delete()));

    return ok(undefined, 200);
}

app.http("BulkDeleteTasks", {
    methods: ["DELETE", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("BulkDeleteTasks", BulkDeleteTasks),
});
