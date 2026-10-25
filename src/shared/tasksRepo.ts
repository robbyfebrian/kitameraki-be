import { getTasksContainer } from "./cosmos";

/* I/O for single documents, kept apart from the pure task contract in `task.ts`
   so schema and mapping logic can be tested without a Cosmos connection. */

export function item(id: string, organizationId: string) {
    return getTasksContainer().item(id, organizationId);
}
