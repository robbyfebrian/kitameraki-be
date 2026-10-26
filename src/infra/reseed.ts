import { deleteAllTasks, writeSeedTasks, writeSeedFormSettings } from "./cosmosTools";
import { SEED_ORGANIZATION_ID } from "../seed";

/* Wipe the seed organization's tasks and write the seed task list and form
   settings. Idempotent: run it as often as you like. */

(async () => {
    const removed = await deleteAllTasks();
    console.log(`removed ${removed} existing task(s) for org ${SEED_ORGANIZATION_ID}`);

    const written = await writeSeedTasks();
    console.log(`seeded ${written} task(s)`);

    const version = await writeSeedFormSettings();
    console.log(`seeded form settings (version ${version})`);
})().catch((err) => {
    console.error("reseed failed:", err.message);
    process.exit(1);
});
