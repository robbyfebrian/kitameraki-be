import { seedTasks, seedFormSettings, SEED_ORGANIZATION_ID } from "../seed";
import { taskSchema } from "../domain/task/schema";
import { formSettingsSchema } from "../domain/form/schema";
import { getFormSettingsContainer, getTasksContainer } from "../platform/cosmos";

/* Operational scripts share the backend's connection setup (platform/cosmos.ts,
   which also applies the COSMOS_EMULATOR TLS opt-in) and its own schemas, so a
   schema change fails the script instead of writing drift. */

export async function deleteAllTasks(container = getTasksContainer()): Promise<number> {
    const { resources } = await container.items
        .query(
            { query: "SELECT c.id FROM c WHERE c.organizationId = @org", parameters: [{ name: "@org", value: SEED_ORGANIZATION_ID }] },
            { partitionKey: SEED_ORGANIZATION_ID }
        )
        .fetchAll();
    await Promise.all(resources.map((item) => container.item(item.id, SEED_ORGANIZATION_ID).delete()));
    return resources.length;
}

export async function writeSeedTasks(container = getTasksContainer()): Promise<number> {
    // Validate before writing: the seed must always satisfy the live schema.
    const tasks = seedTasks().map((task) => taskSchema.parse(task));
    // Batch the upserts so a large seed does not open every write at once.
    const batchSize = 100;
    for (let i = 0; i < tasks.length; i += batchSize) {
        await Promise.all(tasks.slice(i, i + batchSize).map((task) => container.items.upsert(task)));
    }
    return tasks.length;
}

export async function writeSeedFormSettings(container = getFormSettingsContainer()): Promise<number> {
    const settings = formSettingsSchema.parse(seedFormSettings());
    await container.items.upsert(settings);
    return settings.version;
}
