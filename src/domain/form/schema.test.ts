import { describe, expect, it } from "vitest";
import {
    FORM_SETTINGS_ID,
    STAGING_FORM_ID,
    STAGING_STALE_MS,
    formSettingsHistorySchema,
    formSettingsSchema,
    formSettingsStagingSchema,
    isStaleStaging,
} from "./schema";
import { SEED_ORGANIZATION_ID } from "../../seed";

const ORG = SEED_ORGANIZATION_ID;

const definition = {
    id: FORM_SETTINGS_ID,
    organizationId: ORG,
    version: 4,
    title: "Task Form",
    description: "",
    coreFields: [{ key: "title" as const, label: "Title", visible: true, width: 1 as const }],
    customFields: [
        {
            id: "c1",
            key: "client_email",
            label: "Client email",
            type: "email" as const,
            required: false,
            width: 1 as const,
            active: true,
        },
    ],
    rows: [{ id: "row-1", fieldIds: ["c1"] }],
    updatedAt: "2026-10-27T02:10:00.000Z",
};

const staging = {
    id: STAGING_FORM_ID,
    organizationId: ORG,
    baseVersion: 3,
    targetVersion: 4,
    baseEtag: '"etag-1"',
    definition,
    renames: [{ fieldId: "c1", from: "client_email", to: "client_mail" }],
    cursor: { renameIndex: 0, migratedTasks: 0 },
    state: "pending" as const,
    startedAt: "2026-10-27T02:10:00.000Z",
};

const history = {
    id: "4",
    organizationId: ORG,
    version: 4,
    definition: {
        version: 4,
        title: definition.title,
        description: definition.description,
        coreFields: definition.coreFields,
        customFields: definition.customFields,
        rows: definition.rows,
    },
    migrations: [{ fieldId: "c1", key: "client_mail", renamedFrom: "client_email", migratedTasks: 12 }],
    publishedAt: "2026-10-27T02:10:00.000Z",
    publishedBy: null,
};

describe("formSettingsStagingSchema", () => {
    it("accepts a complete journal entry", () => {
        expect(formSettingsStagingSchema.parse(staging).targetVersion).toBe(4);
    });

    it("allows baseVersion -1 for a first publish and an absent etag", () => {
        const first = { ...staging, baseVersion: -1, baseEtag: undefined };
        expect(formSettingsStagingSchema.parse(first).baseVersion).toBe(-1);
        expect(formSettingsStagingSchema.parse(first).baseEtag).toBeUndefined();
    });

    it("rejects an unknown state", () => {
        expect(formSettingsStagingSchema.safeParse({ ...staging, state: "done" }).success).toBe(false);
    });
});

describe("formSettingsHistorySchema", () => {
    it("accepts a snapshot with migrations", () => {
        expect(formSettingsHistorySchema.parse(history).migrations[0].migratedTasks).toBe(12);
    });

    it("allows publishedBy to stay null while there is no auth", () => {
        expect(formSettingsHistorySchema.parse({ ...history, publishedBy: null }).publishedBy).toBeNull();
    });

    it("rejects a snapshot missing its migrations array", () => {
        const { migrations, ...withoutMigrations } = history;
        expect(formSettingsHistorySchema.safeParse(withoutMigrations).success).toBe(false);
    });
});

describe("isStaleStaging", () => {
    it("treats a fresh journal as live", () => {
        const startedAt = new Date("2026-10-27T02:00:00.000Z").toISOString();
        expect(isStaleStaging({ startedAt }, Date.parse(startedAt) + 1000)).toBe(false);
    });

    it("treats a journal past the threshold as abandoned", () => {
        const startedAt = new Date("2026-10-27T02:00:00.000Z").toISOString();
        expect(isStaleStaging({ startedAt }, Date.parse(startedAt) + STAGING_STALE_MS + 1)).toBe(true);
    });

    it("treats an unparseable timestamp as abandoned so it cannot block publishing", () => {
        expect(isStaleStaging({ startedAt: "not-a-date" })).toBe(true);
    });
});

describe("formSettingsSchema", () => {
    it("still parses the published document shape", () => {
        expect(formSettingsSchema.parse(definition).version).toBe(4);
    });
});
