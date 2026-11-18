import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plan } from "../src/model.js";
import { type ContractApi, startContractApi } from "./helpers/contract-api.js";
import { type FakeResend, loadFixtures, startFakeResend } from "./helpers/fake-resend.js";
import { cliRunner, readReportIn, readStateIn } from "./helpers/run-cli.js";

const SLOW = 120_000;

const STEVE = "e169aa45-1ecf-4183-9955-b1499d5701d3";
const ADA = "a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d";
const GRACE = "f0e1d2c3-b4a5-4968-8776-655443322110";
const NEWSLETTER = "c7e35c9f-b01c-4d4d-9f1d-46acce08492f";
const BETA = "5e0a0000-0000-4000-8000-000000000002";
const ACTIVE = "78261eea-8f8b-4381-83c6-79fa7120f1cf";

let fake: FakeResend;
let api: ContractApi;
let dir: string;
let run: ReturnType<typeof cliRunner>;

/** The fixture account plus a second segment holding only Grace, who is opted in to the opt_out-by-default Newsletter. */
function account() {
  const data = loadFixtures();
  data.segments.push({
    id: BETA,
    name: "Beta",
    created_at: "2024-06-01 00:00:00.000+00",
    member_ids: [GRACE],
  });
  const grace = data.contacts.find((c) => c.id === GRACE);
  if (grace) {
    grace.topics = [
      {
        id: NEWSLETTER,
        name: "Newsletter",
        description: null,
        subscription: "opt_in",
      },
    ];
  }
  return data;
}

async function boot(data = account()): Promise<void> {
  [fake, api] = await Promise.all([startFakeResend(data), startContractApi()]);
  dir = mkdtempSync(join(tmpdir(), "billionsend-cli-options-"));
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  run = cliRunner(fake, api, dir);
}

const subscriptions = (email: string): Record<string, boolean> => {
  const contact = [...api.store.contacts.values()].find((c) => c.email === email);
  const subs = contact ? api.store.topicSubscriptions.get(contact.id) : undefined;
  const topicName = (id: string) => api.store.topics.get(id)?.name ?? id;
  return Object.fromEntries([...(subs ?? [])].map(([id, on]) => [topicName(id), on]));
};

afterEach(async () => {
  await Promise.all([fake.close(), api.stop()]);
});

describe("--segment", () => {
  beforeEach(() => boot());

  it(
    "reads, creates and enriches only the chosen segment, from its own member list",
    async () => {
      const { code, stdout } = await run([
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--segment",
        "Beta",
      ]);
      expect(code).toBe(0);
      expect([...api.store.contacts.values()].map((c) => c.email)).toEqual(["grace@example.net"]);
      expect([...api.store.segments.values()].map((s) => s.name)).toEqual(["Beta"]);
      // Grace's explicit opt_in to a topic that is opt_out by default is written.
      expect(subscriptions("grace@example.net")).toEqual({ Newsletter: true });
      expect(stdout).toContain("Scope (--segment): only Beta and its members");

      const paths = fake.requests.map((r) => r.path);
      expect(paths).toContain(`/segments/${BETA}/contacts`);
      expect(paths).not.toContain(`/segments/${ACTIVE}/contacts`);
      // GET /contacts ignores segment_id on Resend: the account-wide list is never read.
      expect(paths).not.toContain("/contacts");
      expect(paths.filter((p) => /^\/contacts\/[^/]+$/.test(p))).toEqual([`/contacts/${GRACE}`]);
      expect(readReportIn(dir).scope).toEqual({ segments: [{ id: BETA, name: "Beta" }] });
    },
    SLOW,
  );

  it(
    "takes names and ids, repeated or comma separated, and each member once",
    async () => {
      const { code } = await run([
        "migrate",
        "plan",
        "--from",
        "resend",
        "--json",
        "--segment",
        ACTIVE,
        "--segment",
        "beta,Active Users",
      ]);
      expect(code).toBe(2);
      const paths = fake.requests.map((r) => r.path);
      expect(paths.filter((p) => p === `/segments/${ACTIVE}/contacts`)).toHaveLength(1);
      const { stdout } = await run([
        "migrate",
        "plan",
        "--from",
        "resend",
        "--json",
        "--segment",
        `${ACTIVE},Beta`,
      ]);
      const plan = JSON.parse(stdout) as Plan;
      expect(plan.items.find((i) => i.resource === "contacts")?.count).toBe(3);
      expect(plan.scope?.segments.map((s) => s.name)).toEqual(["Active Users", "Beta"]);
      expect(plan.options.segment).toEqual([ACTIVE, "Beta"]);
    },
    SLOW,
  );

  it(
    "a name or id that does not exist is exit 1, lists the segments, and writes nothing",
    async () => {
      const { code, stderr } = await run([
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--segment",
        "Nope",
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("`Nope`");
      expect(stderr).toContain(`Active Users  (${ACTIVE})`);
      expect(stderr).toContain(`Beta  (${BETA})`);
      expect(api.store.contacts.size).toBe(0);
      expect(readStateIn(dir)).toBeNull();
    },
    SLOW,
  );

  it(
    "skips a broadcast sent to a segment outside the selection",
    async () => {
      const data = account();
      data.broadcasts.push({
        id: "b0000000-0000-4000-8000-000000000001",
        name: "For active users",
        status: "draft",
        segment_id: ACTIVE,
        topic_id: null,
        scheduled_at: null,
        from: "Acme <hi@example.com>",
        subject: "Hi",
        html: "<p>Hi</p>",
      });
      await fake.close();
      await api.stop();
      await boot(data);
      const { stdout } = await run([
        "migrate",
        "plan",
        "--from",
        "resend",
        "--only",
        "broadcasts",
        "--segment",
        "Beta",
      ]);
      expect(stdout).toContain("For active users  sent to a segment outside --segment");
    },
    SLOW,
  );
});

describe("plan files record their options", () => {
  beforeEach(() => boot());

  it(
    "apply follows the file's --only and --segment, and refuses a different value",
    async () => {
      const file = join(dir, "plan.json");
      const planned = await run([
        "migrate",
        "plan",
        "--from",
        "resend",
        "--only",
        "segments,contacts",
        "--segment",
        "Beta",
        "--on-conflict",
        "skip",
        "--out",
        file,
      ]);
      expect(planned.code).toBe(2);
      const saved = JSON.parse(readFileSync(file, "utf8")) as Plan;
      expect(saved.version).toBe(2);
      expect(saved.options).toEqual({
        only: ["segments", "contacts"],
        skip: [],
        segment: ["Beta"],
        onConflict: "skip",
        includeSent: false,
        freshWebhookSecrets: false,
      });

      const conflicting = await run(["migrate", "apply", file, "--yes", "--only", "domains"]);
      expect(conflicting.code).toBe(1);
      expect(conflicting.stderr).toContain("--only: the command line has domains");
      expect(conflicting.stderr).toContain("the file has segments,contacts");
      expect(conflicting.stderr).toContain("leave these flags out");
      expect(api.store.contacts.size).toBe(0);

      // The same values are no conflict.
      const applied = await run([
        "migrate",
        "apply",
        file,
        "--yes",
        "--segment",
        "Beta",
        "--only",
        "contacts,segments",
        "--on-conflict",
        "skip",
      ]);
      expect(applied.stderr).toBe("");
      expect(applied.code).toBe(0);
      expect([...api.store.contacts.values()].map((c) => c.email)).toEqual(["grace@example.net"]);
      expect(api.store.topics.size).toBe(0);
      expect(api.store.domains.size).toBe(0);
    },
    SLOW,
  );

  it(
    "apply with no flags takes everything from the file",
    async () => {
      const file = join(dir, "plan.json");
      await run([
        "migrate",
        "plan",
        "--from",
        "resend",
        "--skip",
        "enrichment,domains",
        "--segment",
        "Beta",
        "--out",
        file,
      ]);
      const { code, stderr } = await run(["migrate", "apply", file, "--yes"]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect([...api.store.contacts.values()].map((c) => c.email)).toEqual(["grace@example.net"]);
      expect([...api.store.segments.values()].map((s) => s.name)).toEqual(["Beta"]);
      expect(api.store.domains.size).toBe(0);
      expect(subscriptions("grace@example.net")).toEqual({});
    },
    SLOW,
  );

  it(
    "a plan that differs for another reason says what changed and what to do",
    async () => {
      const file = join(dir, "plan.json");
      await run(["migrate", "plan", "--from", "resend", "--only", "contacts", "--out", file]);
      fake.data.contacts.push({
        id: "00000000-0000-4000-8000-0000000000a1",
        email: "new@example.org",
        created_at: "2026-09-01 00:00:00.000+00",
        unsubscribed: false,
      });
      const { code, stderr } = await run(["migrate", "apply", file, "--yes"]);
      expect(code).toBe(1);
      expect(stderr).toContain("differs from the plan just built");
      expect(stderr).toContain("The options are the file's own");
      expect(stderr).toContain("contacts/contacts: create → create, 3 → 4");
      expect(stderr).toContain(`migrate plan --out ${file}`);
      expect(stderr).not.toContain("Re-run `migrate plan --out`, or apply without a file.");
      expect(api.store.contacts.size).toBe(0);
    },
    SLOW,
  );

  it(
    "plan --report writes the plan as a Markdown report",
    async () => {
      const report = join(dir, "plan-report.md");
      const { code, stdout } = await run([
        "migrate",
        "plan",
        "--from",
        "resend",
        "--segment",
        "Beta",
        "--report",
        report,
      ]);
      expect(code).toBe(2);
      expect(stdout).toContain(`Plan report written to ${report}`);
      const md = readFileSync(report, "utf8");
      expect(md).toContain("# Migration plan — Resend → BillionSend");
      expect(md).toContain("Scope (--segment): only Beta and its members");
      expect(md).toMatch(/\| contacts \| 1 \| 0 \| 0 \| 0 \| 0 \|/);
      expect(md).toContain("Nothing has been written");
      expect(api.store.contacts.size).toBe(0);
    },
    SLOW,
  );
});

describe("property keys that differ only in case", () => {
  it(
    "creates the first key, lists the other as manual, and counts the contacts whose value was not written",
    async () => {
      const data = account();
      data.contact_properties.push({
        id: "00000000-0000-4000-8000-0000000000c1",
        key: "PLAN",
        type: "string",
        created_at: "2024-02-02 09:00:00.000+00",
      });
      for (const contact of data.contacts) {
        if (contact.id === STEVE) contact.properties = { plan: "pro", PLAN: "Pro", seats: 5 };
        if (contact.id === ADA) contact.properties = { plan: "pro", PLAN: "PRO" };
      }
      await boot(data);
      const { code, stdout } = await run(["migrate", "--from", "resend", "--yes"]);
      expect(code).toBe(0);
      expect(stdout).toContain("PLAN  differs from `plan` only in case");
      expect([...api.store.contactProperties.values()].map((p) => p.key).sort()).toEqual([
        "plan",
        "seats",
      ]);
      // The value written is plan's own; PLAN's never replaces it.
      const steve = [...api.store.contacts.values()].find(
        (c) => c.email === "steve.wozniak@gmail.com",
      );
      expect(steve?.properties).toMatchObject({ plan: "pro" });
      expect(stdout).toContain("2  property values not written");
      const report = readReportIn(dir);
      expect(report.enrichment?.droppedProperties).toEqual([
        { key: "PLAN", collidesWith: "plan", contacts: 2 },
      ]);
      expect(report.manual).toContainEqual({
        title: "properties/PLAN",
        detail: expect.stringContaining("2 contacts had a value for it that was not written"),
      });
    },
    SLOW,
  );

  it(
    "a source key that differs only in case from one already on BillionSend is that property",
    async () => {
      await boot();
      await fetch(`${api.baseUrl}/contact-properties`, {
        method: "POST",
        headers: { authorization: `Bearer ${api.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ key: "Plan", type: "string" }),
      });
      const planned = await run(["migrate", "plan", "--from", "resend", "--only", "properties"]);
      expect(planned.stdout).toContain("= plan  already here as `Plan` (keys ignore case)");
      expect(planned.stdout).not.toContain("+ plan");
      const { code } = await run(["migrate", "--from", "resend", "--yes"]);
      expect(code).toBe(0);
      expect([...api.store.contactProperties.values()].map((p) => p.key).sort()).toEqual([
        "Plan",
        "seats",
      ]);
    },
    SLOW,
  );
});

describe("runs in two steps", () => {
  beforeEach(() => boot());

  it(
    "contacts created by an earlier run still get their explicit opt-in when the enrichment runs later",
    async () => {
      const first = await run([
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--only",
        "segments,contacts",
      ]);
      expect(first.code).toBe(0);
      expect(subscriptions("grace@example.net")).toEqual({});
      const second = await run(["migrate", "--from", "resend", "--yes"]);
      expect(second.code).toBe(0);
      // Newsletter is opt_out by default: Grace's opt_in must be written, not dropped as an update.
      expect(subscriptions("grace@example.net")).toEqual({ Newsletter: true });
    },
    SLOW,
  );

  it(
    "after a finished enrichment, a contact created later keeps its opt-in too; one enriched before keeps its target opt-out",
    async () => {
      const first = await run(["migrate", "--from", "resend", "--yes"]);
      expect(first.code).toBe(0);
      expect(readStateIn(dir)?.progress.enrichmentCompleted).toBe(true);
      expect(readStateIn(dir)?.progress.pendingEnrichment).toBeUndefined();

      // Grace opts out of the Newsletter on BillionSend after the first run.
      const grace = [...api.store.contacts.values()].find((c) => c.email === "grace@example.net");
      api.store.topicSubscriptions.set(
        grace?.id ?? "",
        new Map([
          [[...api.store.topics.values()].find((t) => t.name === "Newsletter")?.id ?? "", false],
        ]),
      );

      fake.data.contacts.push({
        id: "00000000-0000-4000-8000-0000000000a2",
        email: "late@example.org",
        created_at: "2026-09-01 00:00:00.000+00",
        unsubscribed: false,
        properties: {},
        topics: [{ id: NEWSLETTER, name: "Newsletter", description: null, subscription: "opt_in" }],
      });
      const contactsOnly = await run([
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--only",
        "contacts",
      ]);
      expect(contactsOnly.code).toBe(0);
      expect(readStateIn(dir)?.progress.pendingEnrichment).toEqual(["late@example.org"]);
      const status = await run(["migrate", "status"]);
      expect(status.stdout).toMatch(/Waiting\s+1 contact not enriched yet/);

      const enrichmentOnly = await run([
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--only",
        "topics,properties,enrichment",
      ]);
      expect(enrichmentOnly.code).toBe(0);
      expect(subscriptions("late@example.org")).toEqual({ Newsletter: true });
      // Grace was enriched in the first run: only opt-outs are sent again, her target opt-out stands.
      expect(subscriptions("grace@example.net")).toEqual({ Newsletter: false });
      expect(readStateIn(dir)?.progress.pendingEnrichment).toBeUndefined();
    },
    SLOW,
  );
});

describe("pending enrichment", () => {
  beforeEach(() => boot());

  it(
    "a run that leaves the topics out does not finish a contact's enrichment",
    async () => {
      expect((await run(["migrate", "--from", "resend", "--yes", "--only", "contacts"])).code).toBe(
        0,
      );
      expect(readStateIn(dir)?.progress.pendingEnrichment).toHaveLength(3);

      // Properties only: the enrichment completes, but no topic was written.
      const propertiesOnly = await run([
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--only",
        "properties,enrichment",
      ]);
      expect(propertiesOnly.code).toBe(0);
      expect(readStateIn(dir)?.progress.enrichmentCompleted).toBe(true);
      expect(readStateIn(dir)?.progress.pendingEnrichment).toHaveLength(3);

      // The topics follow later: Grace's opt-in to a topic that defaults to opt_out is written.
      const full = await run([
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--skip",
        "domains,webhooks",
      ]);
      expect(full.code).toBe(0);
      expect(subscriptions("grace@example.net")).toEqual({ Newsletter: true });
      expect(readStateIn(dir)?.progress.pendingEnrichment).toBeUndefined();
    },
    SLOW,
  );
});

describe("what a run reports", () => {
  beforeEach(() => boot());

  it(
    "counts contacts the batch endpoint matched as matched existing, not as updated",
    async () => {
      expect((await run(["migrate", "--from", "resend", "--yes"])).code).toBe(0);
      const { code, stdout } = await run(["migrate", "--from", "resend", "--yes"]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/3\s+contacts matched existing/);
      expect(stdout).not.toMatch(/contacts updated/);
      const report = readReportIn(dir);
      expect(report.counts.contacts).toMatchObject({ created: 0, updated: 0, matched: 3 });
      expect(readFileSync(join(dir, ".billionsend", "migrate-report.md"), "utf8")).toContain(
        "| contacts | 0 | 0 | 3 |",
      );
    },
    SLOW,
  );

  it(
    "tells the user to point the app at the public API address, not at a local --to-url",
    async () => {
      const { code, stdout } = await run(["migrate", "--from", "resend", "--yes"]);
      expect(code).toBe(0);
      expect(stdout).toContain(
        [
          "  [ ] set RESEND_BASE_URL=https://api.billionsend.com in your app, so Resend SDK",
          `      calls go to BillionSend (this run used ${api.baseUrl}; put that`,
          "      address there only if your app reaches BillionSend through it)",
          "",
        ].join("\n"),
      );
      expect(stdout).not.toContain(`RESEND_BASE_URL=${api.baseUrl}`);
      expect(readReportIn(dir).checklist.left.join("\n")).not.toContain(
        `RESEND_BASE_URL=${api.baseUrl}`,
      );
    },
    SLOW,
  );
});
