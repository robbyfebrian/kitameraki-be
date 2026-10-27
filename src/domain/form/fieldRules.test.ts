import { describe, expect, it } from "vitest";
import { validateCustomAnswers } from "./fieldRules";
import { FormField, FormSettings } from "./schema";
import { SEED_ORGANIZATION_ID } from "../../seed";

const ORG = SEED_ORGANIZATION_ID;
const TODAY = "2026-10-26";

function field(overrides: Partial<FormField> & Pick<FormField, "key">): FormField {
    return {
        id: `f-${overrides.key}`,
        label: overrides.key,
        type: "text",
        required: false,
        width: 1,
        active: true,
        ...overrides,
    };
}

function settings(customFields: FormField[]): FormSettings {
    return {
        id: "task-form",
        organizationId: ORG,
        version: 1,
        title: "Task",
        description: "",
        coreFields: [],
        customFields,
        rows: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
    };
}

describe("validateCustomAnswers", () => {
    it("requires an active, non-disabled field to have a value", () => {
        const s = settings([field({ key: "email", type: "email", required: true })]);
        expect(validateCustomAnswers(s, {})).toEqual({ email: "email is required." });
        expect(validateCustomAnswers(s, { email: "a@b.io" })).toEqual({});
    });

    it("ignores hidden and disabled fields", () => {
        const s = settings([
            field({ key: "hidden", required: true, active: false }),
            field({ key: "off", required: true, disabled: true }),
        ]);
        expect(validateCustomAnswers(s, {})).toEqual({});
    });

    it("rejects a malformed email", () => {
        const s = settings([field({ key: "email", type: "email" })]);
        expect(validateCustomAnswers(s, { email: "nope" })).toEqual({ email: "Enter a valid email address." });
        expect(validateCustomAnswers(s, { email: "a@b.c" })).toEqual({ email: "Enter a valid email address." });
    });

    it("enforces length bounds and the 200 fallback", () => {
        const s = settings([field({ key: "note", minLength: 3, maxLength: 5 })]);
        expect(validateCustomAnswers(s, { note: "ab" }).note).toBeTruthy();
        expect(validateCustomAnswers(s, { note: "abcdef" }).note).toBeTruthy();
        expect(validateCustomAnswers(s, { note: "abcd" })).toEqual({});

        const fallback = settings([field({ key: "note" })]);
        expect(validateCustomAnswers(fallback, { note: "x".repeat(201) }).note).toBeTruthy();
    });

    it("enforces date bounds with the disablePast shortcut", () => {
        const s = settings([field({ key: "due", type: "date", minDate: "2026-10-10", maxDate: "2026-10-20" })]);
        expect(validateCustomAnswers(s, { due: "2026-10-09" }, TODAY).due).toBeTruthy();
        expect(validateCustomAnswers(s, { due: "2026-10-15" }, TODAY)).toEqual({});

        const past = settings([field({ key: "due", type: "date", disablePast: true })]);
        expect(validateCustomAnswers(past, { due: "2026-10-25" }, TODAY).due).toBeTruthy();
        expect(validateCustomAnswers(past, { due: TODAY }, TODAY)).toEqual({});
    });

    it("uses the field's own validation message when set", () => {
        const s = settings([field({ key: "email", type: "email", validationMessage: "Use your work email." })]);
        expect(validateCustomAnswers(s, { email: "nope" })).toEqual({ email: "Use your work email." });
    });
});
