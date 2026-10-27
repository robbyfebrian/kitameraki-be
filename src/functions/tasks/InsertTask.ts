import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok } from "../../platform/http";
import { requireOrganizationId } from "../../platform/ids";
import { validate } from "../../platform/validate";
import { createTask } from "../../domain/task/service";
import { taskInputSchema } from "../../domain/task/schema";

async function InsertTask(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);
    const body = validate(taskInputSchema, await request.json());

    return ok(await createTask(organizationId, body));
}

app.http("InsertTask", {
    methods: ["POST", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("InsertTask", InsertTask),
});
