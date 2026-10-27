import { describe, expect, it } from "vitest";
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { handler, ValidationError } from "./http";
import { requireIdAndOrganizationId, requireOrganizationId } from "./ids";
import { SEED_ORGANIZATION_ID } from "../seed";

/* Minimal fakes: the handler only touches `query.get` and `method` on the
   request and `log`/`error` on the context, so a stub with those is enough and
   the tests stay free of the Functions runtime. */
function fakeRequest(query: Record<string, string> = {}, method = "GET"): HttpRequest {
    return {
        method,
        query: new Map(Object.entries(query)),
    } as unknown as HttpRequest;
}

function fakeContext(): InvocationContext & { logs: string[]; errors: unknown[] } {
    const logs: string[] = [];
    const errors: unknown[] = [];
    return {
        log: (message: string) => logs.push(message),
        error: (...args: unknown[]) => errors.push(args),
        logs,
        errors,
    } as unknown as InvocationContext & { logs: string[]; errors: unknown[] };
}

const ORG = SEED_ORGANIZATION_ID;

describe("requireOrganizationId", () => {
    it("returns a valid UUID", () => {
        expect(requireOrganizationId(fakeRequest({ organizationId: ORG }))).toBe(ORG);
    });

    it("throws when missing or not a UUID", () => {
        expect(() => requireOrganizationId(fakeRequest())).toThrow(ValidationError);
        expect(() => requireOrganizationId(fakeRequest({ organizationId: "org-demo" }))).toThrow(/UUID/);
    });
});

describe("requireIdAndOrganizationId", () => {
    it("returns both values", () => {
        expect(requireIdAndOrganizationId(fakeRequest({ id: "t1", organizationId: ORG }))).toEqual({ id: "t1", organizationId: ORG });
    });

    it("throws when id is missing", () => {
        expect(() => requireIdAndOrganizationId(fakeRequest({ organizationId: ORG }))).toThrow(/id/);
    });
});

describe("handler", () => {
    it("passes a successful response straight through and logs one line with id", async () => {
        const context = fakeContext();
        const wrapped = handler("GetTask", async () => ({ status: 200, jsonBody: { ok: true } }));
        const response = await wrapped(fakeRequest({ organizationId: ORG, id: "t1" }), context);

        expect(response.status).toBe(200);
        expect(context.logs).toHaveLength(1);
        expect(context.logs[0]).toMatch(/GET GetTask 200 \d+ms/);
        expect(context.logs[0]).toContain(`org=${ORG}`);
        expect(context.logs[0]).toContain("id=t1");
    });

    it("answers CORS preflight without calling the function", async () => {
        const context = fakeContext();
        let called = false;
        const wrapped = handler("GetTask", async () => {
            called = true;
            return { status: 200 };
        });
        const response = await wrapped(fakeRequest({}, "OPTIONS"), context);

        expect(response.status).toBe(204);
        expect(called).toBe(false);
    });

    it("maps a ValidationError to a 400 with the message", async () => {
        const context = fakeContext();
        const wrapped = handler("InsertTask", async () => {
            throw new ValidationError("title: is required");
        });
        const response = await wrapped(fakeRequest({ organizationId: ORG }), context);

        expect(response.status).toBe(400);
        expect(response.jsonBody).toEqual({ error: "title: is required" });
        expect(context.errors).toHaveLength(0);
    });

    it("maps Cosmos throttling (code 429) to 429", async () => {
        const context = fakeContext();
        const wrapped = handler("GetTasks", async () => {
            throw Object.assign(new Error("Request rate is large"), { code: 429 });
        });
        const response = await wrapped(fakeRequest({ organizationId: ORG }), context);

        expect(response.status).toBe(429);
        expect(context.errors).toHaveLength(0);
    });

    it("maps Cosmos conflict (code 409) to 409", async () => {
        const context = fakeContext();
        const wrapped = handler("SaveFormSettings", async () => {
            throw Object.assign(new Error("Conflict"), { code: 409 });
        });
        const response = await wrapped(fakeRequest({ organizationId: ORG }), context);

        expect(response.status).toBe(409);
    });

    it("maps anything else to a 500, logs the error and never leaks it", async () => {
        const context = fakeContext();
        const wrapped = handler("GetTasks", async () => {
            throw new Error("boom: secret detail");
        });
        const response = await wrapped(fakeRequest({ organizationId: ORG }), context);

        expect(response.status).toBe(500);
        expect(response.jsonBody).toEqual({ error: "Internal server error" });
        expect(context.errors).toHaveLength(1);
    });
});
