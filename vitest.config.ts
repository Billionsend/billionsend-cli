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
      // The tests that run the built bundle as a child process count too: Vitest hands the child its
      // NODE_V8_COVERAGE, and the bundle's source map puts its lines back on src/.
      autoAttachSubprocess: true,
      // The bundle sits in dist/, which is excluded by default; what counts is the src/ file it maps to.
      excludeAfterRemap: true,
      // The built bundle's own path must pass the filter to be read; its lines are then put back on src/.
      include: ["src/**", "dist/index.js"],
      exclude: ["node_modules/**", "test/**"],
      reporter: ["text", "json-summary"],
      // Measured with the child processes counted: statements 99.1, branches 95.3, functions 99.6, lines 99.7.
      thresholds: { statements: 97, branches: 95, functions: 97, lines: 97 },
    },
  },
});
