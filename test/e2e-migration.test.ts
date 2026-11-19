import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MigrateState, Plan } from "../src/model.js";
import { migratePaths } from "../src/paths.js";
import type { Report } from "../src/report.js";
import { type ContractApi, startContractApi } from "./helpers/contract-api.js";
import { type FakeResend, loadFixtures, startFakeResend } from "./helpers/fake-resend.js";

/*
 * The built bundle as a real subprocess, one migration at a time, against a
 * fake Resend and the contract API. These pin what a migration must never get
 * wrong (an opt-out is never turned back into a subscription, a re-run creates
 * nothing twice, rollback deletes only what the tool created, --on-conflict
 * means what it says) and the behaviour of the options a plan file records.
 */

const BUNDLE = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const SLOW = 120_000;

const STEVE = "e169aa45-1ecf-4183-9955-b1499d5701d3";
const ADA = "a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d";
const GRACE = "f0e1d2c3-b4a5-4968-8776-655443322110";
const NEWSLETTER = "c7e35c9f-b01c-4d4d-9f1d-46acce08492f";
const BETA = "5e0a0000-0000-4000-8000-000000000002";

let fake: FakeResend;
let api: ContractApi;
let cwd: string;

/** The fixture account plus a segment `Beta` holding only Grace, who is opted in to the opt_out-by-default Newsletter. */
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
      { id: NEWSLETTER, name: "Newsletter", description: null, subscription: "opt_in" },
    ];
  }
  return data;
}

async function boot(data = account()): Promise<void> {
  [fake, api] = await Promise.all([startFakeResend(data), startContractApi()]);
  cwd = mkdtempSync(join(tmpdir(), "billionsend-e2e-migration-"));
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
}

afterEach(async () => {
  await Promise.all([fake.close(), api.stop()]);
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        RESEND_API_KEY: fake.token,
        BILLIONSEND_CLI_RESEND_URL: fake.url,
        BILLIONSEND_API_KEY: api.apiKey,
        BILLIONSEND_BASE_URL: api.baseUrl,
        ...env,
      },
      stdio: "pipe",
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const migrate = (...extra: string[]): Promise<Run> =>
  cli(["migrate", "--from", "resend", "--yes", "--rps", "10", ...extra]);

const state = (): MigrateState =>
  JSON.parse(readFileSync(migratePaths(cwd).state, "utf8")) as MigrateState;
const report = (): Report =>
  JSON.parse(readFileSync(migratePaths(cwd).reportJson, "utf8")) as Report;

async function targetApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${api.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${api.apiKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`${path} → ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
const post = <T>(path: string, body: unknown): Promise<T> =>
  targetApi<T>(path, { method: "POST", body: JSON.stringify(body) });

/** A contact the owner already has on BillionSend (the batch endpoint is the only way to create one here). */
async function createContact(item: Record<string, unknown>): Promise<{ id: string }> {
  const { data } = await post<{ data: { id: string }[] }>("/contacts/batch", [item]);
  return { id: data[0]?.id ?? "" };
}

const contactOnTarget = (email: string) =>
  [...api.store.contacts.values()].find((c) => c.email === email);

const subscriptions = (email: string): Record<string, boolean> => {
  const contact = contactOnTarget(email);
  const subs = contact ? api.store.topicSubscriptions.get(contact.id) : undefined;
  const name = (id: string) => api.store.topics.get(id)?.name ?? id;
  return Object.fromEntries([...(subs ?? [])].map(([id, on]) => [name(id), on]));
};

/** What an owner already has on BillionSend before the first run: topics, and two contacts who opted out there. */
async function ownerOptedOut(): Promise<void> {
  const productUpdates = await post<{ id: string }>("/topics", {
    name: "Product updates",
    default_subscription: "opt_in",
  });
  await post("/topics", { name: "Newsletter", default_subscription: "opt_out" });
  // Steve is subscribed everywhere on Resend; on BillionSend he left the whole team and one topic.
  const steve = await createContact({ email: "steve.wozniak@gmail.com", unsubscribed: true });
  await targetApi(`/contacts/${steve.id}/topics`, {
    method: "PATCH",
    body: JSON.stringify([{ id: productUpdates.id, subscription: "opt_out" }]),
  });
  // Grace is not unsubscribed anywhere on Resend; on BillionSend she opted out of the Newsletter.
  const grace = await createContact({ email: "grace@example.net" });
  const newsletter = [...api.store.topics.values()].find((t) => t.name === "Newsletter");
  await targetApi(`/contacts/${grace.id}/topics`, {
    method: "PATCH",
    body: JSON.stringify([{ id: newsletter?.id, subscription: "opt_out" }]),
  });
}

describe("an opt-out on BillionSend is never turned back into a subscription", () => {
  beforeEach(() => boot());

  it(
    "a team-wide unsubscribe and topic opt-outs made on BillionSend survive a first full run and a re-run",
    async () => {
      await ownerOptedOut();
      for (const round of [1, 2]) {
        const { code } = await migrate();
        expect(code, `run ${round}`).toBe(0);
        expect(contactOnTarget("steve.wozniak@gmail.com")?.unsubscribed, `run ${round}`).toBe(true);
        expect(subscriptions("steve.wozniak@gmail.com"), `run ${round}`).toMatchObject({
          "Product updates": false,
        });
        expect(subscriptions("grace@example.net"), `run ${round}`).toEqual({ Newsletter: false });
      }
    },
    SLOW,
  );

  it(
    "an unsubscribed contact on Resend arrives unsubscribed, and a later run with the flag cleared on Resend does not clear it",
    async () => {
      expect((await migrate()).code).toBe(0);
      expect(contactOnTarget("ada@example.org")?.unsubscribed).toBe(true);
      const ada = fake.data.contacts.find((c) => c.id === ADA);
      if (ada) ada.unsubscribed = false;
      expect((await migrate()).code).toBe(0);
      expect(contactOnTarget("ada@example.org")?.unsubscribed).toBe(true);
    },
    SLOW,
  );
});

describe("suppressions", () => {
  beforeEach(() => boot());

  it(
    "bounces, complaints and manual entries arrive as they are, and a re-run adds none",
    async () => {
      expect((await migrate("--only", "suppressions")).code).toBe(0);
      const rows = () =>
        [...api.store.suppressions.values()].map((s) => [s.email, s.origin]).sort();
      const expected = [
        ["blocked@example.org", "manual"],
        ["bounced@example.org", "bounce"],
        ["complained@example.org", "complaint"],
      ];
      expect(rows()).toEqual(expected);
      const again = await migrate("--only", "suppressions");
      expect(again.code).toBe(0);
      expect(rows()).toEqual(expected);
      expect(report().counts.suppressions).toMatchObject({ created: 0, unchanged: 3, failed: 0 });
    },
    SLOW,
  );

  it(
    "a domain entry already on the target (it has no address) is neither counted nor touched",
    async () => {
      api.store.suppressions.set("domain-entry", {
        id: "domain-entry",
        email: null,
        domain: "blocked.example",
        origin: "manual",
        createdAt: "2024-01-01T00:00:00.000Z",
      });
      expect((await migrate("--only", "suppressions")).code).toBe(0);
      expect(report().counts.suppressions).toMatchObject({ created: 3, unchanged: 0, failed: 0 });
      expect(api.store.suppressions.size).toBe(4);
      expect(api.store.suppressions.get("domain-entry")?.domain).toBe("blocked.example");
      const again = await migrate("--only", "suppressions");
      expect(again.code).toBe(0);
      expect(report().counts.suppressions).toMatchObject({ created: 0, unchanged: 3, failed: 0 });
      expect(api.store.suppressions.size).toBe(4);
    },
    SLOW,
  );
});

describe("re-runs and rollback", () => {
  beforeEach(() => boot());

  it(
    "a second run creates nothing again, and rollback deletes what the first created and nothing that existed before",
    async () => {
      // Already on BillionSend before the tool ever ran: one contact, one topic.
      await createContact({ email: "ada@example.org", first_name: "Mine" });
      await post("/topics", { name: "Newsletter", default_subscription: "opt_out" });
      const before = {
        contactIds: new Set(api.store.contacts.keys()),
        topicIds: new Set(api.store.topics.keys()),
      };

      expect((await migrate("--skip", "domains,webhooks")).code).toBe(0);
      const created = state().created;
      expect(created.contacts).toHaveLength(2);
      expect(created.topics).toHaveLength(1);
      const sizes = [api.store.contacts.size, api.store.topics.size, api.store.segments.size];

      expect((await migrate("--skip", "domains,webhooks")).code).toBe(0);
      expect([api.store.contacts.size, api.store.topics.size, api.store.segments.size]).toEqual(
        sizes,
      );
      expect(state().created.contacts).toEqual(created.contacts);
      expect(report().counts.topics).toMatchObject({ created: 0 });

      const rolled = await cli(["migrate", "rollback", "--yes"]);
      expect(rolled.code).toBe(0);
      expect([...api.store.contacts.keys()].sort()).toEqual([...before.contactIds].sort());
      expect([...api.store.topics.keys()].sort()).toEqual([...before.topicIds].sort());
      expect(contactOnTarget("ada@example.org")?.firstName).toBe("Ada");
    },
    SLOW,
  );

  it(
    "--on-conflict skip leaves a contact that is already there untouched",
    async () => {
      await createContact({ email: "steve.wozniak@gmail.com", first_name: "Mine" });
      const { code } = await migrate("--only", "contacts", "--on-conflict", "skip");
      expect(code).toBe(0);
      expect(contactOnTarget("steve.wozniak@gmail.com")?.firstName).toBe("Mine");
      expect(report().counts.contacts).toMatchObject({ created: 2, skipped: 1, failed: 0 });
    },
    SLOW,
  );

  it(
    "--on-conflict error refuses a contact that is already there, creates the rest, and exits 3",
    async () => {
      await createContact({ email: "steve.wozniak@gmail.com", first_name: "Mine" });
      const { code, stdout } = await migrate("--only", "contacts", "--on-conflict", "error");
      expect(code).toBe(3);
      expect(contactOnTarget("steve.wozniak@gmail.com")?.firstName).toBe("Mine");
      expect(contactOnTarget("ada@example.org")).toBeDefined();
      expect(report().counts.contacts).toMatchObject({ created: 2, failed: 1 });
      expect(
        stdout.split("\n").filter((l) => l.includes("contacts/steve.wozniak@gmail.com")),
      ).toHaveLength(1);
    },
    SLOW,
  );
});

describe("--segment (built bundle)", () => {
  beforeEach(() => boot());

  it(
    "reads, creates and enriches only the chosen segment; GET /contacts is never called",
    async () => {
      const { code, stdout } = await migrate("--segment", "Beta");
      expect(code).toBe(0);
      expect([...api.store.contacts.values()].map((c) => c.email)).toEqual(["grace@example.net"]);
      expect([...api.store.segments.values()].map((s) => s.name)).toEqual(["Beta"]);
      expect(subscriptions("grace@example.net")).toEqual({ Newsletter: true });
      expect(fake.requests.map((r) => r.path)).not.toContain("/contacts");
      expect(stdout).toContain("Scope (--segment): only Beta and its members");
      expect(report().scope).toEqual({ segments: [{ id: BETA, name: "Beta" }] });
    },
    SLOW,
  );

  it(
    "an unknown segment is exit 1, lists the segments that exist, and writes nothing anywhere",
    async () => {
      const { code, stderr } = await cli([
        "migrate",
        "plan",
        "--from",
        "resend",
        "--segment",
        "Nope",
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("No Resend segment named or with the id `Nope`");
      expect(stderr).toContain("Active Users  (78261eea-8f8b-4381-83c6-79fa7120f1cf)");
      expect(stderr).toContain(`Beta  (${BETA})`);
      // Nothing but the connection hint and the segment list was read, and no contact list.
      expect(fake.requests.map((r) => r.path)).toEqual(["/domains", "/segments"]);
      expect(api.store.contacts.size).toBe(0);
      expect(api.store.segments.size).toBe(0);
    },
    SLOW,
  );
});

describe("a plan file records its options (built bundle)", () => {
  beforeEach(() => boot());

  it(
    "apply with no flags does what the file was planned for: the same segments, resources and conflict rule",
    async () => {
      const file = join(cwd, "plan.json");
      const planned = await cli([
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
        "--report",
        join(cwd, "plan.md"),
      ]);
      expect(planned.code).toBe(2);
      const saved = JSON.parse(readFileSync(file, "utf8")) as Plan;
      expect(saved.options).toEqual({
        only: ["segments", "contacts"],
        skip: [],
        segment: ["Beta"],
        onConflict: "skip",
        includeSent: false,
        freshWebhookSecrets: false,
      });
      expect(readFileSync(join(cwd, "plan.md"), "utf8")).toContain("Migration plan");

      const applied = await cli(["migrate", "apply", file, "--yes", "--rps", "10"]);
      expect(applied.stderr).toBe("");
      expect(applied.code).toBe(0);
      expect([...api.store.contacts.values()].map((c) => c.email)).toEqual(["grace@example.net"]);
      expect([...api.store.segments.values()].map((s) => s.name)).toEqual(["Beta"]);
      // Nothing outside --only was touched.
      expect(api.store.topics.size).toBe(0);
      expect(api.store.domains.size).toBe(0);
      expect(api.store.templates.size).toBe(0);
    },
    SLOW,
  );

  it(
    "apply refuses a flag that disagrees with the file, and says which",
    async () => {
      const file = join(cwd, "plan.json");
      await cli(["migrate", "plan", "--from", "resend", "--only", "contacts", "--out", file]);
      const { code, stderr } = await cli(["migrate", "apply", file, "--yes", "--only", "domains"]);
      expect(code).toBe(1);
      expect(stderr).toContain("--only: the command line has domains, the file has contacts");
      expect(api.store.contacts.size).toBe(0);
      expect(api.store.domains.size).toBe(0);
    },
    SLOW,
  );
});

describe("property keys that differ only in case (built bundle)", () => {
  async function bootWithPlanAndUpperPlan(): Promise<void> {
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
  }

  it(
    "the plan names the key it keeps; the run creates one property, writes plan's values and says how many PLAN values were not written",
    async () => {
      await bootWithPlanAndUpperPlan();
      const planned = await cli(["migrate", "plan", "--from", "resend", "--only", "properties"]);
      expect(planned.code).toBe(2);
      expect(planned.stdout).toContain("PLAN  differs from `plan` only in case");
      expect(api.store.contactProperties.size).toBe(0);

      const { code, stdout } = await migrate();
      expect(code).toBe(0);
      expect([...api.store.contactProperties.values()].map((p) => p.key).sort()).toEqual([
        "plan",
        "seats",
      ]);
      expect(contactOnTarget("steve.wozniak@gmail.com")?.properties).toMatchObject({ plan: "pro" });
      expect(contactOnTarget("ada@example.org")?.properties).toMatchObject({ plan: "pro" });
      expect(stdout).toMatch(/2\s+property values not written/);
      expect(report().enrichment?.droppedProperties).toEqual([
        { key: "PLAN", collidesWith: "plan", contacts: 2 },
      ]);
      expect(state().failures).toEqual([]);
    },
    SLOW,
  );
});

describe("a migration in two steps (built bundle)", () => {
  beforeEach(() => boot());

  it(
    "contacts first, enrichment later: a contact's opt-in to a topic that defaults to opt_out is written by the second run",
    async () => {
      expect((await migrate("--only", "segments,contacts")).code).toBe(0);
      expect(subscriptions("grace@example.net")).toEqual({});
      expect(state().progress.pendingEnrichment).toHaveLength(3);

      expect((await migrate()).code).toBe(0);
      expect(subscriptions("grace@example.net")).toEqual({ Newsletter: true });
      // The contacts of the first run were matched, not created again.
      expect(report().counts.contacts).toMatchObject({ created: 0, updated: 0, matched: 3 });
      expect(state().progress.pendingEnrichment).toBeUndefined();
    },
    SLOW,
  );

  it(
    "the opt-out a contact made on BillionSend between the two runs survives the second run",
    async () => {
      expect((await migrate("--only", "segments,contacts")).code).toBe(0);
      const topic = await post<{ id: string }>("/topics", {
        name: "Newsletter",
        default_subscription: "opt_out",
      });
      const grace = contactOnTarget("grace@example.net");
      await targetApi(`/contacts/${grace?.id}/topics`, {
        method: "PATCH",
        body: JSON.stringify([{ id: topic.id, subscription: "opt_out" }]),
      });
      expect((await migrate()).code).toBe(0);
      expect(subscriptions("grace@example.net")).toEqual({ Newsletter: false });
    },
    SLOW,
  );
});

describe("a failure list that keeps an address whole (built bundle)", () => {
  beforeEach(() => boot());

  it(
    "a refused contact appears once, on stdout, with its address complete on one line, and not on stderr",
    async () => {
      // Refused by the API: no @ at all, 100 characters with no space to wrap at; and an address with a space in it.
      const long = `${"a".repeat(90)}.example.com`;
      const spaced = "mary jane smith with a very long name@example.com";
      for (const [n, email] of [long, spaced].entries()) {
        fake.data.contacts.push({
          id: `00000000-0000-4000-8000-0000000000a${n}`,
          email,
          created_at: "2026-09-01 00:00:00.000+00",
          unsubscribed: false,
          properties: {},
          topics: [],
        });
      }
      const { code, stdout, stderr } = await migrate("--only", "contacts");
      expect(code).toBe(3);
      for (const email of [long, spaced]) {
        const lines = stdout.split("\n").filter((l) => l.includes(email));
        expect(lines, email).toHaveLength(1);
        expect(lines[0]?.trimStart().startsWith("✗"), email).toBe(true);
        expect(stderr).not.toContain(email);
      }
      expect(stderr).toBe("");
    },
    SLOW,
  );
});

describe("the return path of a migrated domain (built bundle)", () => {
  type Row = Record<string, unknown>;
  const NOTE = (target: string, source: string) =>
    `BillionSend return path is \`${target}\`; Resend's \`${source}\` stays as it is, so both can run in parallel`;

  /** The POST /domains bodies the target received, by domain name. */
  const createdBodies = (): Record<string, unknown>[] =>
    api.bodies
      .filter((b) => b.operation === "POST /domains")
      .map((b) => b.body as Record<string, unknown>);
  const returnPathOf = (name: string): string | undefined =>
    [...api.store.domains.values()].find((d) => d.name === name)?.customReturnPath;

  /** Plan to a file, apply that file; both write their Markdown report. */
  async function planAndApply(): Promise<{ plan: Plan; planMd: string; planOut: string }> {
    const file = join(cwd, "plan.json");
    const planned = await cli([
      "migrate",
      "plan",
      "--from",
      "resend",
      "--only",
      "domains",
      "--out",
      file,
      "--report",
      join(cwd, "plan.md"),
    ]);
    expect(planned.stderr).toBe("");
    expect(planned.code).toBe(2);
    const applied = await cli(["migrate", "apply", file, "--yes", "--rps", "10"]);
    expect(applied.stderr).toBe("");
    expect(applied.code).toBe(0);
    return {
      plan: JSON.parse(readFileSync(file, "utf8")) as Plan,
      planMd: readFileSync(join(cwd, "plan.md"), "utf8"),
      planOut: planned.stdout,
    };
  }

  const payload = (plan: Plan, name: string) =>
    plan.items.find((i) => i.resource === "domains" && i.action === "create" && i.key === name)
      ?.payload;

  it(
    "Resend on send or mail: BillionSend gets bounce, the plan and the report say Resend's label stays",
    async () => {
      // The fixture's example.com has its return path at send, news.example.com at mail.
      await boot();
      const { plan, planMd, planOut } = await planAndApply();

      expect(payload(plan, "example.com")).toMatchObject({
        create: { name: "example.com", custom_return_path: "bounce" },
        sourceReturnPath: "send",
      });
      expect(payload(plan, "news.example.com")).toMatchObject({
        create: { name: "news.example.com", custom_return_path: "bounce" },
        sourceReturnPath: "mail",
      });
      expect(planOut).toContain("BillionSend return path is `bounce`");
      expect(planMd).toContain(`- example.com — ${NOTE("bounce", "send")}`);
      expect(planMd).toContain(`- news.example.com — ${NOTE("bounce", "mail")}`);

      // The request bodies name the label; the target's own default is never relied on.
      const bodies = createdBodies();
      expect(bodies.map((b) => [b.name, b.custom_return_path])).toEqual([
        ["example.com", "bounce"],
        ["news.example.com", "bounce"],
      ]);
      expect(returnPathOf("example.com")).toBe("bounce");
      expect(returnPathOf("news.example.com")).toBe("bounce");

      // The report's DNS table is the new host; Resend's send.example.com is nowhere in it.
      const md = readFileSync(migratePaths(cwd).reportMd, "utf8");
      expect(md).toContain("### DNS records for example.com");
      expect(md).toContain(`${NOTE("bounce", "send")}.`);
      expect(md).toContain(`${NOTE("bounce", "mail")}.`);
      expect(md).toContain("| MX | bounce.example.com |");
      expect(md).toContain("| TXT | bounce.example.com |");
      expect(md).toContain("| MX | bounce.news.example.com |");
      expect(md).not.toMatch(/\| (MX|TXT) \| send\.example\.com \|/);
      const dns = report().dns;
      expect(dns.map((d) => [d.domain, d.note])).toEqual([
        ["example.com", NOTE("bounce", "send")],
        ["news.example.com", NOTE("bounce", "mail")],
      ]);
    },
    SLOW,
  );

  it(
    "Resend already on bounce: BillionSend gets the fixed fallback bounces, never the same label",
    async () => {
      const data = account();
      for (const row of data.domains as Row[]) {
        if (row.name !== "news.example.com") continue;
        row.records = (row.records as Row[]).map((r) =>
          r.record === "SPF" ? { ...r, name: "bounce.news" } : r,
        );
      }
      await boot(data);
      const { plan, planMd } = await planAndApply();

      expect(payload(plan, "news.example.com")).toMatchObject({
        create: { name: "news.example.com", custom_return_path: "bounces" },
        sourceReturnPath: "bounce",
      });
      // The other domain is still on send, so it takes bounce.
      expect(payload(plan, "example.com")).toMatchObject({
        create: { custom_return_path: "bounce" },
        sourceReturnPath: "send",
      });
      expect(planMd).toContain(`- news.example.com — ${NOTE("bounces", "bounce")}`);

      expect(createdBodies().map((b) => [b.name, b.custom_return_path])).toEqual([
        ["example.com", "bounce"],
        ["news.example.com", "bounces"],
      ]);
      expect(returnPathOf("news.example.com")).toBe("bounces");

      const md = readFileSync(migratePaths(cwd).reportMd, "utf8");
      expect(md).toContain(`${NOTE("bounces", "bounce")}.`);
      expect(md).toContain("| MX | bounces.news.example.com |");
      expect(md).not.toContain("| MX | bounce.news.example.com |");
    },
    SLOW,
  );

  it(
    "a domain already on BillionSend is left as it is: no create, no return-path note",
    async () => {
      await boot();
      await post("/domains", { name: "example.com", custom_return_path: "mail" });
      const { plan, planMd } = await planAndApply();
      expect(plan.items.find((i) => i.key === "example.com")).toMatchObject({
        action: "unchanged",
      });
      expect(createdBodies().map((b) => b.name)).toEqual(["example.com", "news.example.com"]);
      expect(returnPathOf("example.com")).toBe("mail");
      expect(planMd).not.toContain("- example.com — BillionSend return path");
      expect(planMd).toContain("- news.example.com — BillionSend return path");
    },
    SLOW,
  );
});
