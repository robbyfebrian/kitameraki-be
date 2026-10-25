import { Task } from "./shared/task";
import { FormSettings } from "./shared/formSettings";

/* Seed data for local development and review demos. Kept in the backend so the
   database is the single source of truth; the front-end no longer ships a copy
   of the task seed. Everything here is validated against the real schemas by
   `infra/seed.ts` before it is written, so a schema change breaks the seed
   loudly instead of writing drifts. */

export const SEED_ORGANIZATION_ID = "8f14e45f-ceea-4c28-9d6f-2b1c0c4c9d10";

type SeedTask = {
    title: string;
    description: string;
    status: Task["status"];
    priority: NonNullable<Task["priority"]>;
    due: string;
    tags: string[];
    email: string | null;
    department: string | null;
    requestedAt: string | null;
};

const tasks: SeedTask[] = [
    ["Migrate onboarding checklist", "Update 14 legacy steps and remove the duplicated welcome email.", "in-progress", "high", "2026-10-24", ["onboarding", "legacy", "copy"], "sara.k@acme.io", "Platform", "2026-10-23T09:30:00.000Z"],
    ["Client kickoff call notes", "Decisions from Northwind, owners assigned, follow-ups due Friday.", "todo", "medium", "2026-10-27", ["client", "northwind"], "d.reyes@northwind.co", "Success", null],
    ["Fix date parsing on Safari", "ISO strings fail in WebKit when the timezone offset is missing.", "completed", "high", "2026-10-19", ["bug", "web", "safari"], null, "Web", "2026-10-20T14:00:00.000Z"],
    ["Q4 accessibility audit", "WCAG AA sweep across task flows, dialogs, and the form builder.", "in-progress", "medium", "2026-11-02", ["a11y", "design", "audit"], "m.tan@acme.io", "Design", null],
    ["Draft release notes 2.4", "Summarise the Form Settings changes and drag-and-drop improvements.", "todo", "low", "2026-11-05", ["release", "docs"], null, "Product", null],
    ["Vendor security review", "Third-party data handling, retention windows, and subprocessors.", "todo", "high", "2026-10-31", ["security", "legal", "vendor"], "legal@acme.io", "Security", "2026-11-01T10:00:00.000Z"],
    ["Archive Q3 completed tasks", "Retention policy cleanup. Confirm the export is stored first.", "completed", "low", "2026-10-12", ["ops", "archive"], null, "Ops", null],
    ["Form builder drag perf", "Reduce re-renders on drop and keep the selected field stable.", "in-progress", "high", "2026-10-25", ["perf", "dx", "builder"], null, "Platform", "2026-10-25T16:30:00.000Z"],
    ["Refresh empty states", "New copy for zero-result, filtered, and first-run states.", "todo", "medium", "2026-11-08", ["design", "copy"], "ux@acme.io", "Design", null],
    ["Publish form update to staging", "Coordinate with backend, confirm the schema version increments once.", "completed", "medium", "2026-10-21", ["release", "backend"], null, "Platform", null],
    ["Migrate legacy attachments", "Move uploads to object storage and keep signed URLs stable.", "todo", "medium", "2026-11-12", ["ops", "storage", "legacy"], null, "Ops", "2026-11-12T08:00:00.000Z"],
    ["Audit webhook retries", "Check backoff on failures and surface the final delivery status.", "in-progress", "low", "2026-11-14", ["api", "webhook"], "m.tan@acme.io", "Platform", null],
    ["Rename workspace roles", "Align labels with the new permission matrix. No behaviour change.", "todo", "low", "2026-11-06", ["permissions", "copy"], null, "Product", null],
    ["Add CSV export", "Export the current filtered view, including active custom fields.", "todo", "medium", "2026-11-18", ["export", "csv", "reporting"], "ops@acme.io", "Data", "2026-11-18T15:00:00.000Z"],
    ["Tighten form validation", "Validate required custom fields on the server before the task write.", "in-progress", "high", "2026-10-29", ["validation", "api"], null, "Platform", null],
    ["Rewrite task toolbar", "Keep search instant, move rare filters behind an overflow menu.", "todo", "medium", "2026-11-10", ["design", "toolbar"], "ux@acme.io", "Design", null],
    ["Deploy Cosmos partition fix", "Backfill organizationId where historical drafts are missing it.", "in-progress", "high", "2026-10-26", ["cosmos", "database", "migration"], null, "Data", "2026-10-26T07:30:00.000Z"],
    ["Document local setup", "Azure Functions Core Tools, Cosmos emulator, and seeded settings.", "todo", "low", "2026-11-16", ["docs", "dx"], null, "Platform", null],
    ["Fix drawer focus trap", "Return focus to the row action after the edit drawer closes.", "completed", "medium", "2026-10-14", ["a11y", "bug"], "sara.k@acme.io", "Design", null],
    ["Trim description helper", "Remove the misleading character count from the compact dialog.", "completed", "low", "2026-10-08", ["copy", "polish"], null, "Product", null],
    ["Prepare review walkthrough", "Cover schema migrations, pagination, validation, and drag behaviour.", "todo", "high", "2026-10-28", ["review", "demo"], "faiz@acme.io", "Product", "2026-10-28T12:00:00.000Z"],
    ["Check mobile builder tabs", "Components, definition, preview, and properties must all be reachable.", "in-progress", "medium", "2026-11-03", ["mobile", "builder", "a11y"], null, "Design", null],
    ["Add optimistic status updates", "Update the row immediately, roll back on a failed request.", "todo", "medium", "2026-11-09", ["state", "api"], null, "Platform", null],
    ["Retire old CSV script", "Delete the cron job after the new export ships for one week.", "completed", "low", "2026-10-16", ["ops", "cleanup"], null, "Ops", null],
].map(([title, description, status, priority, due, tags, email, department, requestedAt]) => ({
    title: title as string,
    description: description as string,
    status: status as Task["status"],
    priority: priority as NonNullable<Task["priority"]>,
    due: due as string,
    tags: tags as string[],
    email: email as string | null,
    department: department as string | null,
    requestedAt: requestedAt as string | null,
}));

function uuid(index: number): string {
    return `a1b2c3d4-e5f6-4a7b-8c9d-${String(index + 1).padStart(12, "0")}`;
}

export function seedTasks(): Task[] {
    return tasks.map((seed, index) => ({
        id: uuid(index),
        organizationId: SEED_ORGANIZATION_ID,
        title: seed.title,
        description: seed.description,
        status: seed.status,
        priority: seed.priority,
        dueDate: `${seed.due}T00:00:00.000Z`,
        tags: seed.tags,
        customFields: {
            client_email: seed.email,
            department: seed.department,
            requested_at: seed.requestedAt,
        },
        createdAt: new Date(Date.UTC(2026, 9, 1 + (index % 20), 9, 15)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 9, 20 + (index % 3), 11 + (index % 8), 0)).toISOString(),
    }));
}

export function seedFormSettings(): FormSettings {
    return {
        id: "task-form",
        organizationId: SEED_ORGANIZATION_ID,
        version: 3,
        title: "Task Form",
        description: "Fields are applied to every task.",
        coreFields: [
            { key: "title", label: "Title", visible: true, width: 1 },
            { key: "status", label: "Status", visible: true, width: 1 },
            { key: "description", label: "Description", visible: true, width: 2 },
            { key: "priority", label: "Priority", visible: true, width: 1 },
            { key: "dueDate", label: "Due Date", visible: true, width: 1 },
            { key: "tags", label: "Tags", visible: true, width: 2 },
        ],
        customFields: [
            {
                id: "c1f4b7a2-1111-4c1e-9a10-000000000001",
                key: "client_email",
                label: "Client Email",
                type: "email",
                required: true,
                placeholder: "name@company.com",
                description: "Confirmation is sent here",
                width: 1,
                active: true,
            },
            {
                id: "c1f4b7a2-2222-4c1e-9a10-000000000002",
                key: "department",
                label: "Department",
                type: "text",
                required: false,
                placeholder: "Select department",
                description: "",
                width: 1,
                active: true,
            },
            {
                id: "c1f4b7a2-3333-4c1e-9a10-000000000003",
                key: "requested_at",
                label: "Request date",
                type: "datetime",
                required: false,
                placeholder: "mm/dd/yyyy, --:--",
                description: "When the client needs the work delivered",
                width: 2,
                active: true,
            },
        ],
        rows: [
            {
                id: "c1f4b7a2-1111-4c1e-9a10-000000000001_c1f4b7a2-2222-4c1e-9a10-000000000002",
                fieldIds: [
                    "c1f4b7a2-1111-4c1e-9a10-000000000001",
                    "c1f4b7a2-2222-4c1e-9a10-000000000002",
                ],
            },
            { id: "c1f4b7a2-3333-4c1e-9a10-000000000003", fieldIds: ["c1f4b7a2-3333-4c1e-9a10-000000000003"] },
        ],
        updatedAt: new Date(Date.UTC(2026, 9, 22, 16, 20)).toISOString(),
    };
}
