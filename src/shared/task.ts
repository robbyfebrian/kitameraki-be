import { z } from "zod";

export const taskInputSchema = z.object({
    title: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    status: z.enum(["todo", "in-progress", "completed"]).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    dueDate: z.string().optional(),
    tags: z.array(z.string().max(50)).optional(),
    customFields: z.record(z.string(), z.string().nullable()).optional(),
    position: z.number().optional(),
});

export const taskPatchSchema = taskInputSchema.partial();

export const taskSchema = taskInputSchema.extend({
    id: z.string(),
    organizationId: z.string(),
    status: z.enum(["todo", "in-progress", "completed"]),
    customFields: z.record(z.string(), z.string().nullable()).default({}),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
});

export type TaskInput = z.infer<typeof taskInputSchema>;
export type TaskPatch = z.infer<typeof taskPatchSchema>;
export type Task = z.infer<typeof taskSchema>;

/* Cosmos returns system metadata (`_rid`, `_etag`, …) alongside the document.
   Strip it so responses expose only the task contract the client knows. */
export function toTask(resource: object): Task {
    return taskSchema.parse(stripMetadata(resource));
}

export function stripMetadata(resource: object): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(resource)) {
        if (!key.startsWith("_")) clean[key] = value;
    }
    return clean;
}
