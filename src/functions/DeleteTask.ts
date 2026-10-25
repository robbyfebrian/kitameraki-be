import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok, requireIdAndOrganizationId } from "../shared/http";
import { item } from "../shared/tasksRepo";

async function DeleteTask(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const { id, organizationId } = requireIdAndOrganizationId(request);

    await item(id, organizationId).delete();

    return ok(undefined, 200);
}

app.http("DeleteTask", {
    methods: ["DELETE", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("DeleteTask", DeleteTask),
});
