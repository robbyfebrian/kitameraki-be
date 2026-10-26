import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok, requireIdAndOrganizationId } from "../shared/http";
import { validate } from "../shared/validate";
import { assertCustomAnswers } from "../shared/answerGuard";
import { taskPatchSchema, toTask } from "../shared/task";
import { item } from "../shared/tasksRepo";

async function UpdateTask(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const { id, organizationId } = requireIdAndOrganizationId(request);

    const body = validate(taskPatchSchema, await request.json());

    // Validate the answers against the published form only when the patch
    // touches them, and against the MERGED result so required/date-bounds are
    // judged on what the task will actually store, not on the partial patch.
    if (body.customFields) {
        const { resource } = await item(id, organizationId).read();
        const stored = (resource as { customFields?: Record<string, string | null> } | undefined)?.customFields ?? {};
        await assertCustomAnswers(organizationId, { ...stored, ...body.customFields });
    }
    // "add" upserts the path, so a patch can introduce fields the stored
    // document does not have yet (e.g. `position` on an older task). "replace"
    // fails when the node is absent.
    const patch = Object.entries({ ...body, updatedAt: new Date().toISOString() }).map(([key, value]) => ({
        op: "add" as const,
        path: `/${key}`,
        value,
    }));

    const updated = await item(id, organizationId).patch(patch);
    return ok(toTask(updated.resource ?? {}));
}

app.http("UpdateTask", {
    methods: ["POST", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("UpdateTask", UpdateTask),
});
