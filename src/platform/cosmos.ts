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
const formSettingsHistoryContainerId =
    process.env.COSMOS_FORM_SETTINGS_HISTORY_CONTAINER ?? "FormSettingsHistory";

export function getTasksContainer(): Container {
    return client.database(databaseId).container(tasksContainerId);
}

export function getFormSettingsContainer(): Container {
    return client.database(databaseId).container(formSettingsContainerId);
}

/* Published form versions, one document per version. A separate container keeps
   the single hot document read by every task write (`FormSettings`) small and
   its partition free of history documents. */
export function getFormSettingsHistoryContainer(): Container {
    return client.database(databaseId).container(formSettingsHistoryContainerId);
}
