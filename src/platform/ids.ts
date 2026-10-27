import { HttpRequest } from "@azure/functions";
import { ValidationError } from "./http";

/* Request-boundary guards. Kept apart from `http.ts` so the response helpers and
   the id contract can be read and tested independently. */

/* Every document is partitioned by organization, so an invalid id would either
   create unreachable data or silently scope a request to a phantom org. Reject
   it at the boundary, before it reaches Cosmos. */
const ORGANIZATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireOrganizationId(request: HttpRequest): string {
    const organizationId = request.query.get("organizationId");
    if (!organizationId) {
        throw new ValidationError("organizationId is required");
    }
    if (!ORGANIZATION_ID_PATTERN.test(organizationId)) {
        throw new ValidationError("organizationId must be a UUID");
    }
    return organizationId;
}

export function requireIdAndOrganizationId(request: HttpRequest): { id: string; organizationId: string } {
    const id = request.query.get("id");
    if (!id) {
        throw new ValidationError("id is required");
    }
    return { id, organizationId: requireOrganizationId(request) };
}
