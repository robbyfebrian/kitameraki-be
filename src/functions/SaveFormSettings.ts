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

    // Quasi-atomic second guard: the replace only lands when the document has
    // not been touched since our version-check read (matches the `_etag` from
    // that read). Cosmos rejects it with 412, mapped to a client-facing 409.
    try {
        if (existing) {
            const etag = (existing as Record<string, unknown>)._etag as string;
            await container
                .item(FORM_SETTINGS_ID, organizationId)
                .replace(saved, { accessCondition: { type: "IfMatch", condition: etag } });
        } else {
            await container.items.upsert(saved);
        }
    } catch (err) {
        if ((err as { code?: number }).code === 412) {
            return fail(409, "Version conflict: the form settings changed concurrently, reload and retry");
        }
        throw err;
    }

    return ok({ ...saved, migrations });
}

app.http("SaveFormSettings", {
    methods: ["PUT", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("SaveFormSettings", SaveFormSettings),
});
