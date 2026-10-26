import { FormField, FormSettings } from "./formSettings";

/* Server-side mirror of the FE answer rules in kitameraki-fe/src/lib/form/
   validate.ts. The browser validates to help the user; this validates so a
   payload that never touched the form (curl, the JSON dock export, another
   client) cannot store an answer the published form forbids. Only the rules
   that are knowable from the field definition are enforced here: the same
   required/type/length/date-bounds set the form applies.

   Pure and Cosmos-free on purpose: the I/O half that loads the definition and
   throws lives in `answerGuard.ts`, so this stays unit-testable without a
   connection. */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* The FE folds disablePast/disableFuture into explicit min/max at validation
   time; do the same here so both sides agree on the effective window. */
function effectiveDateBounds(field: FormField, today: string): { min?: string; max?: string } {
    let min = field.minDate || undefined;
    let max = field.maxDate || undefined;
    if (field.disablePast && (!min || today > min)) min = today;
    if (field.disableFuture && (!max || today < max)) max = today;
    return { min, max };
}

function isActive(field: FormField): boolean {
    return field.active;
}

/* Returns one message per offending field key; empty means the answers satisfy
   the active custom fields. `answers` is the task's customFields record. */
export function validateCustomAnswers(
    settings: FormSettings,
    answers: Record<string, string | null>,
    today: string = new Date().toISOString().slice(0, 10)
): Record<string, string> {
    const errors: Record<string, string> = {};

    for (const field of settings.customFields.filter(isActive)) {
        // A disabled field is not editable in the form and is excluded there too.
        if (field.disabled) continue;

        const value = (answers[field.key] ?? "").trim();

        if (field.required && !value) {
            errors[field.key] = `${field.label} is required.`;
            continue;
        }
        if (!value) continue;

        if (field.type === "text" || field.type === "textarea") {
            if (typeof field.minLength === "number" && value.length < field.minLength) {
                errors[field.key] = field.validationMessage || `Use at least ${field.minLength} characters.`;
            } else if (typeof field.maxLength === "number" && value.length > field.maxLength) {
                errors[field.key] = field.validationMessage || `Value must be ${field.maxLength} characters or fewer.`;
            }
        }

        if (field.type === "email" && !EMAIL_RE.test(value)) {
            errors[field.key] = field.validationMessage || "Enter a valid email address.";
        }

        if (field.type === "date" || field.type === "datetime") {
            const parsed = field.type === "date" ? new Date(`${value}T00:00:00`) : new Date(value);
            if (Number.isNaN(parsed.getTime())) {
                errors[field.key] = field.type === "date" ? "Enter a valid date." : "Enter a valid date and time.";
            } else {
                const { min, max } = effectiveDateBounds(field, today);
                const day = value.slice(0, 10);
                if (min && day < min) errors[field.key] = field.validationMessage || `Date must be on or after ${min}.`;
                else if (max && day > max) errors[field.key] = field.validationMessage || `Date must be on or before ${max}.`;
            }
        }

        if (!errors[field.key] && value.length > 200 && field.maxLength === undefined) {
            errors[field.key] = "Value must be 200 characters or fewer.";
        }
    }

    return errors;
}
