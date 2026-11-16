import { afterEach, expect } from "vitest";
import { takeViolations } from "./helpers/contract-api.js";

// A request or answer off the published OpenAPI document fails the test that made it.
afterEach(() => {
  expect(takeViolations(), "requests or answers off the published API contract").toEqual([]);
});
