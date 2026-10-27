import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validate } from "./validate";
import { ValidationError } from "./http";

describe("validate", () => {
    it("returns the parsed value for valid input", () => {
        const schema = z.object({ title: z.string().min(1) });
        expect(validate(schema, { title: "Write docs" })).toEqual({ title: "Write docs" });
    });

    it("throws ValidationError naming the failing field", () => {
        const schema = z.object({ title: z.string().min(1) });
        expect(() => validate(schema, { title: "" })).toThrow(ValidationError);
        expect(() => validate(schema, { title: "" })).toThrow(/title:/);
    });

    it("labels a top-level failure as 'body'", () => {
        const schema = z.object({ title: z.string() });
        expect(() => validate(schema, null)).toThrow(/body:/);
    });
});
