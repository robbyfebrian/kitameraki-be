import { Container, CosmosClient } from "@azure/cosmos";

const connectionString = process.env.COSMOS_CONNECTION_STRING;
if (!connectionString) {
    throw new Error("Missing required environment variable COSMOS_CONNECTION_STRING");
}

/* The local emulator is reached over a self-signed certificate. Accept it only
   when explicitly enabled (local.settings.json sets COSMOS_EMULATOR=true), so
   real Azure endpoints always keep full TLS validation. */
if (process.env.COSMOS_EMULATOR === "true") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const client = new CosmosClient(connectionString);

const databaseId = process.env.COSMOS_DATABASE ?? "TaskApp";
const tasksContainerId = process.env.COSMOS_TASKS_CONTAINER ?? "Tasks";
const formSettingsContainerId = process.env.COSMOS_FORM_SETTINGS_CONTAINER ?? "FormSettings";

export function getTasksContainer(): Container {
    return client.database(databaseId).container(tasksContainerId);
}

export function getFormSettingsContainer(): Container {
    return client.database(databaseId).container(formSettingsContainerId);
}
