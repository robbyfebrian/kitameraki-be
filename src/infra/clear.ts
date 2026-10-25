import { deleteAllTasks, SEED_ORGANIZATION } from "./cosmosTools";

/* Wipe every task in the seed organization, leaving form settings untouched. */

(async () => {
    const removed = await deleteAllTasks();
    console.log(`removed ${removed} task(s) for org ${SEED_ORGANIZATION}`);
})().catch((err) => {
    console.error("clear failed:", err.message);
    process.exit(1);
});
