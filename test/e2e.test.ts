import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MigrateState, Plan } from "../src/model.js";
import { migratePaths } from "../src/paths.js";
import type { Report } from "../src/report.js";
import { type ContractApi, startContractApi } from "./helpers/contract-api.js";
import { type FakeResend, startFakeResend } from "./helpers/fake-resend.js";
import {
  API_KEY_NAMES,
  CONTACT_COUNT,
  contactEmail,
  contactSeed,
  EMAILS_SENT_30D,
  enrichable,
  fakeId,
  realisticAccount,
  SEGMENTS,
  SUPPRESSIONS,
  TOPICS,
  WEBHOOK_ENDPOINTS,
  WEBHOOK_SECRETS,
} from "./helpers/realistic-account.js";

/*
 * The built bundle as a real subprocess against a fake Resend and the real
 * API on PGlite. Enrichment (two GETs per contact) and rollback (one DELETE
 * per contact) are rate limited by design, so the two long tests run for
 * minutes; the budget below covers them at --rps 10.
 */

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = join(PACKAGE_DIR, "dist", "index.js");
const VERSION = (
  JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string }
).version;
const QUICK = 60_000;
const READ = 120_000;
const ENRICH = 600_000;
const ROLLBACK = 400_000;

let fake: FakeResend;
let cloud: ContractApi;
let cwd: string;
/** Every stdout/stderr of every run, for the no-ANSI and no-secrets sweeps. */
const transcripts: string[] = [];

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RESEND_API_KEY: fake.token,
    BILLIONSEND_CLI_RESEND_URL: fake.url,
    BILLIONSEND_API_KEY: cloud.apiKey,
    BILLIONSEND_BASE_URL: cloud.baseUrl,
  };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      cwd: options.cwd ?? cwd,
      env,
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
    child.on("close", (code) => {
      transcripts.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
  });
}

const readState = (dir = cwd): MigrateState =>
  JSON.parse(readFileSync(migratePaths(dir).state, "utf8")) as MigrateState;
const readReport = (dir = cwd): Report =>
  JSON.parse(readFileSync(migratePaths(dir).reportJson, "utf8")) as Report;
const stateFiles = (dir = cwd): string[] =>
  readdirSync(migratePaths(dir).dir).map((name) =>
    readFileSync(join(migratePaths(dir).dir, name), "utf8"),
  );

async function api<T>(target: ContractApi, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${target.apiKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`${path} → ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
const list = async <T>(target: ContractApi, path: string): Promise<T[]> =>
  // GET /topics takes no paging parameters.
  (await api<{ data: T[] }>(target, path === "/topics" ? path : `${path}?limit=100`)).data;
const post = <T>(target: ContractApi, path: string, body: unknown): Promise<T> =>
  api<T>(target, path, { method: "POST", body: JSON.stringify(body) });

const rowCount = (target: ContractApi, table: Parameters<ContractApi["count"]>[0]): number =>
  target.count(table);

const SECRETS = (): string[] => [fake.token, cloud.apiKey, ...WEBHOOK_SECRETS];

function expectNoSecrets(...texts: string[]): void {
  for (const text of texts) {
    for (const secret of SECRETS()) expect(text).not.toContain(secret);
  }
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

beforeAll(async () => {
  [fake, cloud] = await Promise.all([
    startFakeResend(realisticAccount()),
    startContractApi({ slug: "cloud" }),
  ]);
  cwd = mkdtempSync(join(tmpdir(), "billionsend-e2e-"));
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  // What the team already has on BillionSend: a verified sender (so drafts
  // from it can be imported), an unrelated domain (left alone), and a topic
  // whose description differs (an update).
  const verified = await post<{ id: string }>(cloud, "/domains", {
    name: "example.com",
    region: "us-east-1",
  });
  const sender = cloud.store.domains.get(verified.id);
  if (sender) sender.status = "verified";
  await post(cloud, "/domains", { name: "legacy.example.net", region: "us-east-1" });
  await post(cloud, "/topics", {
    name: "Newsletter",
    description: "Old description",
    default_subscription: "opt_out",
  });
});
afterAll(async () => {
  await Promise.all([fake.close(), cloud.stop()]);
});

describe("billionsend (built bundle)", () => {
  it(
    "--help and --version",
    async () => {
      const help = await run(["--help"], { env: { NO_COLOR: "1" } });
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("billionsend migrate --from resend");
      expect(help.stdout).toContain("migrate rollback [--yes]");
      expect(help.stdout).toContain("DO_NOT_TRACK");
      expect(help.stdout).toContain("Resend is a trademark of Plus Five Five, Inc.");
      const version = await run(["--version"]);
      expect(version.code).toBe(0);
      expect(version.stdout).toBe(`${VERSION}\n`);
    },
    QUICK,
  );

  it(
    "migrate plan --json: a JSON plan on stdout, progress on stderr, exit 2",
    async () => {
      const { code, stdout, stderr } = await run(["migrate", "plan", "--from", "resend", "--json"]);
      expect(code).toBe(2);
      const plan = JSON.parse(stdout) as Plan;
      expect(plan.version).toBe(2);
      expect(plan.target).toEqual({ baseUrl: cloud.baseUrl, plan: "pro" });
      expect(plan.counts).toEqual({ create: 23, update: 2, unchanged: 1, manual: 9, skip: 3 });
      expect(stderr).toMatch(new RegExp(`✓ Contacts\\s+${CONTACT_COUNT.toLocaleString("en-US")}`));
      expect(stderr).toMatch(/✓ BillionSend\s+current state read/);

      const item = (resource: string, key: string) =>
        plan.items.find((i) => i.resource === resource && i.key === key);
      expect(item("contacts", "contacts")).toMatchObject({
        action: "create",
        count: CONTACT_COUNT,
      });
      expect(item("enrichment", "contacts")).toMatchObject({
        action: "update",
        count: CONTACT_COUNT,
      });
      expect(item("topics", "Newsletter")).toMatchObject({
        action: "update",
        detail: "description",
      });
      expect(item("domains", "example.com")?.action).toBe("unchanged");
      expect(item("domains", "news.example.com")).toMatchObject({
        action: "create",
        payload: {
          create: { name: "news.example.com", custom_return_path: "mail" },
        },
      });
      expect(item("segments", "Active Users")).toMatchObject({
        payload: {
          filter: {
            match: "all",
            conditions: [{ field: "property:plan", op: "equals", value: "pro" }],
          },
        },
      });
      expect(item("broadcasts", "Launch day")?.action).toBe("skip");
      expect(item("webhooks", WEBHOOK_ENDPOINTS[1])).toMatchObject({
        payload: {
          events: [
            "email.opened",
            "email.clicked",
            "email.received",
            "contact.created",
            "contact.updated",
          ],
          signingSecret: "copy",
        },
      });

      const manual = plan.manual.map((m) => `${m.title} — ${m.detail}`);
      for (const name of API_KEY_NAMES)
        expect(manual).toContain(`api-keys/${name} — create by hand; Resend exposes only the name`);
      expect(manual).toContain("domains/news.example.com — add DNS records (shown after apply)");
      expect(manual).toContain("domains/updates.example.com — add DNS records (shown after apply)");
      expect(manual.filter((m) => m.startsWith(`webhooks/${WEBHOOK_ENDPOINTS[1]}`))).toEqual([]);
      expect(manual).toContain(
        "broadcasts/Spring sale — merge tags left as-is: {{{contact.address.city|your city}}}",
      );
      expect(manual).toContain(
        "templates/welcome — variables flags (object) not stored: BillionSend variables are strings or numbers",
      );
      // from, reply_to and the string and number variables are carried over, not listed.
      expect(manual.filter((m) => m.startsWith("templates/Receipt"))).toEqual([]);
      expect(plan.warnings).toEqual([]);
      expect(stderr).not.toContain("domains will be created; the rest are listed as manual.");
      expect(plan.estimate.requests).toBeGreaterThan(2 * CONTACT_COUNT);
      expect(stdout).not.toContain("whsec_");
      expect(fake.writes).toBe(0);
      for (const request of fake.requests) {
        expect(request.method).toBe("GET");
        expect(request.userAgent).toMatch(new RegExp(`^billionsend-cli/${VERSION} \\(\\+https://`));
      }
      expect(fake.requests.some((r) => r.path.startsWith("/audiences"))).toBe(false);
    },
    READ,
  );

  it(
    "a 429 with retry-after and a 503 are retried; --verbose shows every request",
    async () => {
      fake.injectOnce("/topics", {
        status: 429,
        headers: { "retry-after": "0" },
        body: { name: "rate_limit_exceeded", message: "Too many requests" },
      });
      fake.injectOnce("/templates", {
        status: 503,
        body: { name: "internal_server_error", message: "try again" },
      });
      const { code, stderr } = await run([
        "migrate",
        "plan",
        "--from",
        "resend",
        "--verbose",
        "--only",
        "topics,templates",
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain("warning: retry 2/8 in 0s — Resend 429");
      expect(stderr).toContain("warning: retry 2/5 in 1s — Resend 503");
      expect(stderr).toMatch(/GET \/topics\?limit=100 → 429 \(\d+ ms\)/);
      expect(stderr).toMatch(/GET \/topics\?limit=100 → 200 \(\d+ ms\)/);
      expect(stderr).toMatch(/GET \/templates\?limit=100 → 503 \(\d+ ms\)/);
      expect(stderr).toMatch(/GET \/usage → 200 \(\d+ ms\)/);
      expectNoSecrets(stderr);
    },
    READ,
  );

  it(
    "a 401 from Resend mid-enrichment is exit 1 with the state saved",
    async () => {
      fake.injectOnce(`/contacts/${fakeId(5, 5)}`, {
        status: 401,
        body: { name: "invalid_api_key", message: "API key is invalid" },
      });
      const { code, stdout, stderr } = await run([
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--rps",
        "10",
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("Resend rejected the API key (401)");
      expect(stdout).toContain("Added .billionsend/ to .gitignore.");
      const n = CONTACT_COUNT.toLocaleString("en-US");
      expect(stdout).toMatch(new RegExp(`✓ Contacts\\s+${n}/${n}`));
      const state = readState();
      expect(
        Object.fromEntries(Object.entries(state.created).map(([k, v]) => [k, v.length])),
      ).toEqual({
        properties: 3,
        topics: 4,
        segments: 3,
        domains: 2,
        webhooks: 2,
        templates: 4,
        contacts: CONTACT_COUNT,
        broadcasts: 3,
        suppressions: 40,
      });
      expect(state.progress.contactsCursor).toBeNull();
      expect(state.progress.topicsDone ?? []).toEqual([]);
      expect(state.progress.enrichmentDone ?? []).toEqual([]);
      expect(existsSync(migratePaths(cwd).reportJson)).toBe(false);
      expect(rowCount(cloud, "contacts")).toBe(CONTACT_COUNT);
      // Enrichment runs last, so the first run already carried the broadcasts across.
      expect(rowCount(cloud, "broadcasts")).toBe(3);
    },
    READ,
  );

  it(
    "the resumed run completes: every row on the target, the summary, no key anywhere",
    async () => {
      const { code, stdout, stderr } = await run([
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--rps",
        "10",
      ]);
      expect(stderr).toBe("");
      // Nothing is refused on a paid plan: exit 0, not 3.
      expect(code).toBe(0);
      expect(fake.writes).toBe(0);

      expect(stdout).toContain(
        `billionsend ${VERSION} — Moves your Resend account into BillionSend.`,
      );
      expect(stdout).toContain("✓ Resend · connected");
      expect(stdout).toContain(`✓ BillionSend (${cloud.baseUrl}) · plan Pro`);
      expect(stdout).toContain("Resend was only read; nothing there was changed.");
      expect(stdout).toContain(
        `${CONTACT_COUNT.toLocaleString("en-US")}  contacts matched existing`,
      );
      expect(stdout).toContain(`${enrichable().toLocaleString("en-US")}  contacts enriched`);
      expect(stdout).toContain("3  broadcasts unchanged");
      expect(stdout).toContain("40  suppressions unchanged");
      expect(stdout).toContain("steps done — left:");
      expect(stdout).toContain("[ ] add DNS records for news.example.com");
      expect(stdout).toContain("[ ] add DNS records for updates.example.com");
      expect(stdout).toContain(
        [
          "  [ ] set RESEND_BASE_URL=https://api.billionsend.com in your app, so Resend SDK",
          `      calls go to BillionSend (this run used ${cloud.baseUrl}; put that`,
          "      address there only if your app reaches BillionSend through it)",
          "",
        ].join("\n"),
      );
      expect(stdout).toContain(`[ ] create API keys: ${API_KEY_NAMES.join(", ")}`);
      expect(stdout).toContain(
        "[ ] replace Resend topic and segment ids in your code (id map below)",
      );
      expect(stdout).toContain("Id map (Resend → BillionSend; full pairs in migrate-report.md):");
      expect(stdout).toMatch(
        new RegExp(`topics/${TOPICS[0].name}\\n    [0-9a-f]{8}… → [0-9a-f-]{36}`),
      );
      expect(stdout).toContain("DNS records for news.example.com:");
      expect(stdout).toMatch(/\n {2}TXT {2}\S+\n {4}\S/);
      // Prose wraps at the layout width (80 on a pipe).
      expect(stdout.replace(/\n/g, " ")).toContain(
        "Run `billionsend migrate --from resend` again right before cutover to sync new contacts.",
      );
      expect(stdout.replace(/\n/g, " ")).toContain(
        `On Resend you sent ${EMAILS_SENT_30D.toLocaleString("en-US")} emails in the last 30 days (~1,374/day). Pro 60K allows 60,000/month; that covers it.`,
      );
      expect(stdout).not.toContain("Webhook signing secrets");

      const paths = migratePaths(cwd);
      for (const path of [paths.state, paths.reportJson, paths.reportMd]) {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      expectNoSecrets(stdout, stderr, ...stateFiles());
      expect(stateFiles().join("\n")).not.toContain("whsec_");

      const state = readState();
      expect(
        Object.fromEntries(Object.entries(state.created).map(([k, v]) => [k, v.length])),
      ).toEqual({
        properties: 3,
        topics: 4,
        segments: 3,
        domains: 2,
        webhooks: 2,
        templates: 4,
        contacts: CONTACT_COUNT,
        broadcasts: 3,
        suppressions: 40,
      });
      expect(state.progress.enrichmentDone).toBeUndefined();
      expect(state.progress.enrichmentCompleted).toBe(true);
      expect(state.failures).toEqual([]);
      const report = readReport();
      expect(report.counts.contacts).toMatchObject({
        created: 0,
        updated: 0,
        matched: CONTACT_COUNT,
        failed: 0,
      });
      expect(report.counts.enrichment).toMatchObject({ updated: enrichable(), failed: 0 });
      expect(report.counts.domains).toMatchObject({ created: 0, unchanged: 3, manual: 2 });
      // Broadcasts and suppressions went across before the 401; this run finds them in place.
      expect(report.counts.broadcasts).toMatchObject({ created: 0, unchanged: 3, skipped: 3 });
      expect(report.counts.suppressions).toMatchObject({ created: 0, unchanged: 40 });
      expect(report.dns.map((d) => d.domain)).toEqual(["news.example.com", "updates.example.com"]);
      expect(report.apiKeys).toEqual([...API_KEY_NAMES]);
      expect(report.offer).toMatchObject({
        emailsLast30Days: EMAILS_SENT_30D,
        perDay: 1374,
        plan: "pro",
        fits: "pro",
      });
      expect(readFileSync(paths.reportMd, "utf8")).toContain(
        "### DNS records for news.example.com",
      );

      // Contacts: every row, the unsubscribed flag, properties and topic overrides.
      expect(rowCount(cloud, "contacts")).toBe(CONTACT_COUNT);
      const contactRows = [...cloud.store.contacts.values()];
      expect(contactRows.filter((c) => c.unsubscribed)).toHaveLength(CONTACT_COUNT / 10);
      const contactByEmail = async (email: string) => contactRows.find((c) => c.email === email);
      const first = await contactByEmail(contactEmail(0));
      const detail = await api<{
        properties: Record<string, unknown>;
        unsubscribed: boolean;
        first_name: string | null;
      }>(cloud, `/contacts/${first?.id}`);
      expect(detail.first_name).toBeNull();
      expect(detail.properties).toEqual({
        plan: { type: "string", value: "pro" },
        seats: { type: "number", value: 1 },
        company: { type: "string", value: "Company 0" },
      });
      const topics = await list<{ id: string; name: string }>(cloud, "/topics");
      const topicId = (name: string) => topics.find((t) => t.name === name)?.id ?? "";
      const subscriptions = [
        ...(cloud.store.topicSubscriptions.get(first?.id ?? "") ?? new Map<string, boolean>()),
      ].map(([topicId, subscribed]) => ({ topicId, subscribed }));
      expect(subscriptions.sort((a, b) => a.topicId.localeCompare(b.topicId))).toEqual(
        [
          { topicId: topicId(TOPICS[0].name), subscribed: true },
          { topicId: topicId(TOPICS[1].name), subscribed: false },
        ].sort((a, b) => a.topicId.localeCompare(b.topicId)),
      );
      const expectedSubscriptions = Array.from({ length: CONTACT_COUNT }, (_, i) =>
        contactSeed(i),
      ).reduce((n, c) => n + (c.topics?.length ?? 0), 0);
      expect(rowCount(cloud, "topicSubscriptions")).toBe(expectedSubscriptions);
      const ninth = await contactByEmail(contactEmail(9));
      expect(ninth?.unsubscribed).toBe(true);

      // Segments: the translated filter and the explicit memberships (overlap included).
      const segments = await list<{ id: string; name: string; filter: unknown }>(
        cloud,
        "/segments",
      );
      expect(segments.map((s) => s.name).sort()).toEqual(SEGMENTS.map((s) => s.name).sort());
      expect(segments.find((s) => s.name === "Active Users")?.filter).toEqual({
        match: "all",
        conditions: [{ field: "property:plan", op: "equals", value: "pro" }],
      });
      for (const seed of SEGMENTS) {
        const id = segments.find((s) => s.name === seed.name)?.id ?? "";
        const members = [...cloud.store.segmentMembers].filter((m) => m.startsWith(`${id}:`));
        expect(members.length, seed.name).toBe(seed.members[1] - seed.members[0]);
      }
      const overlapping = await contactByEmail(contactEmail(250));
      const overlap = [...cloud.store.segmentMembers].filter((m) =>
        m.endsWith(`:${overlapping?.id ?? ""}`),
      );
      expect(overlap).toHaveLength(2);

      // Webhooks keep Resend's signing secret and every event BillionSend emits.
      for (const id of state.created.webhooks ?? []) {
        const hook = await api<{ endpoint: string; events: string[]; signing_secret: string }>(
          cloud,
          `/webhooks/${id}`,
        );
        const n = WEBHOOK_ENDPOINTS.indexOf(hook.endpoint as (typeof WEBHOOK_ENDPOINTS)[number]);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(hook.signing_secret).toBe(WEBHOOK_SECRETS[n]);
        if (n === 1) {
          expect(hook.events).toEqual([
            "email.opened",
            "email.clicked",
            "email.received",
            "contact.created",
            "contact.updated",
          ]);
        }
      }

      // Suppressions carry their origin.
      const suppressions = await list<{ origin: string }>(cloud, "/suppressions");
      const byOrigin: Record<string, number> = {};
      for (const s of suppressions) byOrigin[s.origin] = (byOrigin[s.origin] ?? 0) + 1;
      expect(byOrigin).toEqual(SUPPRESSIONS);

      // Broadcasts: drafts and the scheduled one as drafts with translated tags; sent ones absent.
      const broadcasts = await list<{ id: string; name: string; status: string }>(
        cloud,
        "/broadcasts",
      );
      expect(broadcasts.map((b) => [b.name, b.status]).sort()).toEqual([
        ["Feature drop", "draft"],
        ["Spring sale", "draft"],
        ["Welcome series #1", "draft"],
      ]);
      const welcome = await api<{
        html: string;
        text: string;
        subject: string;
        segment_id: string | null;
        topic_id: string | null;
      }>(cloud, `/broadcasts/${broadcasts.find((b) => b.name === "Welcome series #1")?.id}`);
      expect(welcome.html).toContain("{{{FIRST_NAME|there}}}");
      expect(welcome.html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
      expect(welcome.html).not.toContain("contact.first_name");
      expect(welcome.subject).toBe("Hello {{{FIRST_NAME|there}}}");
      expect(welcome.segment_id).toBe(segments.find((s) => s.name === "Active Users")?.id);
      expect(welcome.topic_id).toBe(topicId(TOPICS[0].name));

      const templates = await list<{ name: string; alias: string | null }>(cloud, "/templates");
      expect(templates.map((t) => [t.name, t.alias]).sort()).toEqual([
        ["Digest", null],
        ["Password reset", "password-reset"],
        ["Receipt", null],
        ["Welcome", "welcome"],
      ]);
      const domains = await list<{ name: string }>(cloud, "/domains");
      expect(domains.map((d) => d.name).sort()).toEqual([
        "example.com",
        "legacy.example.net",
        "news.example.com",
        "updates.example.com",
      ]);
      const newsletter = topics.find((t) => t.name === "Newsletter") as
        | { description?: string }
        | undefined;
      expect(newsletter?.description).toBe("Monthly digest");
    },
    ENRICH,
  );

  it(
    "status reads the state file without credentials",
    async () => {
      const { code, stdout } = await run(["migrate", "status"], {
        env: {
          RESEND_API_KEY: undefined,
          BILLIONSEND_API_KEY: undefined,
          BILLIONSEND_BASE_URL: undefined,
        },
      });
      expect(code).toBe(0);
      expect(stdout).toContain(cloud.baseUrl);
      expect(stdout).toMatch(new RegExp(`Contacts\\s+${CONTACT_COUNT.toLocaleString("en-US")}`));
      expect(stdout).toMatch(/Enriched\s+complete/);
    },
    QUICK,
  );

  it(
    "a re-run changes nothing and creates no row",
    async () => {
      const before = readState();
      const rows = async () => ({
        contacts: rowCount(cloud, "contacts"),
        members: rowCount(cloud, "segmentMembers"),
        subscriptions: rowCount(cloud, "topicSubscriptions"),
        suppressions: rowCount(cloud, "suppressions"),
        broadcasts: rowCount(cloud, "broadcasts"),
      });
      const rowsBefore = await rows();
      const { code, stdout, stderr } = await run([
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--rps",
        "10",
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain(`webhooks\n  = ${WEBHOOK_ENDPOINTS[0]}`);
      // Three unchanged drafts with one detail fold into a single row.
      expect(stdout).toContain(
        "  = 3 broadcasts  matched by name; the draft's body is not compared\n    Welcome series #1, Feature drop … and 1 more\n",
      );
      expect(readState().created).toEqual(before.created);
      expect(await rows()).toEqual(rowsBefore);
      const report = readReport();
      expect(report.counts.topics).toMatchObject({
        created: 0,
        updated: 0,
        unchanged: TOPICS.length,
      });
      expect(report.counts.segments).toMatchObject({
        created: 0,
        updated: 0,
        unchanged: SEGMENTS.length,
      });
      expect(report.counts.webhooks).toMatchObject({ created: 0, unchanged: 2 });
      expect(report.counts.templates).toMatchObject({ created: 0, unchanged: 4 });
      expect(report.counts.contacts).toMatchObject({
        created: 0,
        updated: 0,
        matched: CONTACT_COUNT,
      });
      // A sync re-run refreshes properties and opt-outs for every existing contact.
      expect(report.counts.enrichment).toMatchObject({ updated: enrichable(), failed: 0 });
      expect(report.counts.broadcasts).toMatchObject({ created: 0, unchanged: 3, skipped: 3 });
      expect(report.counts.suppressions).toMatchObject({ created: 0, unchanged: 40 });
    },
    ENRICH,
  );

  it(
    "--to-url names the API; fresh webhook secrets are shown once",
    async () => {
      const self = await startContractApi({ slug: "fresh-secrets" });
      const dir = mkdtempSync(join(tmpdir(), "billionsend-e2e-self-"));
      try {
        const { code, stdout, stderr } = await run(
          [
            "migrate",
            "--from",
            "resend",
            "--yes",
            "--only",
            "webhooks",
            "--fresh-webhook-secrets",
            "--to-url",
            `${self.baseUrl}/`,
          ],
          { cwd: dir, env: { BILLIONSEND_API_KEY: self.apiKey, BILLIONSEND_BASE_URL: undefined } },
        );
        expect(stderr).toBe("");
        expect(code).toBe(0);
        expect(stdout).toContain(`✓ BillionSend (${self.baseUrl}) · plan Pro`);
        expect(stdout).toContain(
          "Webhook signing secrets, shown once (they are not saved anywhere):",
        );
        const printed = stdout.match(/whsec_[A-Za-z0-9+/=]+/g) ?? [];
        expect(printed).toHaveLength(2);
        for (const secret of printed) {
          expect(occurrences(stdout, secret)).toBe(1);
          expect(WEBHOOK_SECRETS).not.toContain(secret);
        }
        expect(readState(dir).target.baseUrl).toBe(self.baseUrl);
        const hooks = await list<{ id: string; endpoint: string }>(self, "/webhooks");
        expect(hooks).toHaveLength(2);
        for (const { id, endpoint } of hooks) {
          const hook = await api<{ signing_secret: string }>(self, `/webhooks/${id}`);
          expect(stdout).toContain(`${endpoint}  ${hook.signing_secret}`);
        }
        expect(stateFiles(dir).join("\n")).not.toContain("whsec_");
        expect(readReport(dir).freshWebhookSecrets).toEqual([]);
        expectNoSecrets(stdout, stderr, ...stateFiles(dir));
      } finally {
        await self.stop();
      }
    },
    READ,
  );

  it(
    "rollback deletes only what the tool created; pre-existing and updated rows stay",
    async () => {
      const { code, stdout, stderr } = await run(["migrate", "rollback", "--yes"]);
      expect(stderr.replace(/^warning: retry .*\n?/gm, "")).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain(
        `${CONTACT_COUNT.toLocaleString("en-US")}  Contacts (one request each)`,
      );
      expect(stdout).toMatch(/^About 2 min at 10 req\/s\.$/m);
      expect(stdout).toContain("Rolled back. Rows this tool only updated were left as they are.");
      expect(Object.values(readState().created).every((ids) => ids.length === 0)).toBe(true);
      for (const table of [
        "contacts",
        "segments",
        "segmentMembers",
        "contactProperties",
        "topicSubscriptions",
        "webhooks",
        "templates",
        "broadcasts",
      ]) {
        expect(rowCount(cloud, table as Parameters<ContractApi["count"]>[0]), table).toBe(0);
      }
      // Bounce and complaint suppressions are permanent: the API keeps them and rollback says so.
      const permanent = fake.data.suppressions.filter(
        (row) => row.origin === "bounce" || row.origin === "complaint",
      ).length;
      expect(rowCount(cloud, "suppressions")).toBe(permanent);
      expect(stdout).toContain(
        `${permanent} suppressions stay: a bounce or complaint entry is permanent`,
      );
      const topics = await list<{ name: string; description?: string }>(cloud, "/topics");
      expect(topics.map((t) => [t.name, t.description])).toEqual([
        ["Newsletter", "Monthly digest"],
      ]);
      const domains = await list<{ name: string }>(cloud, "/domains");
      expect(domains.map((d) => d.name).sort()).toEqual(["example.com", "legacy.example.net"]);
      const again = await run(["migrate", "rollback", "--yes"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("Nothing to roll back");
    },
    ROLLBACK,
  );

  it("piped output never carries ANSI escapes, and never a key", () => {
    expect(transcripts.length).toBeGreaterThan(10);
    for (const text of transcripts) expect(text).not.toContain("\x1b");
    expectNoSecrets(...transcripts.filter((t) => !t.includes("Webhook signing secrets")));
  });
});
