import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getFormSettingsContainer } from "../shared/cosmos";
import { handler, ok, fail, requireOrganizationId } from "../shared/http";
import { validate } from "../shared/validate";
import { FORM_SETTINGS_ID, formSettingsSchema, FormSettings } from "../shared/formSettings";

async function SaveFormSettings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const body = validate(formSettingsSchema, await request.json()) as FormSettings;
    const container = getFormSettingsContainer();

    const { resource: existing } = await container.item(FORM_SETTINGS_ID, organizationId).read();
    const existingVersion = (existing as FormSettings | undefined)?.version;

    if (existing && body.version !== existingVersion) {
        return fail(409, `Version conflict: expected ${existingVersion}, got ${body.version}`);
    }

    const saved: FormSettings = {
        ...body,
        id: FORM_SETTINGS_ID,
        organizationId,
        version: existing ? existingVersion! + 1 : body.version ?? 0,
        updatedAt: new Date().toISOString(),
    };

    await container.items.upsert(saved);

    return ok(saved);
}

app.http("SaveFormSettings", {
    methods: ["PUT", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("SaveFormSettings", SaveFormSettings),
});
