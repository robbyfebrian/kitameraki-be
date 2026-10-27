import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok } from "../../platform/http";
import { requireOrganizationId } from "../../platform/ids";
import { validate } from "../../platform/validate";
import { taskQuerySchema } from "../../domain/task/query";
import { listAllTasks, listTaskPage } from "../../domain/task/service";

/* With `page` present the response is { items, total, page, pageSize } — the FE
   TaskPage contract. Without it, the legacy full-partition Task[] array. */
async function GetTasks(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const raw: Record<string, string> = {};
    for (const [key, value] of request.query.entries()) {
        if (key !== "organizationId" && value !== "") raw[key] = value;
    }
    const parsed = validate(taskQuerySchema, raw);

    if (parsed.page === undefined) {
        return ok(await listAllTasks(organizationId));
    }

    return ok(await listTaskPage(organizationId, parsed));
}

app.http("GetTasks", {
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("GetTasks", GetTasks),
});
