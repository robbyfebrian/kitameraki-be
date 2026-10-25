import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function ok(body: unknown, status = 200): HttpResponseInit {
    return body === undefined ? { status, headers: CORS_HEADERS } : { status, jsonBody: body, headers: CORS_HEADERS };
}

export function fail(status: number, message: string): HttpResponseInit {
    return { status, jsonBody: { error: message }, headers: CORS_HEADERS };
}

export function preflight(): HttpResponseInit {
    return { status: 204, headers: CORS_HEADERS };
}

export class ValidationError extends Error {}

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


/* Every HTTP function is wrapped so it answers the CORS preflight itself
   (Azure Functions has no host-level preflight handler by default) and so all
   failures are mapped and logged the same way. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"];

export function handler(
    name: string,
    fn: (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>
): (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit> {
    return async (request, context) => {
        if (request.method === "OPTIONS") return preflight();

        const started = Date.now();
        let status = 500;
        const organizationId = request.query.get("organizationId") ?? "";
        const id = request.query.get("id") ?? "";
        const method = request.method;

        try {
            const response = await fn(request, context);
            status = response.status ?? 200;
            return response;
        } catch (err) {
            if (err instanceof ValidationError) {
                status = 400;
                return fail(400, err.message);
            }
            // Cosmos surfaces its own status in `code`. Pass through the two the
            // client can act on: 429 is "retry later" (RU/s throttled), 409 is a
            // conflict the caller can resolve. Anything else is an unexpected 500.
            const code = (err as { code?: number }).code;
            if (code === 429) {
                status = 429;
                return fail(429, "Too many requests, retry later");
            }
            if (code === 409) {
                status = 409;
                return fail(409, "Conflict");
            }
            context.error(`${name} failed`, err);
            return fail(500, "Internal server error");
        } finally {
            // One line per request. Never log the body. `id` is present only on
            // requests that target a specific task.
            context.log(`${method} ${name} ${status} ${Date.now() - started}ms org=${organizationId} id=${id}`);
        }
    };
}
