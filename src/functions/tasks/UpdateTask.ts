import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok } from "../../platform/http";
import { requireIdAndOrganizationId } from "../../platform/ids";
import { validate } from "../../platform/validate";
import { updateTask } from "../../domain/task/service";
import { taskPatchSchema } from "../../domain/task/schema";

async function UpdateTask(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const { id, organizationId } = requireIdAndOrganizationId(request);

    const body = validate(taskPatchSchema, await request.json());

    return ok(await updateTask(id, organizationId, body));
}

app.http("UpdateTask", {
    methods: ["POST", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("UpdateTask", UpdateTask),
});
