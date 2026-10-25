import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok, fail, requireIdAndOrganizationId } from "../shared/http";
import { toTask } from "../shared/task";
import { item } from "../shared/tasksRepo";

async function GetTask(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const { id, organizationId } = requireIdAndOrganizationId(request);

    const { resource } = await item(id, organizationId).read();
    if (!resource) {
        return fail(404, "Task not found");
    }

    return ok(toTask(resource));
}

app.http("GetTask", {
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("GetTask", GetTask),
});
