import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { handler, ok, ValidationError } from "../../platform/http";
import { requireOrganizationId } from "../../platform/ids";
import { getHistory } from "../../domain/form/service";

/* Published form versions, newest first. `version` narrows the response to one
   snapshot; without it the 20 most recent versions are returned. */
async function GetFormSettingsHistory(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const organizationId = requireOrganizationId(request);

    const rawVersion = request.query.get("version");
    let version: number | undefined;
    if (rawVersion !== null && rawVersion !== "") {
        version = Number(rawVersion);
        if (!Number.isInteger(version) || version < 0) {
            throw new ValidationError("version must be a non-negative integer");
        }
    }

    return ok({ items: await getHistory(organizationId, version) });
}

app.http("GetFormSettingsHistory", {
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: handler("GetFormSettingsHistory", GetFormSettingsHistory),
});
