import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok } from "../../platform/http";
import { requireIdAndOrganizationId } from "../../platform/ids";
import { removeTask } from "../../domain/task/service";

async function DeleteTask(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const { id, organizationId } = requireIdAndOrganizationId(request);

    await removeTask(id, organizationId);

    return ok(undefined, 200);
}

app.http("DeleteTask", {
    methods: ["DELETE", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("DeleteTask", DeleteTask),
});
