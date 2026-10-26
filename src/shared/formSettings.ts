import { z } from "zod";

/* One form definition per organization; the Cosmos item id is fixed and the
   organization is the partition key, so the document id stays stable. */
export const FORM_SETTINGS_ID = "task-form";

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
    multiline: z.boolean().optional(),
    rows: z.number().optional(),
    autoGrow: z.boolean().optional(),
    minDate: z.string().optional(),
    maxDate: z.string().optional(),
    disablePast: z.boolean().optional(),
    disableFuture: z.boolean().optional(),
    /* Datetime-only: display format of the time part (native input stays
       locale-driven, so this is presentation metadata). */
    timeFormat: z.enum(["12h", "24h"]).optional(),
    allowedDomains: z.array(z.string()).optional(),
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

type CoreField = z.infer<typeof coreFieldSchema>;
export type FormField = z.infer<typeof formFieldSchema>;
export type FormSettings = z.infer<typeof formSettingsSchema>;
