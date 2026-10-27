import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok } from "../../platform/http";
import { requireOrganizationId } from "../../platform/ids";
import { validate } from "../../platform/validate";
import { FormSettings, formSettingsSchema } from "../../domain/form/schema";
import { publishFormSettings } from "../../domain/form/service";

/* Publishing is journaled: version check, then answer migration, then one
   atomic batch that swaps the definition, snapshots the version into history
   and clears the journal. Conflicts surface as 409 (wrong version, a publish
   still running, or losing the etag race at commit). */
async function SaveFormSettings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const body = validate(formSettingsSchema, await request.json()) as FormSettings;

    const { settings, migrations } = await publishFormSettings(organizationId, body, context);

    return ok({ ...settings, migrations });
}

app.http("SaveFormSettings", {
    methods: ["PUT", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("SaveFormSettings", SaveFormSettings),
});
