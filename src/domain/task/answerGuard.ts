import { getFormSettingsContainer } from "../../platform/cosmos";
import { validateCustomAnswers } from "../form/fieldRules";
import { FORM_SETTINGS_ID, FormSettings } from "../form/schema";
import { ValidationError } from "../../platform/http";
import { stripMetadata } from "./schema";

/* The I/O half of answer validation: load the organization's published form and
   reject answers the form forbids. Kept apart from the pure rules in
   `fieldValidation.ts` so the rules stay testable without a Cosmos connection. */

export async function assertCustomAnswers(
    organizationId: string,
    answers: Record<string, string | null> | undefined
): Promise<void> {
    if (!answers) return;
    const { resource } = await getFormSettingsContainer().item(FORM_SETTINGS_ID, organizationId).read();
    if (!resource) return;

    const settings = stripMetadata(resource) as unknown as FormSettings;
    // An unreadable definition must not block writes; it only removes the
    // server-side guarantee for this request.
    if (!Array.isArray(settings.customFields)) return;

    const errors = validateCustomAnswers(settings, answers);
    const messages = Object.entries(errors).map(([key, message]) => `${key}: ${message}`);
    if (messages.length > 0) {
        // ValidationError maps to a 400 in the handler wrapper.
        throw new ValidationError(messages.join("; "));
    }
}
