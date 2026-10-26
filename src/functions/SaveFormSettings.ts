import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getFormSettingsContainer } from "../shared/cosmos";
import { handler, ok, fail, requireOrganizationId } from "../shared/http";
import { validate } from "../shared/validate";
import { FORM_SETTINGS_ID, formSettingsSchema, FormSettings } from "../shared/formSettings";
import { diffCustomFieldKeys } from "../shared/migrateKeys";
import { migrateRenamedKeys } from "../shared/tasksMigrate";

async function SaveFormSettings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const body = validate(formSettingsSchema, await request.json()) as FormSettings;
    const container = getFormSettingsContainer();

    const { resource: existing } = await container.item(FORM_SETTINGS_ID, organizationId).read();
    const previous = existing as FormSettings | undefined;
    const existingVersion = previous?.version;

    if (existing && body.version !== existingVersion) {
        return fail(409, `Version conflict: expected ${existingVersion}, got ${body.version}`);
    }

    // Renaming a custom field's key would orphan the answers already stored under
    // the old key. Diff the persisted definition against the incoming one and
    // migrate every task BEFORE publishing, so the new form never points at keys
    // the data has not caught up with.
    const renames = diffCustomFieldKeys(previous, body);
    const migrations = await migrateRenamedKeys(organizationId, renames, context);

    const saved: FormSettings = {
        ...body,
        id: FORM_SETTINGS_ID,
        organizationId,
        version: existing ? existingVersion! + 1 : body.version ?? 0,
        updatedAt: new Date().toISOString(),
    };

    await container.items.upsert(saved);

    return ok({ ...saved, migrations });
}

app.http("SaveFormSettings", {
    methods: ["PUT", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("SaveFormSettings", SaveFormSettings),
});
