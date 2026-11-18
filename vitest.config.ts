import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Many tests drive the contract API through the CLI's own rate limiter
    // (10 req/s to the target): a hundred writes is ten seconds before a
    // 2-core CI runner adds its share.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // Every contract API checks requests and answers against openapi/api.openapi.json.
    setupFiles: ["test/setup.ts"],
    globalSetup: ["test/global-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "json-summary"],
      // The floor of the in-process suites (the subprocess runs of the built bundle are not counted).
      thresholds: { statements: 88, branches: 80, functions: 91, lines: 90 },
    },
  },
});
