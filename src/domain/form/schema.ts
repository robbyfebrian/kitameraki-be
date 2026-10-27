import { z } from "zod";

/* One form definition per organization; the Cosmos item id is fixed and the
   organization is the partition key, so the document id stays stable. */
export const FORM_SETTINGS_ID = "task-form";

/* Publish journal. Cosmos has no cross-container transaction, so the task
   migration cannot commit together with the published definition. A staging
   document holds the intended definition and the migration progress, letting a
   failed publish be resumed instead of leaving half-renamed answers behind. */
export const STAGING_FORM_ID = "task-form-staging";

/* A staging document older than this is assumed abandoned (worker crash,
   timeout) and may be replaced instead of blocking publishes forever. */
export const STAGING_STALE_MS = 10 * 60 * 1000;

const coreFieldKey = z.enum(["title", "description", "status", "priority", "dueDate", "tags"]);

const coreFieldSchema = z.object({
    key: coreFieldKey,
    label: z.string(),
    visible: z.boolean(),
    width: z.union([z.literal(1), z.literal(2)]),
    /* Shared z-order with custom fields: core and custom are one reorderable
       list, so both carry a position. Optional for backward compatibility. */
    order: z.number().int().optional(),
});

const formFieldSchema = z.object({
    id: z.string(),
    key: z.string(),
    label: z.string(),
    type: z.enum(["text", "textarea", "select", "tags", "date", "datetime", "email"]),
    required: z.boolean(),
    placeholder: z.string().optional(),
    description: z.string().optional(),
    width: z.union([z.literal(1), z.literal(2)]),
    active: z.boolean(),
    order: z.number().int().optional(),
    validationMessage: z.string().optional(),
    disabled: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    defaultValue: z.string().optional(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    minDate: z.string().optional(),
    maxDate: z.string().optional(),
    disablePast: z.boolean().optional(),
    disableFuture: z.boolean().optional(),
    /* Datetime-only: display format of the time part (native input stays
       locale-driven, so this is presentation metadata). */
    timeFormat: z.enum(["12h", "24h"]).optional(),
    options: z.array(z.string()).optional(),
});

export const formSettingsSchema = z.object({
    id: z.literal(FORM_SETTINGS_ID),
    organizationId: z.string(),
    version: z.number().int().nonnegative(),
    title: z.string(),
    description: z.string(),
    coreFields: z.array(coreFieldSchema),
    customFields: z.array(formFieldSchema),
    rows: z.array(z.object({ id: z.string(), fieldIds: z.array(z.string()) })),
    updatedAt: z.string(),
});

/* The stored definition without the per-document identity fields, used by the
   history snapshot and by the staging journal so both stay free of `id`/
   `organizationId` duplication. */
export const formDefinitionSchema = formSettingsSchema.omit({
    id: true,
    organizationId: true,
    updatedAt: true,
});

const keyRenameSchema = z.object({
    fieldId: z.string(),
    from: z.string(),
    to: z.string(),
});

const migrationReportSchema = z.object({
    fieldId: z.string(),
    key: z.string(),
    renamedFrom: z.string(),
    migratedTasks: z.number().int().nonnegative(),
});

/* Where a rename left off. Persisted after every committed batch so a resumed
   publish skips work already done (migration is idempotent) instead of
   restarting from the first rename. */
const migrationCursorSchema = z.object({
    renameIndex: z.number().int().nonnegative(),
    migratedTasks: z.number().int().nonnegative(),
});

export const formSettingsStagingSchema = z.object({
    id: z.literal(STAGING_FORM_ID),
    organizationId: z.string(),
    /* -1 means "no published form when the publish started". */
    baseVersion: z.number().int().min(-1),
    targetVersion: z.number().int().nonnegative(),
    /* `_etag` of the settings document the publish read; the final replace only
       lands if it still matches. Absent for a first publish. */
    baseEtag: z.string().optional(),
    /* The full document that will be published; `version`/`updatedAt` are
       frozen at publish time so a resumed finalise writes exactly the version
       the caller read. */
    definition: formSettingsSchema,
    renames: z.array(keyRenameSchema),
    cursor: migrationCursorSchema,
    state: z.enum(["pending", "applied"]),
    startedAt: z.string(),
});

export const formSettingsHistorySchema = z.object({
    /* One document per published version; the version doubles as the item id. */
    id: z.string(),
    organizationId: z.string(),
    version: z.number().int().nonnegative(),
    definition: formDefinitionSchema,
    migrations: z.array(migrationReportSchema),
    publishedAt: z.string(),
    /* Reserved for when organizationId comes from a token instead of the query
       string; always null until then. */
    publishedBy: z.string().nullable(),
});

/* A journal entry can outlive the worker that wrote it (crash, timeout). An old
   one must not block publishing forever, so it is discarded instead of being
   reported as "publish in progress". */
export function isStaleStaging(staging: { startedAt: string }, now = Date.now()): boolean {
    const started = Date.parse(staging.startedAt);
    if (Number.isNaN(started)) return true;
    return now - started > STAGING_STALE_MS;
}

type CoreField = z.infer<typeof coreFieldSchema>;
export type FormField = z.infer<typeof formFieldSchema>;
export type FormSettings = z.infer<typeof formSettingsSchema>;
export type FormDefinition = z.infer<typeof formDefinitionSchema>;
export type FormSettingsStaging = z.infer<typeof formSettingsStagingSchema>;
export type FormSettingsHistory = z.infer<typeof formSettingsHistorySchema>;
export type KeyRenameInput = z.infer<typeof keyRenameSchema>;
export type StoredMigrationReport = z.infer<typeof migrationReportSchema>;
