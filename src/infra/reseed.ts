import { deleteAllTasks, writeSeedTasks, writeSeedFormSettings, SEED_ORGANIZATION } from "./cosmosTools";

/* Wipe the seed organization's tasks and write the seed task list and form
   settings. Idempotent: run it as often as you like. */

(async () => {
    const removed = await deleteAllTasks();
    console.log(`removed ${removed} existing task(s) for org ${SEED_ORGANIZATION}`);

    const written = await writeSeedTasks();
    console.log(`seeded ${written} task(s)`);

    const version = await writeSeedFormSettings();
    console.log(`seeded form settings (version ${version})`);
})().catch((err) => {
    console.error("reseed failed:", err.message);
    process.exit(1);
});
