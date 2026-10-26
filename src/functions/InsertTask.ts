import { randomUUID } from "crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getTasksContainer } from "../shared/cosmos";
import { handler, ok, requireOrganizationId } from "../shared/http";
import { validate } from "../shared/validate";
import { assertCustomAnswers } from "../shared/answerGuard";
import { taskInputSchema, toTask } from "../shared/task";
async function InsertTask(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);
    const body = validate(taskInputSchema, await request.json());
    // Enforce the published form's field rules server-side, so an answer that
    // never went through the browser cannot be stored.
    await assertCustomAnswers(organizationId, body.customFields);
    const now = new Date().toISOString();

    const created = await getTasksContainer().items.create({
        id: randomUUID(),
        organizationId,
        status: "todo",
        customFields: {},
        ...body,
        createdAt: now,
        updatedAt: now,
    });

    return ok(toTask(created.resource ?? {}));
}

app.http("InsertTask", {
    methods: ["POST", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("InsertTask", InsertTask),
});
