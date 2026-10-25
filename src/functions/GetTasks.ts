import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getTasksContainer } from "../shared/cosmos";
import { handler, ok, requireOrganizationId } from "../shared/http";
import { toTask } from "../shared/task";

async function GetTasks(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const { resources } = await getTasksContainer()
        .items.query(
            {
                query: "SELECT * FROM c WHERE c.organizationId = @org",
                parameters: [{ name: "@org", value: organizationId }],
            },
            { partitionKey: organizationId }
        )
        .fetchAll();

    return ok(resources.map((resource) => toTask(resource)));
}

app.http("GetTasks", {
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("GetTasks", GetTasks),
});
