import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TARGET_WEBHOOK_EVENTS } from "../src/translate.js";
import { allOperations, checkComponent, SPEC_PATH } from "./helpers/openapi-contract.js";

/** Every operation the CLI sends to BillionSend (src/billionsend.ts). */
const CLI_OPERATIONS = [
  "GET /usage",
  "GET /domains",
  "GET /domains/{id}",
  "POST /domains",
  "PATCH /domains/{id}",
  "DELETE /domains/{id}",
  "GET /contact-properties",
  "POST /contact-properties",
  "DELETE /contact-properties/{id}",
  "GET /topics",
  "POST /topics",
  "PATCH /topics/{id}",
  "DELETE /topics/{id}",
  "GET /segments",
  "POST /segments",
  "PATCH /segments/{id}",
  "DELETE /segments/{id}",
  "GET /webhooks",
  "POST /webhooks",
  "PATCH /webhooks/{id}",
  "DELETE /webhooks/{id}",
  "GET /templates",
  "GET /templates/{id}",
  "POST /templates",
  "PATCH /templates/{id}",
  "DELETE /templates/{id}",
  "GET /broadcasts",
  "POST /broadcasts",
  "DELETE /broadcasts/{id}",
  "GET /contacts",
  "POST /contacts/batch",
  "DELETE /contacts/{id}",
  "POST /contacts/{id}/segments/{segmentId}",
  "GET /suppressions",
  "POST /suppressions/batch/add",
  "POST /suppressions/batch/remove",
];

describe("the published API contract (openapi/api.openapi.json)", () => {
  it("documents every operation the CLI calls", () => {
    const documented = new Set(allOperations());
    expect(CLI_OPERATIONS.filter((op) => !documented.has(op))).toEqual([]);
  });

  it("accepts every webhook event the CLI carries over, in the API's order", () => {
    const problems = checkComponent("CreateWebhookRequest", {
      endpoint: "https://hooks.example.test",
      events: [...TARGET_WEBHOOK_EVENTS],
    });
    expect(problems).toEqual([]);
    const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
      components: {
        schemas: {
          CreateWebhookRequest: { properties: { events: { items: { enum: string[] } } } };
        };
      };
    };
    const order = spec.components.schemas.CreateWebhookRequest.properties.events.items.enum;
    const carried: readonly string[] = TARGET_WEBHOOK_EVENTS;
    expect(order.filter((event) => carried.includes(event))).toEqual([...TARGET_WEBHOOK_EVENTS]);
  });

  it("takes the segment filter shape the CLI writes", () => {
    expect(
      checkComponent("SegmentFilter", {
        match: "all",
        conditions: [{ field: "property:plan", op: "equals", value: "pro" }],
      }),
    ).toEqual([]);
  });
});
