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
  },
});
