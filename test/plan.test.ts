import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RESOURCES,
  type Resource,
  type Snapshot,
  type TargetContact,
  type TargetState,
} from "../src/model.js";
import {
  buildPlan,
  describePlanDiff,
  groupPlanItems,
  type PlanOptions,
  parsePlan,
  planHash,
  renderPlan,
  serializePlan,
} from "../src/plan.js";
import { setColorMode } from "../src/theme.js";
import { TARGET_WEBHOOK_EVENTS } from "../src/translate.js";
import { visibleLength } from "../src/tty-ui.js";

const snapshot: Snapshot = JSON.parse(
  readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8"),
);

const emptyTarget: TargetState = {
  contacts: new Map(),
  usage: {
    plan: null,
    limits: { emailsPerDay: null, emailsPerMonth: null, domains: null, contacts: null },
    overageEnabled: false,
  },
  domains: [],
  properties: [],
  topics: [],
  segments: [],
  webhooks: [],
  templates: [],
  broadcasts: [],
};

/** Every resource matched at least once, some differing, one verified domain, a tight domain limit. */
const goldenTarget: TargetState = {
  contacts: new Map(),
  usage: {
    plan: "free",
    limits: { emailsPerDay: 100, emailsPerMonth: null, domains: 1, contacts: 1000 },
    overageEnabled: false,
  },
  domains: [
    { id: "d1", name: "example.com", region: "us-east-1", status: "verified", records: [] },
  ],
  properties: [{ id: "p1", key: "company", type: "string" }],
  topics: [
    {
      id: "t1",
      name: "Product updates",
      description: "Old description",
      defaultSubscription: "opt_in",
    },
  ],
  segments: [{ id: "s1", name: "Active Users", filter: null }],
  webhooks: [
    {
      id: "w1",
      endpoint: "https://webhook.example.com/handler",
      events: ["email.sent"],
      status: "enabled",
    },
  ],
  templates: [
    {
      id: "tp1",
      name: "Welcome (old)",
      alias: "welcome",
      subject: "Welcome, {{{FIRST_NAME|friend}}}",
      html: "<h1>Welcome {{{FIRST_NAME}}}</h1><p>{{{UNSUBSCRIBE_URL}}}</p>",
      text: null,
    },
  ],
  broadcasts: [],
};

const options = (overrides: Partial<PlanOptions> = {}): PlanOptions => ({
  include: new Set<Resource>(RESOURCES),
  only: null,
  skip: [],
  segment: [],
  onConflict: "upsert",
  includeSent: false,
  freshWebhookSecrets: false,
  rps: 8,
  sourceRequestsSpent: 40,
  baseUrl: "https://api.billionsend.com",
  now: new Date("2026-09-01T12:00:00Z"),
  ...overrides,
});

/** Wrapped at 80 columns, colors off. */
const GOLDEN = `+ create   ~ update   = unchanged   ! manual   − skip

properties
  = company
  + seats  number
topics
  ~ Product updates  description
  + Beta program  opt_out
segments
  ~ Active Users  filter
  + Enterprise  1 member
  ! Enterprise  filter not translated (unsupported field "plan_tier"); 1 member
    still imported
  + Imported  0 members
domains
  = example.com
  + updates.example.com
  ! updates.example.com  add DNS records (shown after apply)
  + mail.example.org
  ! mail.example.org  add DNS records (shown after apply)
webhooks
  ~ https://webhook.example.com/handler  events
  ! https://webhook.example.com/handler  events not delivered here:
    template.created
  + https://hooks.example.com/contacts  2 events, fresh secret
templates
  ~ welcome  name, from, reply_to, variables
  + Receipt
contacts (5)
  + contacts  batch upsert, 3 segment memberships
broadcasts
  + November announcements  draft
  ! Beta invite  from domain updates.example.com is not verified here — re-run
    apply after DNS verification
  − Launch recap  already sent; --include-sent imports sent broadcasts as drafts
suppressions (3)
  + suppressions  batch add with origin
enrichment (5)
  ~ contacts  topic subscriptions, then properties, read per contact
api-keys
  ! Production  create by hand; Resend exposes only the name
  ! Staging  create by hand; Resend exposes only the name

Plan: 11 to create, 5 to update, 2 unchanged, 7 manual, 1 skipped.
warning: 2 domains to create; the Free plan allows 1 (1 already there)
Estimate: ~68 requests · 9 s at 8 req/s
`;

const stdout = process.stdout as unknown as { columns?: number | undefined };
const savedColumns = stdout.columns;

beforeEach(() => {
  setColorMode("never");
  stdout.columns = 80;
});
afterEach(() => {
  setColorMode("auto");
  stdout.columns = savedColumns;
});

describe("buildPlan + renderPlan (golden)", () => {
  const plan = buildPlan({ snapshot, target: goldenTarget, options: options() });

  it("renders exactly", () => {
    expect(renderPlan(plan)).toBe(GOLDEN);
  });

  it("counts, header and manual list agree with the items", () => {
    expect(plan.counts).toEqual({ create: 11, update: 5, unchanged: 2, manual: 7, skip: 1 });
    expect(plan).toMatchObject({
      version: 2,
      createdAt: "2026-09-01T12:00:00.000Z",
      source: "resend",
      target: { baseUrl: "https://api.billionsend.com", plan: "free" },
      rps: 8,
    });
    expect(plan.manual).toHaveLength(7);
    expect(plan.manual[0]).toEqual({
      title: "segments/Enterprise",
      detail: 'filter not translated (unsupported field "plan_tier"); 1 member still imported',
    });
  });

  it("estimates: spent + one read per contact per facet + writes; seconds cover the same requests", () => {
    // writes: 9 creates + 4 updates + contacts lookup + contacts batch + suppressions batch + one enrichment batch per facet = 18
    // 40 spent + 10 enrichment reads = 50 source requests at 8/s (6.25 s) + 18 target requests at 10/s (1.8 s) = 8.05 s
    expect(plan.estimate).toEqual({ requests: 68, seconds: 9 });
    const topicsOnly = buildPlan({
      snapshot: { ...snapshot, properties: [] },
      target: goldenTarget,
      options: options(),
    });
    // One facet: 5 reads, two writes fewer (the seats property is not created, one enrichment batch less):
    // 45 source requests at 8/s (5.625 s) + 16 target requests at 10/s (1.6 s) = 7.2 s
    expect(topicsOnly.estimate).toEqual({ requests: 61, seconds: 8 });
  });

  it("carries typed payloads without secrets", () => {
    const byKey = (resource: Resource, key: string, action = "create") =>
      plan.items.find((i) => i.resource === resource && i.key === key && i.action === action);
    expect(byKey("properties", "seats")?.payload).toEqual({
      key: "seats",
      type: "number",
      fallback_value: 1,
    });
    expect(byKey("topics", "Beta program")?.payload).toEqual({
      name: "Beta program",
      default_subscription: "opt_out",
    });
    expect(byKey("topics", "Product updates", "update")).toMatchObject({
      targetId: "t1",
      payload: { description: "Feature announcements and release notes" },
    });
    expect(byKey("segments", "Active Users", "update")?.payload).toEqual({
      filter: {
        match: "all",
        conditions: [{ field: "email", op: "ends_with", value: "@example.com" }],
      },
    });
    expect(byKey("segments", "Enterprise")?.payload).toEqual({ name: "Enterprise" });
    expect(byKey("domains", "updates.example.com")?.payload).toEqual({
      create: { name: "updates.example.com", custom_return_path: "bounces" },
      tracking: { open_tracking: false, click_tracking: true, tracking_subdomain: "track" },
    });
    expect(byKey("webhooks", "https://webhook.example.com/handler", "update")?.payload).toEqual({
      events: ["email.sent", "email.delivered", "email.bounced"],
    });
    expect(byKey("templates", "welcome", "update")?.payload).toEqual({
      name: "Welcome",
      from: "Acme <onboarding@example.com>",
      reply_to: ["support@example.com"],
      variables: [{ key: "first_name", type: "string", fallback_value: "friend" }],
    });
    expect(byKey("templates", "Receipt")?.payload).toEqual({
      name: "Receipt",
      subject: "Your receipt",
      html: "<p>Order {{{order_id}}}</p>",
      text: "Order {{{order_id}}}",
      variables: [{ key: "order_id", type: "string" }],
    });
    expect(byKey("broadcasts", "November announcements")?.payload).toEqual({
      input: {
        name: "November announcements",
        from: "Acme <onboarding@example.com>",
        subject: "Hello World",
        html: '<p>Hello {{{FIRST_NAME|there}}}!</p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a>',
        text: "Hello {{{FIRST_NAME|there}}}!",
        preview_text: "Here are our announcements",
      },
      segmentName: "Active Users",
      topicName: null,
    });
    expect(serializePlan(plan)).not.toContain("whsec_");
  });

  it("orders items by dependency", () => {
    const order = [...new Set(plan.items.map((i) => i.resource))];
    expect(order).toEqual([
      "properties",
      "topics",
      "segments",
      "domains",
      "webhooks",
      "templates",
      "contacts",
      "broadcasts",
      "suppressions",
      "enrichment",
      "api-keys",
    ]);
  });
});

describe("buildPlan against an empty target", () => {
  const plan = buildPlan({ snapshot, target: emptyTarget, options: options() });

  it("creates everything it can and copies webhook secrets", () => {
    // The only update is the enrichment pass; nothing exists to be unchanged.
    expect(plan.counts).toMatchObject({ update: 1, unchanged: 0 });
    expect(plan.warnings).toEqual([]);
    const webhook = plan.items.find((i) => i.resource === "webhooks" && i.action === "create");
    expect(webhook).toMatchObject({
      key: "https://webhook.example.com/handler",
      detail: "3 events, secret copied",
      payload: {
        endpoint: "https://webhook.example.com/handler",
        events: ["email.sent", "email.delivered", "email.bounced"],
        sourceId: "479e3145-dd38-476b-932c-529ceb705947",
        signingSecret: "copy",
      },
    });
    // No domain is verified on an empty target, so every broadcast waits for DNS.
    expect(plan.items.filter((i) => i.resource === "broadcasts").map((i) => i.action)).toEqual([
      "manual",
      "manual",
      "skip",
    ]);
  });

  it("--fresh-webhook-secrets mints new ones", () => {
    const fresh = buildPlan({
      snapshot,
      target: emptyTarget,
      options: options({ freshWebhookSecrets: true }),
    });
    expect(
      fresh.items.find((i) => i.resource === "webhooks" && i.action === "create"),
    ).toMatchObject({ detail: "3 events, fresh secret", payload: { signingSecret: "fresh" } });
  });

  it("--include-sent imports sent broadcasts as drafts once the domain is verified", () => {
    const verified: TargetState = {
      ...emptyTarget,
      domains: [
        { id: "d1", name: "example.com", region: "us-east-1", status: "verified", records: [] },
      ],
    };
    const plan = buildPlan({ snapshot, target: verified, options: options({ includeSent: true }) });
    const recap = plan.items.filter((i) => i.key === "Launch recap");
    expect(recap.map((i) => [i.action, i.detail])).toEqual([
      ["create", "draft"],
      ["manual", "already sent on Resend; imported as a draft"],
    ]);
  });

  it("a small plan after many source reads is as slow as those reads: 140 reads at 8/s is 17.5 s, not 1 s", () => {
    // The CLI's first live run printed "~152 requests · 1 s at 8 req/s" for a plan that takes 19 s.
    const read = (spent: number) =>
      buildPlan({
        snapshot: { ...snapshot, properties: [], topics: [], segments: [] },
        target: emptyTarget,
        options: options({
          include: new Set<Resource>(["contacts"]),
          sourceRequestsSpent: spent,
          rps: 8,
        }),
      }).estimate;
    // Two target requests: the lookup of the contacts, then the batch upsert. 140 / 8 + 2 / 10 = 17.7, rounded up.
    expect(read(140)).toEqual({ requests: 142, seconds: 18 });
    expect(read(152)).toEqual({ requests: 154, seconds: 20 });
  });

  it("honours the include set and skips enrichment when nothing enriches", () => {
    const plan = buildPlan({
      snapshot: { ...snapshot, properties: [], topics: [] },
      target: emptyTarget,
      options: options({ include: new Set<Resource>(["contacts", "enrichment", "suppressions"]) }),
    });
    expect(plan.items.map((i) => [i.resource, i.count])).toEqual([
      ["contacts", 5],
      ["suppressions", 3],
    ]);
    // No enrichment reads, no per-item writes: 40 spent source requests at 8/s + (1 lookup + 1 upsert + 1 suppressions) at 10/s.
    expect(plan.estimate).toEqual({ requests: 43, seconds: 6 });
    expect(plan.items[0]?.detail).toBe("batch upsert, 0 segment memberships");
  });

  it("plans enrichment on its own when the target already holds the contacts", () => {
    const plan = buildPlan({
      snapshot,
      target: { ...goldenTarget, hasContacts: true },
      options: options({ include: new Set<Resource>(["enrichment"]) }),
    });
    expect(plan.items.map((i) => i.resource)).toEqual(["enrichment"]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("topics are excluded")]),
    );
    const bare = buildPlan({
      snapshot,
      target: goldenTarget,
      options: options({ include: new Set<Resource>(["enrichment"]) }),
    });
    expect(bare.items).toEqual([]);
  });

  it("skips the enrichment item when the snapshot is already enriched", () => {
    const plan = buildPlan({
      snapshot: { ...snapshot, enriched: true },
      target: emptyTarget,
      options: options(),
    });
    expect(plan.items.some((i) => i.resource === "enrichment")).toBe(false);
  });
});

describe("buildPlan diffs against existing rows", () => {
  const withRows = (partial: Partial<TargetState>): TargetState => ({ ...emptyTarget, ...partial });
  const only = (resource: Resource) => new Set<Resource>([resource]);

  it("is unchanged when nothing differs", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        topics: [
          {
            id: "t1",
            name: "Product updates",
            description: "Feature announcements and release notes",
            defaultSubscription: "opt_in",
          },
          { id: "t2", name: "Beta program", description: null, defaultSubscription: "opt_out" },
        ],
      }),
      options: options({ include: only("topics") }),
    });
    expect(plan.items.map((i) => [i.action, i.key, i.targetId])).toEqual([
      ["unchanged", "Product updates", "t1"],
      ["unchanged", "Beta program", "t2"],
    ]);
  });

  it("flags an immutable difference as manual and still diffs the rest", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        topics: [
          { id: "t2", name: "Beta program", description: "x", defaultSubscription: "opt_in" },
        ],
        properties: [{ id: "p1", key: "seats", type: "string" }],
      }),
      options: options({ include: new Set<Resource>(["topics", "properties"]) }),
    });
    expect(plan.items.map((i) => [i.resource, i.action, i.key])).toEqual([
      ["properties", "create", "company"],
      ["properties", "manual", "seats"],
      ["topics", "create", "Product updates"],
      ["topics", "manual", "Beta program"],
      ["topics", "update", "Beta program"],
    ]);
  });

  it("narrows a target webhook subscribed to every target event down to Resend's set", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        webhooks: [
          {
            id: "w1",
            endpoint: "https://webhook.example.com/handler",
            events: [...TARGET_WEBHOOK_EVENTS],
            status: "disabled",
          },
        ],
      }),
      options: options({ include: only("webhooks") }),
    });
    expect(plan.items[0]).toMatchObject({
      action: "update",
      detail: "events, status",
      payload: { events: ["email.sent", "email.delivered", "email.bounced"], status: "enabled" },
    });
  });

  const receiptBody = {
    subject: "Your receipt",
    html: "<p>Order {{{order_id}}}</p>",
    text: "Order {{{order_id}}}",
    variables: [{ key: "order_id", type: "string", fallback_value: null }],
  };

  it("matches templates by alias before name and diffs the alias", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        templates: [
          {
            ...goldenTarget.templates[0],
            id: "a",
            name: "Welcome",
            alias: null,
            from: "Acme <onboarding@example.com>",
            replyTo: ["support@example.com"],
            variables: [{ key: "first_name", type: "string", fallback_value: "friend" }],
          },
          { id: "b", name: "Receipt", alias: "receipt", ...receiptBody },
        ],
      }),
      options: options({ include: only("templates") }),
    });
    const rows = plan.items.filter((i) => i.action !== "manual");
    expect(rows.map((i) => [i.action, i.key, i.targetId, i.detail, i.payload])).toEqual([
      ["update", "welcome", "a", "alias", { alias: "welcome" }],
      ["update", "Receipt", "b", "alias", { alias: null }],
    ]);
  });

  it("a body edited on Resend becomes an update carrying only the translated fields that differ", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        templates: [
          { id: "b", name: "Receipt", alias: null, ...receiptBody, html: "<p>old</p>", text: null },
        ],
      }),
      options: options({ include: only("templates") }),
    });
    expect(plan.items.find((i) => i.key === "Receipt")).toMatchObject({
      action: "update",
      detail: "html, text",
      payload: { html: "<p>Order {{{order_id}}}</p>", text: "Order {{{order_id}}}" },
    });
    const same = buildPlan({
      snapshot,
      target: withRows({ templates: [{ id: "b", name: "Receipt", alias: null, ...receiptBody }] }),
      options: options({ include: only("templates") }),
    });
    expect(same.items.find((i) => i.key === "Receipt")?.action).toBe("unchanged");
  });

  it("lists the target's DNS records for an existing unverified domain and warns on the plan limit", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        usage: {
          ...emptyTarget.usage,
          plan: "pro",
          limits: { emailsPerDay: 3000, emailsPerMonth: null, domains: 2, contacts: null },
        },
        domains: [
          {
            id: "d1",
            name: "example.com",
            region: "us-east-1",
            status: "pending",
            records: [
              { record: "DKIM", name: "billionsend._domainkey", type: "CNAME", value: "x" },
              { record: "SPF", name: "send", type: "MX", value: "y", priority: 10 },
              { record: "SPF", name: "send", type: "TXT", value: "z" },
            ],
          },
        ],
      }),
      options: options({ include: only("domains") }),
    });
    expect(plan.items.map((i) => [i.action, i.key, i.detail])).toEqual([
      ["unchanged", "example.com", undefined],
      ["manual", "example.com", "add 3 DNS records"],
      ["create", "updates.example.com", undefined],
      ["manual", "updates.example.com", "add DNS records (shown after apply)"],
      ["create", "mail.example.org", undefined],
      ["manual", "mail.example.org", "add DNS records (shown after apply)"],
    ]);
    expect(plan.warnings).toEqual(["2 domains to create; the Pro plan allows 2 (1 already there)"]);
  });

  it("warns when creates exceed the domain limit; a target without limits (the system team) never warns", () => {
    const cloud = buildPlan({
      snapshot: { ...snapshot, domains: snapshot.domains.slice(0, 2) },
      target: withRows({
        usage: {
          ...emptyTarget.usage,
          plan: "free",
          limits: { emailsPerDay: 100, emailsPerMonth: null, domains: 1, contacts: 1000 },
        },
      }),
      options: options({ include: only("domains") }),
    });
    expect(cloud.warnings).toEqual([
      "2 domains to create; the Free plan allows 1 (0 already there)",
    ]);
    const unlimited = buildPlan({
      snapshot,
      target: emptyTarget,
      options: options({ include: only("domains") }),
    });
    expect(unlimited.warnings).toEqual([]);
  });

  it("warns when the contacts to import exceed the plan's contact cap", () => {
    const capped = buildPlan({
      snapshot,
      target: withRows({
        usage: { ...goldenTarget.usage, limits: { ...goldenTarget.usage.limits, contacts: 4 } },
      }),
      options: options({ include: only("contacts") }),
    });
    expect(capped.warnings).toEqual(["5 contacts to create; the Free plan allows 4"]);
    const fits = buildPlan({
      snapshot,
      target: goldenTarget,
      options: options({ include: only("contacts") }),
    });
    expect(fits.warnings).toEqual([]);
  });

  it("leaves an existing draft broadcast alone", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        domains: [
          { id: "d1", name: "example.com", region: "us-east-1", status: "verified", records: [] },
        ],
        broadcasts: [
          { id: "b1", name: "November announcements", status: "draft" },
          { id: "b2", name: "Beta invite", status: "sent" },
        ],
      }),
      options: options({ include: only("broadcasts") }),
    });
    expect(plan.items.map((i) => [i.action, i.key])).toEqual([
      ["unchanged", "November announcements"],
      ["manual", "Beta invite"],
      ["skip", "Launch recap"],
    ]);
    expect(renderPlan(plan)).toContain(
      "  = November announcements  matched by name; the draft's body is not compared",
    );
  });

  it("renders source-controlled names without their control and escape sequences", () => {
    const hostile = "News\x1b]52;c;cHduZWQ=\x07\x1b[2J\x00";
    const plan = buildPlan({
      snapshot: {
        ...snapshot,
        topics: [
          {
            id: "t-hostile",
            name: hostile,
            description: `${hostile} desc`,
            defaultSubscription: "opt_in",
          },
        ],
      },
      target: emptyTarget,
      options: options({ include: only("topics") }),
    });
    const text = renderPlan(plan);
    expect(text).toContain("  + News  opt_in");
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\x07");
    expect(text).not.toContain("\x00");
  });
});

describe("planHash / serializePlan / parsePlan", () => {
  const plan = buildPlan({ snapshot, target: goldenTarget, options: options() });

  it("hashes the items only, independent of key order and timestamps", () => {
    const hash = planHash(plan);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(planHash({ ...plan, createdAt: "2000-01-01T00:00:00.000Z" })).toBe(hash);
    const reordered = {
      ...plan,
      items: plan.items.map((i) => ({ ...i, key: i.key, resource: i.resource })),
    };
    expect(planHash(reordered)).toBe(hash);
    expect(planHash({ ...plan, items: plan.items.slice(1) })).not.toBe(hash);
  });

  it("round-trips through JSON", () => {
    const text = serializePlan(plan);
    expect(text.endsWith("}\n")).toBe(true);
    const parsed = parsePlan(text);
    expect(parsed).toEqual(plan);
    expect(planHash(parsed)).toBe(planHash(plan));
  });

  it.each([
    ["{", "plan file is not valid JSON"],
    ["null", "plan file is not a migration plan"],
    ['{"version":1}', "plan file is not a migration plan"],
    ['{"version":1,"items":[]}', "plan file version 1 is not supported (expected 2)"],
    ['{"items":[]}', "plan file version undefined is not supported (expected 2)"],
    ['{"version":2,"items":[]}', "plan file is not a migration plan"],
  ])("rejects %s", (text, message) => {
    expect(() => parsePlan(text)).toThrow(message);
  });
});

describe("groupPlanItems", () => {
  const launchRecap = snapshot.broadcasts.find((b) => b.status === "sent");
  const sent = (name: string) =>
    ({ ...launchRecap, id: name, name }) as (typeof snapshot.broadcasts)[number];

  it("folds three or more items sharing action and detail into one row", () => {
    const plan = buildPlan({
      snapshot: { ...snapshot, broadcasts: ["A", "B", "C", "D"].map(sent) },
      target: emptyTarget,
      options: options({ include: new Set<Resource>(["broadcasts", "api-keys"]) }),
    });
    expect(groupPlanItems(plan.items)).toEqual([
      {
        resource: "broadcasts",
        label: "broadcasts",
        rows: [
          {
            action: "skip",
            name: "4 broadcasts",
            detail: "already sent; --include-sent imports sent broadcasts as drafts",
            keys: ["A", "B", "C", "D"],
          },
        ],
      },
      {
        resource: "api-keys",
        label: "api-keys",
        rows: [
          { action: "manual", name: "Production", detail: expect.any(String) },
          { action: "manual", name: "Staging", detail: expect.any(String) },
        ],
      },
    ]);
    expect(renderPlan(plan)).toContain(
      "broadcasts\n  − 4 broadcasts  already sent; --include-sent imports sent broadcasts as drafts\n    A, B … and 2 more\napi-keys\n",
    );
    expect(plan.counts.skip).toBe(4);
  });

  it("never folds creates or updates: every name is shown before the confirm", () => {
    const topic = snapshot.topics[0];
    if (topic === undefined) throw new Error("fixture has no topic");
    const topics = ["Product updates", "Changelog", "Security notices"].map((name) => ({
      ...topic,
      id: name,
      name,
      defaultSubscription: "opt_in" as const,
    }));
    const plan = buildPlan({
      snapshot: { ...snapshot, topics },
      target: emptyTarget,
      options: options({ include: new Set<Resource>(["topics"]) }),
    });
    expect(groupPlanItems(plan.items)).toEqual([
      {
        resource: "topics",
        label: "topics",
        rows: topics.map((t) => ({ action: "create", name: t.name, detail: "opt_in" })),
      },
    ]);
    expect(renderPlan(plan)).toContain(
      "topics\n  + Product updates  opt_in\n  + Changelog  opt_in\n  + Security notices  opt_in\n",
    );
  });
});

describe("renderPlan colours", () => {
  const plan = () =>
    buildPlan({
      snapshot,
      target: emptyTarget,
      options: options({ include: new Set<Resource>(["suppressions"]) }),
    });

  it("colors the symbol, dims the detail, bolds the non-zero totals", () => {
    setColorMode("always");
    const lines = renderPlan(plan()).split("\n");
    expect(lines[0]).toBe("\x1b[2m+ create   ~ update   = unchanged   ! manual   − skip\x1b[22m");
    expect(lines).toContain(
      "  \x1b[32m+\x1b[39m suppressions  \x1b[2mbatch add with origin\x1b[22m",
    );
    expect(lines).toContain(
      "Plan: \x1b[1m1\x1b[22m to create, 0 to update, 0 unchanged, 0 manual.",
    );
    expect(lines.at(-2)).toBe("\x1b[2mEstimate: ~41 requests · 6 s at 8 req/s\x1b[22m");
  });

  it("wraps on visible width, so color codes never count", () => {
    setColorMode("always");
    stdout.columns = 30;
    const text = renderPlan(plan());
    expect(text).toContain(
      "  \x1b[32m+\x1b[39m suppressions  \x1b[2mbatch add\n    with origin\x1b[22m",
    );
    expect(text).toContain("Plan: \x1b[1m1\x1b[22m to create, 0 to\n  update,");
    // The one-line legend is the only line never wrapped.
    for (const line of text.split("\n").slice(1))
      expect(visibleLength(line)).toBeLessThanOrEqual(30);
  });
});

describe("property keys that differ only in case", () => {
  const only = (...r: Resource[]) => new Set<Resource>(r);
  const props = (...keys: string[]): Snapshot["properties"] =>
    keys.map((key) => ({ key, type: "string" as const }));

  it("creates the first, lists the others as manual items that name the key kept", () => {
    const plan = buildPlan({
      snapshot: { ...snapshot, properties: props("plan", "PLAN", "Plan", "seats") },
      target: emptyTarget,
      options: options({ include: only("properties") }),
    });
    expect(plan.items.map((i) => [i.action, i.key])).toEqual([
      ["create", "plan"],
      ["manual", "PLAN"],
      ["manual", "Plan"],
      ["create", "seats"],
    ]);
    expect(plan.items[1]).toMatchObject({
      payload: { collidesWith: "plan" },
      detail: expect.stringContaining("differs from `plan` only in case"),
    });
    expect(plan.manual).toHaveLength(2);
  });

  it("matches a key on the target ignoring case, and writes under the target's spelling", () => {
    const plan = buildPlan({
      snapshot: { ...snapshot, properties: props("plan") },
      target: withProperties([{ id: "p1", key: "Plan", type: "string" }]),
      options: options({ include: only("properties") }),
    });
    expect(plan.items).toEqual([
      {
        resource: "properties",
        action: "unchanged",
        key: "plan",
        targetId: "p1",
        detail: "already here as `Plan` (keys ignore case)",
        payload: { targetKey: "Plan" },
      },
    ]);
  });

  it("a type that differs from the target's key is manual, whatever the case", () => {
    const plan = buildPlan({
      snapshot: { ...snapshot, properties: [{ key: "seats", type: "number" }] },
      target: withProperties([{ id: "p1", key: "SEATS", type: "string" }]),
      options: options({ include: only("properties") }),
    });
    expect(plan.items.map((i) => i.action)).toEqual(["manual"]);
  });

  const withProperties = (properties: TargetState["properties"]): TargetState => ({
    ...emptyTarget,
    properties,
  });
});

describe("plan options and scope", () => {
  it("records the options and the segments the plan was limited to", () => {
    const plan = buildPlan({
      snapshot: { ...snapshot, segmentScope: [{ id: "s1", name: "Active Users" }] },
      target: emptyTarget,
      options: options({
        only: ["contacts", "segments"],
        segment: ["Active Users"],
        onConflict: "skip",
        include: new Set<Resource>(["contacts", "segments"]),
      }),
    });
    expect(plan.options).toEqual({
      only: ["contacts", "segments"],
      skip: [],
      segment: ["Active Users"],
      onConflict: "skip",
      includeSent: false,
      freshWebhookSecrets: false,
    });
    expect(plan.scope).toEqual({ segments: [{ id: "s1", name: "Active Users" }] });
    setColorMode("never");
    expect(renderPlan(plan)).toContain("Scope (--segment): only Active Users and its members");
    setColorMode("auto");
    expect(buildPlan({ snapshot, target: emptyTarget, options: options() }).scope).toBeNull();
  });

  it("skips a broadcast sent to a segment outside the scope and keeps the ones without a segment", () => {
    const base = snapshot.broadcasts[0];
    const plan = buildPlan({
      snapshot: {
        ...snapshot,
        segmentScope: [{ id: "in", name: "In" }],
        broadcasts: [
          { ...base, id: "b1", name: "Out", segmentId: "out", status: "draft" },
          { ...base, id: "b2", name: "In", segmentId: "in", status: "draft" },
          { ...base, id: "b3", name: "None", segmentId: null, status: "draft" },
        ],
      } as Snapshot,
      target: emptyTarget,
      options: options({ include: new Set<Resource>(["broadcasts"]) }),
    });
    expect(plan.items.find((i) => i.key === "Out")).toMatchObject({
      action: "skip",
      detail: "sent to a segment outside --segment",
    });
    expect(plan.items.filter((i) => i.action === "skip")).toHaveLength(1);
  });
});

describe("describePlanDiff", () => {
  it("names what was added, gone and changed", () => {
    const a = buildPlan({ snapshot, target: emptyTarget, options: options() });
    const b = {
      ...a,
      items: [
        ...a.items.filter((i) => i.key !== "seats"),
        { resource: "topics", action: "create", key: "Brand new" },
      ].map((i) => (i.resource === "contacts" ? { ...i, count: 6 } : i)),
    } as typeof a;
    const lines = describePlanDiff(a, b);
    expect(lines).toContain("properties/seats: in the file, not in the current plan");
    expect(lines).toContain("topics/Brand new: not in the file, in the current plan");
    expect(lines).toContain("contacts/contacts: create → create, 5 → 6");
    expect(describePlanDiff(a, a)).toEqual([]);
  });
});

describe("contacts the target already has", () => {
  const only = new Set<Resource>(["contacts"]);
  const there = (
    firstName: string | null,
    lastName: string | null,
    unsubscribed = false,
  ): TargetContact => ({ firstName, lastName, unsubscribed });
  const plan = (
    contacts: [string, TargetContact][],
    overrides: Partial<PlanOptions> = {},
    target: Partial<TargetState> = {},
  ) =>
    buildPlan({
      snapshot: { ...snapshot, segments: [], topics: [], properties: [] },
      target: { ...emptyTarget, contacts: new Map(contacts), ...target },
      options: options({ include: only, ...overrides }),
    });
  const contactItems = (p: ReturnType<typeof plan>) =>
    p.items.map((i) => [i.action, i.key, i.count]);

  it("none there: one create item for the whole batch, as before", () => {
    expect(contactItems(plan([]))).toEqual([["create", "contacts", 5]]);
  });

  it("splits new from existing, matching addresses ignoring case, and says which differ", () => {
    const p = plan([
      // Same names and flag: nothing for the upsert to change.
      ["steve.wozniak@gmail.com", there("Steve", "Wozniak")],
      // A name differs.
      ["grace.hopper@example.com", there("Gracie", "Hopper")],
      // Unsubscribed on the source, subscribed here: the upsert writes the opt-out.
      ["ada.lovelace@example.com", there("Ada", "Lovelace", false)],
      // The source has no name; what the target holds is left alone.
      ["alan.turing@example.com", there("Alan", "Turing")],
    ]);
    expect(contactItems(p)).toEqual([
      ["create", "contacts", 1],
      ["update", "existing contacts", 2],
      ["unchanged", "existing contacts", 2],
    ]);
    expect(p.items[0]?.detail).toBe(
      "1 not on BillionSend yet; batch upsert, 0 segment memberships across all 5 contacts",
    );
    expect(p.counts).toMatchObject({ create: 1, update: 1, unchanged: 1 });
    expect(renderPlan(p)).toContain("contacts (5)");
  });

  it("an existing contact in a segment is upserted to make sure it is a member", () => {
    const withSegment = buildPlan({
      snapshot: {
        ...snapshot,
        topics: [],
        properties: [],
        segments: [
          {
            id: "s1",
            name: "Active Users",
            filter: null,
            memberEmails: ["Steve.Wozniak@gmail.com"],
          },
        ],
      },
      target: {
        ...emptyTarget,
        contacts: new Map([
          ["steve.wozniak@gmail.com", there("Steve", "Wozniak")],
          ["grace.hopper@example.com", there("Grace", "Hopper")],
        ]),
      },
      options: options({ include: new Set<Resource>(["contacts", "segments"]) }),
    });
    expect(
      withSegment.items.filter((i) => i.resource === "contacts").map((i) => [i.action, i.count]),
    ).toEqual([
      ["create", 3],
      ["update", 1],
      ["unchanged", 1],
    ]);
  });

  it("an opt-out on the target is no difference: the source cannot clear it", () => {
    const p = plan([["ada.lovelace@example.com", there("Ada", "Lovelace", true)]]);
    expect(contactItems(p)).toContainEqual(["unchanged", "existing contacts", 1]);
  });

  it("everyone there and nothing differs: no create at all", () => {
    const p = plan(
      [
        ["steve.wozniak@gmail.com", there("Steve", "Wozniak")],
        ["grace.hopper@example.com", there("Grace", "Hopper")],
        ["ada.lovelace@example.com", there("Ada", "Lovelace", true)],
        ["alan.turing@example.com", there(null, null)],
        ["linus@example.net", there("Linus", null)],
      ],
      {},
    );
    expect(contactItems(p)).toEqual([["unchanged", "existing contacts", 5]]);
    expect(p.counts.create).toBe(0);
  });

  it("--on-conflict skip and error say what happens to the ones already there", () => {
    const rows: [string, TargetContact][] = [["steve.wozniak@gmail.com", there("S", null)]];
    const skip = plan(rows, { onConflict: "skip" });
    expect(skip.items.at(-1)).toMatchObject({
      action: "skip",
      count: 1,
      detail: expect.stringContaining("--on-conflict skip leaves them as they are"),
    });
    const error = plan(rows, { onConflict: "error" });
    // The run still goes through them, so the API refuses each and the run exits 3.
    expect(error.items.at(-1)).toMatchObject({
      action: "update",
      detail: expect.stringContaining("--on-conflict error refuses them"),
    });
  });

  it("only the new contacts count against the plan's contact cap", () => {
    const limited = {
      usage: {
        ...emptyTarget.usage,
        plan: "free",
        limits: { ...emptyTarget.usage.limits, contacts: 3 },
      },
    };
    expect(plan([], {}, limited).warnings).toEqual([
      "5 contacts to create; the Free plan allows 3",
    ]);
    const mostlyThere: [string, TargetContact][] = [
      "steve.wozniak@gmail.com",
      "grace.hopper@example.com",
      "ada.lovelace@example.com",
    ].map((email) => [email, there(null, null)]);
    expect(plan(mostlyThere, {}, limited).warnings).toEqual([]);
  });
});
