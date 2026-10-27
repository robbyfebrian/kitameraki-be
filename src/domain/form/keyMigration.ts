import { FormSettings } from "./schema";
import { Task } from "../task/schema";

/* Renaming a custom field's key is an edit to the form definition, but stored
   answers live inside `task.customFields`, keyed by the OLD key. Without this
   migration every existing answer would become unreachable (orphaned) as soon
   as the new definition is published.

   The diff is derived server-side from the previous definition, so the client
   only sends the new settings; it cannot ask for an arbitrary rewrite. */

export interface KeyRename {
    fieldId: string;
    from: string;
    to: string;
}

export interface KeyMigrationReport {
    fieldId: string;
    key: string;
    renamedFrom: string;
    migratedTasks: number;
}

/* Compare the persisted definition with the incoming one and return the key
   changes, matched by stable `field.id` (labels are free to change and keys are
   exactly what we are tracking). A field absent from either side is skipped: a
   newly added field has no history, and a hidden/deleted field keeps its stored
   answers so re-adding the same key revives them. */
export function diffCustomFieldKeys(previous: FormSettings | undefined, next: FormSettings): KeyRename[] {
    if (!previous) return [];
    const before = new Map(previous.customFields.map((field) => [field.id, field.key]));
    const renames: KeyRename[] = [];
    for (const field of next.customFields) {
        const from = before.get(field.id);
        if (from === undefined || from === field.key) continue;
        renames.push({ fieldId: field.id, from, to: field.key });
    }
    return renames;
}

/* Copy a value from `from` to `to` on one task. Returns null when the task has
   no value under the old key, so untouched tasks are never rewritten. */
export function renameKeyOnTask(task: Task, rename: Pick<KeyRename, "from" | "to">): Task | null {
    const current = task.customFields ?? {};
    if (!Object.prototype.hasOwnProperty.call(current, rename.from)) return null;

    const next: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(current)) {
        // A stale value already sitting on the target key would be overwritten;
        // the new value wins because it belongs to the field being renamed.
        if (key === rename.from || key === rename.to) continue;
        next[key] = value;
    }
    next[rename.to] = current[rename.from];
    return { ...task, customFields: next };
}
