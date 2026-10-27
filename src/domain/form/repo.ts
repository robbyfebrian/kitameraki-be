import { getFormSettingsContainer, getFormSettingsHistoryContainer } from "../../platform/cosmos";
import { ConflictError } from "../../platform/http";
import {
    FORM_SETTINGS_ID,
    FormSettings,
    FormSettingsHistory,
    FormSettingsStaging,
    STAGING_FORM_ID,
    formSettingsHistorySchema,
    isStaleStaging,
} from "./schema";

/* I/O for form definitions. The published definition (`task-form`), the publish
   journal (`task-form-staging`) and the per-version snapshots live in separate
   containers; only the first is in the hot path of every task write. */

export async function readFormSettings(
    organizationId: string
): Promise<{ settings?: FormSettings; etag?: string }> {
    const { resource, etag } = await getFormSettingsContainer()
        .item(FORM_SETTINGS_ID, organizationId)
        .read<FormSettings>();
    if (!resource) return {};
    return { settings: resource, etag: (resource as { _etag?: string })._etag ?? etag };
}

export async function readStaging(organizationId: string): Promise<FormSettingsStaging | undefined> {
    const { resource } = await getFormSettingsContainer()
        .item(STAGING_FORM_ID, organizationId)
        .read<FormSettingsStaging>();
    return resource ?? undefined;
}

export async function writeStaging(staging: FormSettingsStaging): Promise<void> {
    await getFormSettingsContainer().items.upsert(staging);
}

export async function clearStaging(organizationId: string): Promise<void> {
    try {
        await getFormSettingsContainer().item(STAGING_FORM_ID, organizationId).delete();
    } catch (err) {
        // Already gone is the desired state.
        if ((err as { code?: number }).code !== 404) throw err;
    }
}

export async function assertNoLivePublish(organizationId: string): Promise<FormSettingsStaging | undefined> {
    const staging = await readStaging(organizationId);
    if (!staging) return undefined;
    if (isStaleStaging(staging)) {
        await clearStaging(organizationId);
        return undefined;
    }
    throw new ConflictError("Publish in progress: another save is still migrating answers, retry shortly");
}

export async function readHistory(organizationId: string, version: number): Promise<FormSettingsHistory | undefined> {
    const { resource } = await getFormSettingsHistoryContainer()
        .item(String(version), organizationId)
        .read<FormSettingsHistory>();
    return resource ? formSettingsHistorySchema.parse(resource) : undefined;
}

export async function listHistory(organizationId: string, limit: number): Promise<FormSettingsHistory[]> {
    const { resources } = await getFormSettingsHistoryContainer()
        .items.query(
            {
                query: "SELECT * FROM c WHERE c.organizationId = @org ORDER BY c.version DESC OFFSET 0 LIMIT @limit",
                parameters: [
                    { name: "@org", value: organizationId },
                    { name: "@limit", value: limit },
                ],
            },
            { partitionKey: organizationId }
        )
        .fetchAll();
    return resources.map((resource) => formSettingsHistorySchema.parse(resource));
}
