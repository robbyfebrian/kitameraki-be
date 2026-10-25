import { defineConfig } from "vitest/config";

/* Tests run against TypeScript sources directly; nothing here touches Cosmos,
   so no emulator or connection string is needed. */
export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
        environment: "node",
    },
});
