import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok } from "../../platform/http";
import { requireOrganizationId } from "../../platform/ids";
import { getFormSettings } from "../../domain/form/service";

async function GetFormSettings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const settings = await getFormSettings(organizationId);
    // No stored form yet is a normal state (a fresh organization). Respond 204
    // so the client seeds its own default without a failed request or an
    // ambiguous empty body.
    if (!settings) {
        return ok(undefined, 204);
    }

    return ok(settings);
}

app.http("GetFormSettings", {
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("GetFormSettings", GetFormSettings),
});
