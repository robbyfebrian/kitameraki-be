import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getFormSettingsContainer } from "../shared/cosmos";
import { handler, ok, requireOrganizationId } from "../shared/http";
import { FORM_SETTINGS_ID, formSettingsSchema } from "../shared/formSettings";
import { stripMetadata } from "../shared/task";

async function GetFormSettings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const { resource } = await getFormSettingsContainer().item(FORM_SETTINGS_ID, organizationId).read();
    // No stored form yet is a normal state (a fresh organization). Respond 204
    // so the client seeds its own default without a failed request or an
    // ambiguous empty body.
    if (!resource) {
        return ok(undefined, 204);
    }

    return ok(formSettingsSchema.parse(stripMetadata(resource)));
}

app.http("GetFormSettings", {
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("GetFormSettings", GetFormSettings),
});
