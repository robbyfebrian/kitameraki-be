import { deleteAllTasks } from "./cosmosTools";
import { SEED_ORGANIZATION_ID } from "../seed";

/* Wipe every task in the seed organization, leaving form settings untouched. */

(async () => {
    const removed = await deleteAllTasks();
    console.log(`removed ${removed} task(s) for org ${SEED_ORGANIZATION_ID}`);
})().catch((err) => {
    console.error("clear failed:", err.message);
    process.exit(1);
});
