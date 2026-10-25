import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok, requireIdAndOrganizationId } from "../shared/http";
import { validate } from "../shared/validate";
import { taskPatchSchema, toTask } from "../shared/task";
import { item } from "../shared/tasksRepo";

async function UpdateTask(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const { id, organizationId } = requireIdAndOrganizationId(request);

    const body = validate(taskPatchSchema, await request.json());
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
