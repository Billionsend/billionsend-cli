import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plan } from "../src/model.js";
import { migratePaths, writePrivateJson } from "../src/paths.js";
import { planHash } from "../src/plan.js";
import { type ContractApi, startContractApi } from "./helpers/contract-api.js";
import {
  type FakeResend,
  type FakeResendData,
  loadFixtures,
  startFakeResend,
} from "./helpers/fake-resend.js";
import { cliRunner, readReportIn, readStateIn } from "./helpers/run-cli.js";

/*
 * The paths through applying a plan that a first clean run never takes: rows that exist and differ,
 * a run that picks up where another stopped, writes the API refuses, passes with nothing to carry.
 */

const SLOW = 120_000;

let fake: FakeResend;
let api: ContractApi;
let dir: string;
let run: ReturnType<typeof cliRunner>;

async function boot(change: (data: FakeResendData) => void = () => {}): Promise<void> {
  const data = loadFixtures();
  change(data);
  [fake, api] = await Promise.all([startFakeResend(data), startContractApi()]);
  dir = mkdtempSync(join(tmpdir(), "billionsend-cli-paths-"));
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  run = cliRunner(fake, api, dir);
}

afterEach(async () => {
  await Promise.all([fake.close(), api.stop()]);
});

const go = (...extra: string[]) =>
  run(["migrate", "--from", "resend", "--yes", "--rps", "10", ...extra]);

describe("rows that exist on BillionSend and differ from the source", () => {
  beforeEach(() => boot());

  it(
    "are updated in place, one kind after another, and the report counts them as updated",
    async () => {
      expect((await go("--skip", "contacts,enrichment,broadcasts,suppressions,domains")).code).toBe(
        0,
      );
      const topicsBefore = [...api.store.topics.keys()];
      const webhooksBefore = [...api.store.webhooks.keys()];
      // The source changes: a topic's description, a segment's filter, a webhook's events, a template's body.
      const topic = fake.data.topics[0] as (typeof fake.data.topics)[number];
      topic.description = "A new description";
      const segment = fake.data.segments[0] as (typeof fake.data.segments)[number];
      segment.filter = { conditions: [{ field: "email", operator: "contains", value: "example" }] };
      const webhook = fake.data.webhooks[0] as (typeof fake.data.webhooks)[number];
      webhook.events = ["email.sent"];
      const template = fake.data.templates[0] as (typeof fake.data.templates)[number];
      template.html = "<h1>New</h1>";
      const second = await go("--skip", "contacts,enrichment,broadcasts,suppressions,domains");
      expect(second.code).toBe(0);
      expect([...api.store.topics.keys()]).toEqual(topicsBefore);
      expect([...api.store.webhooks.keys()]).toEqual(webhooksBefore);
      expect(
        [...api.store.topics.values()].find((t) => t.description === "A new description"),
      ).toBeDefined();
      expect([...api.store.webhooks.values()][0]?.events).toEqual(["email.sent"]);
      expect([...api.store.templates.values()][0]?.html).toBe("<h1>New</h1>");
      const counts = readReportIn(dir).counts;
      expect(counts.topics).toMatchObject({ created: 0, updated: 1 });
      expect(counts.segments).toMatchObject({ created: 0, updated: 1 });
      expect(counts.webhooks).toMatchObject({ created: 0, updated: 1 });
      expect(counts.templates).toMatchObject({ created: 0, updated: 1 });
    },
    SLOW,
  );
});

describe("a run that picks up where another stopped", () => {
  beforeEach(() => boot());

  it(
    "resumes after the contact the state names, and says so",
    async () => {
      const file = join(dir, "plan.json");
      expect(
        (await run(["migrate", "plan", "--from", "resend", "--only", "contacts", "--out", file]))
          .code,
      ).toBe(2);
      const plan = JSON.parse(
        await import("node:fs").then((fs) => fs.readFileSync(file, "utf8")),
      ) as Plan;
      const [first] = fake.data.contacts;
      writePrivateJson(migratePaths(dir).state, {
        version: 1,
        startedAt: "2026-11-19T00:00:00.000Z",
        updatedAt: "2026-11-19T00:00:00.000Z",
        planHash: planHash(plan),
        target: { baseUrl: api.baseUrl },
        created: {},
        progress: { contactsCursor: first?.id },
        failures: [],
      });
      const { code, stdout } = await run(["migrate", "apply", file, "--yes", "--rps", "10"]);
      expect(code).toBe(0);
      expect(stdout).toContain("resuming after 1 contacts done in an earlier run");
      expect(api.store.contacts.size).toBe(2);
      expect(readStateIn(dir)?.progress.contactsCursor).toBeNull();
    },
    SLOW,
  );
});

describe("writes the API refuses", () => {
  beforeEach(() => boot());

  it(
    "a suppressions batch that fails is listed one by one and exits 3",
    async () => {
      const refuse: typeof fetch = async (url, init) =>
        String(url).includes("/suppressions/batch/add")
          ? new Response(JSON.stringify({ name: "validation_error", message: "no" }), {
              status: 422,
              headers: { "content-type": "application/json" },
            })
          : fetch(url, init);
      const { code, stdout } = await run(
        ["migrate", "--from", "resend", "--yes", "--rps", "10", "--only", "suppressions"],
        { fetch: refuse },
      );
      expect(code).toBe(3);
      expect(stdout).toContain("✗ suppressions/bounced@example.org");
      expect(api.store.suppressions.size).toBe(0);
    },
    SLOW,
  );

  it(
    "an enrichment batch that fails is listed per contact, and the contacts stay waiting",
    async () => {
      const refuse: typeof fetch = async (url, init) => {
        if (String(url).includes("/contacts/batch?") && init?.method === "POST") {
          const items = JSON.parse(String(init.body)) as { unsubscribed?: boolean }[];
          // Only the enrichment pass sends items without the unsubscribed flag.
          if (items.every((i) => i.unsubscribed === undefined)) {
            return new Response(JSON.stringify({ name: "validation_error", message: "no" }), {
              status: 422,
              headers: { "content-type": "application/json" },
            });
          }
        }
        return fetch(url, init);
      };
      const { code, stdout } = await run(["migrate", "--from", "resend", "--yes", "--rps", "10"], {
        fetch: refuse,
      });
      expect(code).toBe(3);
      expect(stdout).toContain("✗ enrichment/");
      // Grace has no topics to send, so she is not waiting; the other two are.
      expect(readStateIn(dir)?.progress.pendingEnrichment).toHaveLength(2);
    },
    SLOW,
  );
});

describe("a source with little to carry", () => {
  it(
    "says why a pass is skipped: no topics on the source, or no properties",
    async () => {
      await boot((data) => {
        data.topics = [];
        for (const contact of data.contacts) contact.topics = [];
      });
      const noTopics = await go("--skip", "domains,webhooks,broadcasts");
      expect(noTopics.code).toBe(0);
      expect(noTopics.stdout).toContain("Enrichment · topics: skipped, no topics on the source");
      await Promise.all([fake.close(), api.stop()]);

      await boot((data) => {
        data.contact_properties = [];
        for (const contact of data.contacts) contact.properties = {};
      });
      const noProperties = await go("--skip", "domains,webhooks,broadcasts");
      expect(noProperties.code).toBe(0);
      expect(noProperties.stdout).toContain(
        "Enrichment · properties: skipped, no contact properties on the source",
      );
    },
    SLOW,
  );
});

describe("a source whose pieces cannot all be made", () => {
  beforeEach(() =>
    boot((data) => {
      // A webhook of events BillionSend has no counterpart for, a template with no body, a broadcast with no body,
      // and a broadcast from a domain that is not verified here.
      data.webhooks = [
        {
          id: "w1",
          endpoint: "https://hooks.example.test/none",
          events: ["audience.created"],
          status: "enabled",
          signing_secret: "whsec_x",
        },
      ];
      data.templates = [{ id: "tp1", name: "Empty", alias: null, html: null }];
      data.broadcasts = [
        { id: "b1", name: "No body", from: "a@example.com", subject: "s", status: "draft" },
        {
          id: "b2",
          name: "Elsewhere",
          from: "a@unverified.example.net",
          subject: "s",
          html: "<p>x</p>",
          status: "draft",
          segment_id: null,
          topic_id: null,
        },
      ];
    }),
  );

  it(
    "each is a manual note with its reason, never a failure",
    async () => {
      const { code, stdout } = await run([
        "migrate",
        "plan",
        "--from",
        "resend",
        "--only",
        "webhooks,templates,broadcasts",
      ]);
      expect(code).toBe(0);
      expect(stdout).toContain("none of its events exist here; not created");
      expect(stdout).toContain("template has no html body");
      expect(stdout).toContain("broadcast has no body");
      expect(stdout).toContain("from domain unverified.example.net is not verified here");
    },
    SLOW,
  );
});
