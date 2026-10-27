import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok, fail } from "../../platform/http";
import { requireIdAndOrganizationId } from "../../platform/ids";
import { getTask } from "../../domain/task/service";

async function GetTask(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const { id, organizationId } = requireIdAndOrganizationId(request);

    const task = await getTask(id, organizationId);
    if (!task) {
        return fail(404, "Task not found");
    }

    return ok(task);
}

app.http("GetTask", {
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("GetTask", GetTask),
});
