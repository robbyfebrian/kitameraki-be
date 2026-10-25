import { CosmosClient, Container } from "@azure/cosmos";
import { seedTasks, seedFormSettings, SEED_ORGANIZATION_ID } from "../seed";
import { taskSchema } from "../shared/task";
import { formSettingsSchema, FORM_SETTINGS_ID } from "../shared/formSettings";

/* Operational scripts share this connection setup. They import the backend's
   own schemas so a schema change fails the script instead of writing drift. */

export function tasksContainer(): Container {
    const connectionString = process.env.COSMOS_CONNECTION_STRING;
    if (!connectionString) {
        throw new Error("Missing required environment variable COSMOS_CONNECTION_STRING");
    }
    const client = new CosmosClient(connectionString);
    const databaseId = process.env.COSMOS_DATABASE ?? "TaskApp";
    const containerId = process.env.COSMOS_TASKS_CONTAINER ?? "Tasks";
    return client.database(databaseId).container(containerId);
}

export function formSettingsContainer(): Container {
    const connectionString = process.env.COSMOS_CONNECTION_STRING;
    if (!connectionString) {
        throw new Error("Missing required environment variable COSMOS_CONNECTION_STRING");
    }
    const client = new CosmosClient(connectionString);
    const databaseId = process.env.COSMOS_DATABASE ?? "TaskApp";
    const containerId = process.env.COSMOS_FORM_SETTINGS_CONTAINER ?? "FormSettings";
    return client.database(databaseId).container(containerId);
}

export async function deleteAllTasks(container = tasksContainer()): Promise<number> {
    const { resources } = await container.items
        .query(
            { query: "SELECT c.id FROM c WHERE c.organizationId = @org", parameters: [{ name: "@org", value: SEED_ORGANIZATION_ID }] },
            { partitionKey: SEED_ORGANIZATION_ID }
        )
        .fetchAll();
    await Promise.all(resources.map((item) => container.item(item.id, SEED_ORGANIZATION_ID).delete()));
    return resources.length;
}

export async function writeSeedTasks(container = tasksContainer()): Promise<number> {
    // Validate before writing: the seed must always satisfy the live schema.
    const tasks = seedTasks().map((task) => taskSchema.parse(task));
    await Promise.all(tasks.map((task) => container.items.upsert(task)));
    return tasks.length;
}

export async function writeSeedFormSettings(container = formSettingsContainer()): Promise<number> {
    const settings = formSettingsSchema.parse(seedFormSettings());
    await container.items.upsert(settings);
    return settings.version;
}

export const SEED_ORGANIZATION = SEED_ORGANIZATION_ID;
export const SEED_FORM_ID = FORM_SETTINGS_ID;
