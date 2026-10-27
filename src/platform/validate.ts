import { ZodType } from "zod";
import { ValidationError } from "./http";

export function validate<T>(schema: ZodType<T>, data: unknown): T {
    const result = schema.safeParse(data);
    if (!result.success) {
        throw new ValidationError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    }
    return result.data;
}
