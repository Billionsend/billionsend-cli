import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BATCH_MAX,
  type BillionSendTarget,
  createBillionSendTarget,
  type WriteResult,
} from "../src/billionsend.js";
import { AuthError, createHttp } from "../src/http.js";
import { createLogger } from "../src/log.js";
import { VERSION } from "../src/meta.js";
import type { Snapshot } from "../src/model.js";
import { buildPlan } from "../src/plan.js";
import { TARGET_ALL_EVENTS } from "../src/translate.js";
import { type ContractApi, startContractApi } from "./helpers/contract-api.js";

let cloud: ContractApi;
let target: BillionSendTarget;

const log = createLogger({ level: "error" });

function targetFor(
  api: Pick<ContractApi, "baseUrl" | "apiKey">,
  token = api.apiKey,
): BillionSendTarget {
  return createBillionSendTarget(
    createHttp({
      baseUrl: api.baseUrl,
      token,
      userAgent: "billionsend-cli/test",
      rps: 1000,
      name: "BillionSend",
      log,
    }),
    log,
    api.baseUrl,
  );
}

function ok<T>(result: WriteResult<T>): T {
  if (!result.ok) throw new Error(`${result.status} ${result.name}: ${result.message}`);
  return result;
}

const ids = {} as Record<
  | "property"
  | "numberProperty"
  | "topic"
  | "privateTopic"
  | "segment"
  | "filteredSegment"
  | "domain"
  | "webhook"
  | "webhook2"
  | "template"
  | "broadcast"
  | "ada"
  | "bob"
  | "suppression"
  | "suppression2",
  string
>;

beforeAll(async () => {
  cloud = await startContractApi();
  target = targetFor(cloud);
});
afterAll(() => cloud.stop());

describe("probe", () => {
  it("reads the plan and limits", async () => {
    expect(await target.probe()).toEqual({
      plan: "pro",
      limits: { emailsPerDay: null, emailsPerMonth: 60_000, domains: null, contacts: null },
      overageEnabled: true,
    });
    expect(target.requests).toBe(1);
  });

  it("reads the Free plan's daily cap and its domain and contact limits", async () => {
    const free = await startContractApi({ slug: "free-probe", plan: "free" });
    try {
      expect(await targetFor(free).probe()).toMatchObject({
        plan: "free",
        limits: { emailsPerDay: 100, emailsPerMonth: null, domains: 3, contacts: 1000 },
        overageEnabled: false,
      });
    } finally {
      await free.stop();
    }
  });

  it("is an AuthError naming the full-access requirement on 403 and 401", async () => {
    const sendingKey = cloud.createApiKey("sending_access");
    const restricted = await targetFor(cloud, sendingKey)
      .probe()
      .catch((e: unknown) => e);
    expect(restricted).toBeInstanceOf(AuthError);
    expect((restricted as AuthError).status).toBe(403);
    expect((restricted as Error).message).toContain("full-access key (bs_…)");
    expect((restricted as Error).message).toContain("BILLIONSEND_API_KEY");

    const wrong = await targetFor(cloud, "bs_not_a_key")
      .probe()
      .catch((e: unknown) => e);
    expect(wrong).toMatchObject({ status: 401 });
    expect((wrong as Error).message).toContain("full-access key (bs_…)");
  });

  it("names the URL and the upgrade path when the instance has no GET /usage", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "not_found", message: "no route" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const error = (await targetFor({ baseUrl, apiKey: "bs_x" })
        .probe()
        .catch((e: unknown) => e)) as Error;
      expect(error.message).toBe(
        `BillionSend at ${baseUrl} has no GET /usage: either ${baseUrl} is not the API URL of your instance (check --to-url / BILLIONSEND_BASE_URL) or the instance predates CLI ${VERSION}; upgrade it.`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("writers", () => {
  it("creates properties, topics, segments and maps duplicates/validation to ok:false", async () => {
    ids.property = ok(await target.createProperty({ key: "plan", type: "string" })).id;
    ids.numberProperty = ok(
      await target.createProperty({ key: "seats", type: "number", fallbackValue: 1 }),
    ).id;
    expect(await target.createProperty({ key: "plan", type: "string" })).toEqual({
      ok: false,
      status: 409,
      name: "validation_error",
      message: "Property already exists",
    });

    ids.topic = ok(
      await target.createTopic({
        name: "Product news",
        description: "Launches",
        defaultSubscription: "opt_in",
      }),
    ).id;
    ids.privateTopic = ok(
      await target.createTopic({ name: "Ops", description: null, defaultSubscription: "opt_out" }),
    ).id;
    expect(await target.createTopic({ name: "", defaultSubscription: "opt_in" })).toMatchObject({
      ok: false,
      status: 422,
      name: "validation_error",
    });
    expect(await target.updateTopic(ids.topic, { description: "Launches and changelogs" })).toEqual(
      {
        ok: true,
        id: ids.topic,
      },
    );
    expect(
      await target.updateTopic("00000000-0000-4000-8000-000000000000", { name: "x" }),
    ).toMatchObject({ ok: false, status: 404, name: "not_found" });

    ids.segment = ok(await target.createSegment({ name: "Customers" })).id;
    ids.filteredSegment = ok(
      await target.createSegment({
        name: "Pro",
        filter: {
          match: "all",
          conditions: [{ field: "property:plan", op: "equals", value: "pro" }],
        },
      }),
    ).id;
    expect(await target.updateSegment(ids.segment, { name: "Paying customers" })).toEqual({
      ok: true,
      id: ids.segment,
    });
    expect(
      await target.createSegment({
        name: "Bad",
        filter: { match: "all", conditions: [{ field: "nope", op: "equals", value: "x" }] },
      }),
    ).toMatchObject({
      ok: false,
      status: 422,
    });
  });

  it("creates a domain with records, patches tracking, and 409s a duplicate", async () => {
    const created = ok(
      await target.createDomain({
        name: "acme.dev",
        customReturnPath: "mail",
      }),
    );
    ids.domain = created.id;
    expect(created.records.map((r) => r.record)).toEqual(
      expect.arrayContaining(["DKIM", "SPF", "DMARC"]),
    );
    expect(created.records.find((r) => r.record === "SPF")?.name).toBe("mail.acme.dev");

    const patched = ok(
      await target.updateDomainTracking(ids.domain, {
        openTracking: true,
        clickTracking: true,
        trackingSubdomain: "track",
      }),
    );
    expect(patched.id).toBe(ids.domain);
    expect(patched.records.find((r) => r.record === "Tracking")?.name).toBe("track.acme.dev");
    // The return path is fixed at creation: the tracking patch never names it (the API answers 422 if it does).
    expect(cloud.store.domains.get(ids.domain)?.customReturnPath).toBe("mail");

    expect(await target.createDomain({ name: "acme.dev" })).toEqual({
      ok: false,
      status: 409,
      name: "conflict",
      message: "domain already added",
    });
    expect(await target.createDomain({ name: "Not A Domain" })).toMatchObject({
      ok: false,
      status: 422,
    });
  });

  it("leaves the return path to the API's default, which is bounce", async () => {
    const created = ok(await target.createDomain({ name: "default-return-path.dev" }));
    expect(created.records.find((r) => r.record === "SPF")?.name).toBe(
      "bounce.default-return-path.dev",
    );
    expect(cloud.store.domains.get(created.id)?.customReturnPath).toBe("bounce");
    expect((await target.deleteDomain(created.id)).ok).toBe(true);
  });

  it("creates webhooks copying or minting the secret, updates, and 422s http endpoints", async () => {
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    const copied = ok(
      await target.createWebhook({
        endpoint: "https://hooks.example.test/a",
        events: ["email.delivered", "email.bounced"],
        signingSecret: secret,
      }),
    );
    ids.webhook = copied.id;
    expect(copied.signingSecret).toBe(secret);

    const fresh = ok(
      await target.createWebhook({
        endpoint: "https://hooks.example.test/b",
        events: ["email.sent"],
      }),
    );
    ids.webhook2 = fresh.id;
    expect(fresh.signingSecret).toMatch(/^whsec_/);
    expect(fresh.signingSecret).not.toBe(secret);

    expect(
      await target.updateWebhook(ids.webhook, { events: ["email.opened"], status: "disabled" }),
    ).toEqual({ ok: true, id: ids.webhook });
    expect(
      await target.createWebhook({ endpoint: "http://plain.example.test", events: ["email.sent"] }),
    ).toMatchObject({ ok: false, status: 422, name: "validation_error" });
    expect(
      await target.createWebhook({
        endpoint: "https://hooks.example.test/c",
        events: ["domain.verified"],
      }),
    ).toMatchObject({ ok: false, status: 422 });
  });

  it("creates and updates templates by alias, 409s a taken alias", async () => {
    ids.template = ok(
      await target.createTemplate({
        name: "Welcome",
        alias: "welcome",
        from: "Acme <hi@acme.dev>",
        reply_to: ["help@acme.dev"],
        subject: "Hi {{{FIRST_NAME|there}}}",
        html: "<p>Welcome</p>",
        text: null,
        variables: [{ key: "plan", type: "string", fallback_value: "free" }],
      }),
    ).id;
    expect(await target.updateTemplate("welcome", { html: "<p>Welcome back</p>" })).toEqual({
      ok: true,
      id: ids.template,
    });
    expect(
      await target.createTemplate({ name: "Welcome 2", alias: "welcome", html: "<p>x</p>" }),
    ).toEqual({
      ok: false,
      status: 409,
      name: "validation_error",
      message: "Template alias already exists",
    });
    expect(await target.updateTemplate("nope", { name: "x" })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("creates a draft broadcast and 422s a missing body", async () => {
    ids.broadcast = ok(
      await target.createBroadcast({
        name: "Launch",
        from: "News <news@acme.dev>",
        subject: "We launched",
        html: "<p>Hello {{{UNSUBSCRIBE_URL}}}</p>",
        replyTo: ["reply@acme.dev"],
        segmentId: ids.segment,
        topicId: ids.topic,
        previewText: null,
      }),
    ).id;
    expect(
      await target.createBroadcast({ from: "news@acme.dev", subject: "No body" }),
    ).toMatchObject({ ok: false, status: 422 });
  });

  it("batch upserts contacts with inline associations, re-runs as updates, records per-item errors", async () => {
    const items = [
      {
        email: "ada@example.com",
        first_name: "Ada",
        unsubscribed: false,
        properties: { plan: "pro", seats: 3 },
        segments: [{ id: ids.segment }],
        topics: [{ id: ids.topic, subscription: "opt_out" as const }],
      },
      { email: "bob@example.com", last_name: "B", unsubscribed: true },
      { email: "not-an-email" },
    ];
    const first = await target.batchContacts(items, { onConflict: "upsert" });
    expect(first.data.map((d) => [d.index, d.status])).toEqual([
      [0, "created"],
      [1, "created"],
    ]);
    expect(first.counts).toEqual({ created: 2, updated: 0, skipped: 0, failed: 1 });
    expect(first.errors).toEqual([
      { index: 2, statusCode: 422, message: expect.stringMatching(/^email: /) },
    ]);
    ids.ada = first.data[0]?.id ?? "";
    ids.bob = first.data[1]?.id ?? "";

    const again = await target.batchContacts(items.slice(0, 2), { onConflict: "upsert" });
    expect(again.data.map((d) => [d.index, d.id, d.status])).toEqual([
      [0, ids.ada, "updated"],
      [1, ids.bob, "updated"],
    ]);
    expect(again.counts).toEqual({ created: 0, updated: 2, skipped: 0, failed: 0 });
    expect(again.errors).toEqual([]);

    const skipped = await target.batchContacts(items.slice(0, 1), { onConflict: "skip" });
    expect(skipped.counts).toEqual({ created: 0, updated: 0, skipped: 1, failed: 0 });

    const addToSegment = await target.addContactsToSegment(ids.filteredSegment, [
      ids.ada,
      "00000000-0000-4000-8000-000000000000",
    ]);
    expect(addToSegment.added).toEqual([ids.ada]);
    expect(addToSegment.errors).toEqual([
      { id: "00000000-0000-4000-8000-000000000000", message: "Contact not found" },
    ]);
  });

  it("looks contacts up by address: case-insensitively, each once, leaving a malformed address out of the request", async () => {
    const before = target.requests;
    const found = await target.findContacts([
      "ADA@example.com",
      "ada@example.com",
      "nobody@example.com",
      "not-an-email",
      "bob@example.com",
    ]);
    // One request for all of them: the malformed address would have made the API refuse the whole batch.
    expect(target.requests - before).toBe(1);
    expect([...found.keys()].sort()).toEqual(["ada@example.com", "bob@example.com"]);
    expect(found.get("ada@example.com")).toEqual({
      firstName: "Ada",
      lastName: null,
      unsubscribed: false,
    });
    expect(found.get("bob@example.com")).toEqual({
      firstName: null,
      lastName: "B",
      unsubscribed: true,
    });
  });

  it("looks up at most 1000 addresses a request, and splits a request the API still refuses until the bad address is alone", async () => {
    const asked: number[] = [];
    const answer: typeof fetch = async (_url, init) => {
      const contacts = (JSON.parse(String(init?.body)) as { contacts: { email: string }[] })
        .contacts;
      asked.push(contacts.length);
      if (contacts.some((c) => c.email === "refused@example.com")) {
        return new Response(JSON.stringify({ name: "validation_error", message: "email" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          object: "list",
          data: contacts
            .filter((c) => c.email.startsWith("known"))
            .map((c) => ({
              email: c.email,
              first_name: null,
              last_name: null,
              unsubscribed: false,
            })),
          missing: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const stub = createBillionSendTarget(
      createHttp({
        baseUrl: "https://api.example.test",
        token: "bs_test",
        userAgent: "billionsend-cli/test",
        rps: 1000,
        name: "BillionSend",
        log,
        fetch: answer,
      }),
      log,
    );
    const emails = Array.from(
      { length: 2500 },
      (_, i) => `${i % 2 === 0 ? "known" : "other"}${i}@example.com`,
    );
    emails[1200] = "refused@example.com";
    const found = await stub.findContacts(emails);
    // 1000 + 1000 + 500 addresses; the middle request is refused and halved down to the one address.
    expect(asked.slice(0, 3)).toEqual([1000, 1000, 500]);
    expect(asked).toContain(1);
    expect(asked.at(-1)).toBe(500);
    expect(found.size).toBe(1250 - 1);
    expect(found.has("known1200@example.com")).toBe(false);
  });

  it("splits contacts into chunks of 1000 with indices over the whole input", async () => {
    const many = Array.from({ length: BATCH_MAX + 2 }, (_, i) => ({
      email: i === BATCH_MAX + 1 ? "broken" : `bulk-${i}@example.com`,
    }));
    const before = target.requests;
    const out = await target.batchContacts(many, { onConflict: "upsert" });
    expect(target.requests - before).toBe(2);
    expect(out.counts).toEqual({ created: BATCH_MAX + 1, updated: 0, skipped: 0, failed: 1 });
    expect(out.data).toHaveLength(BATCH_MAX + 1);
    expect(out.data.at(-1)?.index).toBe(BATCH_MAX);
    expect(out.errors).toEqual([
      { index: BATCH_MAX + 1, statusCode: 422, message: expect.stringMatching(/^email/) },
    ]);
  }, 60_000);

  it("adds suppressions with their origin in one request per 1000 and lists them back", async () => {
    const out = await target.addSuppressions(
      ["bounced@example.com", "Bounced@example.com", "gone@example.com"],
      "bounce",
    );
    expect(out.ids).toHaveLength(2);
    expect(out.errors).toEqual([]);
    ids.suppression = out.ids[0] ?? "";
    ids.suppression2 = out.ids[1] ?? "";

    const bad = await target.addSuppressions(["nope"], "manual");
    expect(bad.ids).toEqual([]);
    expect(bad.errors).toEqual([
      { index: 0, statusCode: 422, message: expect.stringMatching(/emails/) },
    ]);

    const listed = await fetch(`${cloud.baseUrl}/suppressions?origin=bounce`, {
      headers: { authorization: `Bearer ${cloud.apiKey}` },
    });
    const body = (await listed.json()) as {
      data: {
        email: string;
        origin: string;
        kind: string;
        domain: string | null;
        removable: boolean;
      }[];
    };
    expect(body.data.map((s) => s.email).sort()).toEqual([
      "bounced@example.com",
      "gone@example.com",
    ]);
    // Address entries carry the new fields; a bounce is not removable.
    expect(body.data.map((s) => [s.kind, s.domain, s.removable])).toEqual([
      ["email", null, false],
      ["email", null, false],
    ]);
  });

  it("leaves a domain entry on the target alone: it has no address, is not listed with the addresses and is not removed with them", async () => {
    const own = await startContractApi({ slug: "domain-suppression" });
    try {
      const mine = targetFor(own);
      const added = await mine.addSuppressions(["one@example.com"], "manual");
      const domainEntry = await fetch(`${own.baseUrl}/suppressions/batch/add`, {
        method: "POST",
        headers: { authorization: `Bearer ${own.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ domains: ["blocked.example"] }),
      });
      expect(domainEntry.status).toBe(200);
      const domainId = ((await domainEntry.json()) as { data: { id: string }[] }).data[0]?.id;
      expect(domainId).toBeDefined();

      // The ids the migration diffs against are the address entries' only.
      expect(await mine.listSuppressionIds()).toEqual(added.ids);
      const all = await fetch(`${own.baseUrl}/suppressions?kind=all`, {
        headers: { authorization: `Bearer ${own.apiKey}` },
      });
      const rows = ((await all.json()) as { data: { email: string | null; kind: string }[] }).data;
      expect(rows.map((r) => [r.kind, r.email]).sort()).toEqual([
        ["domain", null],
        ["email", "one@example.com"],
      ]);

      const removed = await mine.removeSuppressions(added.ids);
      expect(removed.ids).toEqual(added.ids);
      expect(removed.notRemoved).toEqual([]);
      expect([...own.store.suppressions.values()].map((s) => s.domain)).toEqual([
        "blocked.example",
      ]);
    } finally {
      await own.stop();
    }
  });
});

describe("readState", () => {
  it("lists every resource with domain records and template bodies, paging past 100 rows", async () => {
    for (let i = 0; i < 101; i++) {
      ok(await target.createSegment({ name: `page-${i}` }));
    }
    // A dashboard-created endpoint: events null on the wire means every event.
    const dashboardHook = cloud.store.webhooks.get(ids.webhook2);
    if (dashboardHook) dashboardHook.events = null;
    const state = await target.readState();
    expect(state.usage.plan).toBe("pro");
    expect(state.domains).toEqual([
      {
        id: ids.domain,
        name: "acme.dev",
        region: "us-east-1",
        status: "pending",
        records: expect.arrayContaining([
          expect.objectContaining({ record: "DKIM", type: "CNAME" }),
          expect.objectContaining({ record: "Tracking", name: "track.acme.dev" }),
        ]),
      },
    ]);
    // Oldest first, although the API lists newest first.
    expect(state.properties).toEqual([
      { id: ids.property, key: "plan", type: "string" },
      { id: ids.numberProperty, key: "seats", type: "number" },
    ]);
    expect(state.topics).toEqual([
      {
        id: ids.topic,
        name: "Product news",
        description: "Launches and changelogs",
        defaultSubscription: "opt_in",
      },
      { id: ids.privateTopic, name: "Ops", description: null, defaultSubscription: "opt_out" },
    ]);
    expect(state.segments).toHaveLength(103);
    expect(state.segments.slice(0, 2)).toEqual([
      { id: ids.segment, name: "Paying customers", filter: null },
      expect.objectContaining({ id: ids.filteredSegment, name: "Pro" }),
    ]);
    expect(new Set(state.segments.map((s) => s.id)).size).toBe(103);
    expect(state.webhooks).toEqual([
      {
        id: ids.webhook,
        endpoint: "https://hooks.example.test/a",
        events: ["email.opened"],
        status: "disabled",
      },
      {
        id: ids.webhook2,
        endpoint: "https://hooks.example.test/b",
        events: [...TARGET_ALL_EVENTS],
        status: "enabled",
      },
    ]);
    expect(state.templates).toEqual([
      {
        id: ids.template,
        name: "Welcome",
        alias: "welcome",
        from: "Acme <hi@acme.dev>",
        replyTo: ["help@acme.dev"],
        subject: "Hi {{{FIRST_NAME|there}}}",
        html: "<p>Welcome back</p>",
        text: null,
        variables: [{ key: "plan", type: "string", fallback_value: "free" }],
      },
    ]);
    expect(state.broadcasts).toEqual([{ id: ids.broadcast, name: "Launch", status: "draft" }]);

    // Through the plan: a Resend webhook on every target event matches it, no narrowing PATCH.
    const snapshot: Snapshot = {
      provider: "resend",
      takenAt: "2026-09-01T00:00:00.000Z",
      domains: [],
      apiKeys: [],
      properties: [],
      topics: [],
      segments: [],
      contacts: [],
      broadcasts: [],
      templates: [],
      webhooks: [
        {
          id: "src-b",
          endpoint: "https://hooks.example.test/b",
          events: [...TARGET_ALL_EVENTS],
          status: "enabled",
          signingSecret: null,
        },
      ],
      suppressions: [],
      metrics: { emailsLast30Days: null },
      enriched: false,
      segmentScope: null,
    };
    const plan = buildPlan({
      snapshot,
      target: state,
      options: {
        include: new Set(["webhooks"]),
        only: null,
        skip: [],
        segment: [],
        onConflict: "upsert",
        includeSent: false,
        freshWebhookSecrets: false,
        rps: 8,
        sourceRequestsSpent: 0,
        baseUrl: cloud.baseUrl,
      },
    });
    expect(plan.items).toEqual([
      {
        resource: "webhooks",
        action: "unchanged",
        key: "https://hooks.example.test/b",
        targetId: ids.webhook2,
      },
    ]);
  });
});

describe("rollback deletes", () => {
  it("deletes each created resource once; a second delete is ok:false 404", async () => {
    expect(await target.deleteBroadcast(ids.broadcast)).toEqual({
      ok: true,
      id: ids.broadcast,
    });
    expect(await target.deleteTemplate(ids.template)).toEqual({
      ok: true,
      id: ids.template,
    });
    expect(await target.deleteWebhook(ids.webhook)).toEqual({
      ok: true,
      id: ids.webhook,
    });
    expect(await target.deleteContact(ids.ada)).toEqual({ ok: true, id: ids.ada });
    expect(await target.deleteContact(ids.ada)).toMatchObject({
      ok: false,
      status: 404,
      name: "not_found",
      message: "Contact not found",
    });
    expect(await target.deleteSegment(ids.filteredSegment)).toEqual({
      ok: true,
      id: ids.filteredSegment,
    });
    expect(await target.deleteTopic(ids.privateTopic)).toEqual({
      ok: true,
      id: ids.privateTopic,
    });
    expect(await target.deleteProperty(ids.property)).toEqual({
      ok: true,
      id: ids.property,
    });
    expect(await target.deleteDomain(ids.domain)).toEqual({ ok: true, id: ids.domain });
    expect(await target.deleteDomain(ids.domain)).toMatchObject({
      ok: false,
      status: 404,
    });

    // A bounce entry is permanent: the API leaves it and lists it in not_removed; a manual one goes.
    const manual = await target.addSuppressions(["leaver@example.com"], "manual");
    const removed = await target.removeSuppressions([
      ids.suppression,
      ids.suppression2,
      ...manual.ids,
      "00000000-0000-4000-8000-000000000000",
    ]);
    expect(removed.ids).toEqual(manual.ids);
    expect(removed.notRemoved.map((n) => n.id).sort()).toEqual(
      [ids.suppression, ids.suppression2].sort(),
    );
    expect(removed.notRemoved.every((n) => n.reason === "permanent")).toBe(true);
    expect(removed.errors).toEqual([]);

    const state = await target.readState();
    expect(state.domains).toEqual([]);
    expect(state.templates).toEqual([]);
    expect(state.broadcasts).toEqual([]);
    expect(state.webhooks.map((w) => w.id)).toEqual([ids.webhook2]);
    expect(state.topics.map((t) => t.id)).toEqual([ids.topic]);
    expect(state.properties.map((p) => p.id)).toEqual([ids.numberProperty]);
  });
});

describe("the team's subdomain of the shared inbox domain", () => {
  it("is neither fetched nor counted among the target's domains", async () => {
    const api = await startContractApi({
      slug: "shared-target",
      sharedInboxDomain: "agents.example.test",
    });
    const paths: string[] = [];
    try {
      const shared = createBillionSendTarget(
        createHttp({
          baseUrl: api.baseUrl,
          token: api.apiKey,
          userAgent: "billionsend-cli/test",
          rps: 1000,
          name: "BillionSend",
          log,
          fetch: (input, init) => {
            paths.push(new URL(String(input)).pathname);
            return fetch(input, init);
          },
        }),
        log,
        api.baseUrl,
      );
      const own = ok(await shared.createDomain({ name: "own.example.com" })).id;
      const state = await shared.readState();
      expect(state.domains.map((d) => d.id)).toEqual([own]);
      expect(paths.filter((path) => path.startsWith("/domains/"))).toEqual([`/domains/${own}`]);
    } finally {
      await api.stop();
    }
  });
});

describe("ids in a path", () => {
  it("a slash or a dot-dot in an id cannot reach another route; an empty id is refused before sending", async () => {
    const seen: string[] = [];
    const answer: typeof fetch = async (url, init) => {
      seen.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return new Response(null, { status: 204 });
    };
    const stub = createBillionSendTarget(
      createHttp({
        baseUrl: "https://api.example.test",
        token: "bs_test",
        userAgent: "billionsend-cli/test",
        rps: 1000,
        name: "BillionSend",
        log,
        fetch: answer,
      }),
      log,
    );
    // A 204 with no body is a success that names the id it deleted.
    expect(await stub.deleteTopic("../domains/abc")).toEqual({ ok: true, id: "../domains/abc" });
    expect(await stub.deleteContact("c1")).toEqual({ ok: true, id: "c1" });
    expect(seen).toEqual(["DELETE /topics/..%2Fdomains%2Fabc", "DELETE /contacts/c1"]);
    await expect(stub.deleteTopic("..")).rejects.toThrow("an id is missing or not an id");
    await expect(stub.deleteTemplate("")).rejects.toThrow("an id is missing or not an id");
    expect(seen).toHaveLength(2);
  });
});

describe("a write the server answered with a 5xx", () => {
  /** A target whose API answers every request with 503, counting what it was sent. */
  function down() {
    const seen: string[] = [];
    const answer: typeof fetch = async (url, init) => {
      seen.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return new Response(JSON.stringify({ name: "internal_error", message: "down" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    };
    const stub = createBillionSendTarget(
      createHttp({
        baseUrl: "https://api.example.test",
        token: "bs_test",
        userAgent: "billionsend-cli/test",
        rps: 1000,
        name: "BillionSend",
        log,
        fetch: answer,
        maxAttempts: 3,
      }),
      log,
    );
    return { stub, seen };
  }

  it("is sent once and recorded as failed, never repeated: a webhook, a template and a contacts batch", async () => {
    const { stub, seen } = down();
    const webhook = await stub.createWebhook({
      endpoint: "https://hooks.example.test/x",
      events: ["email.sent"],
    });
    expect(webhook).toMatchObject({ ok: false, status: 503 });
    expect(await stub.createTemplate({ name: "T", html: "<p>x</p>" })).toMatchObject({
      ok: false,
      status: 503,
    });
    const batch = await stub.batchContacts(
      [{ email: "a@example.com" }, { email: "b@example.com" }],
      {
        onConflict: "upsert",
      },
    );
    expect(batch.counts.failed).toBe(2);
    expect(batch.errors.map((e) => e.statusCode)).toEqual([503, 503]);
    expect(seen).toEqual(["POST /webhooks", "POST /templates", "POST /contacts/batch"]);
    expect(webhook).toMatchObject({
      message: expect.stringContaining("it is not sent again, because it may have been written"),
    });
  });

  it("a lost connection on a write is recorded the same way, with status 0", async () => {
    const seen: string[] = [];
    const lost: typeof fetch = async (url, init) => {
      seen.push(`${init?.method} ${new URL(String(url)).pathname}`);
      throw new TypeError("fetch failed");
    };
    const stub = createBillionSendTarget(
      createHttp({
        baseUrl: "https://api.example.test",
        token: "bs_test",
        userAgent: "billionsend-cli/test",
        rps: 1000,
        name: "BillionSend",
        log,
        fetch: lost,
      }),
      log,
    );
    expect(await stub.createTopic({ name: "News", defaultSubscription: "opt_in" })).toMatchObject({
      ok: false,
      status: 0,
      name: "network_error",
    });
    expect(seen).toEqual(["POST /topics"]);
  });

  it("a read and a delete are tried again, and so is the lookup of contacts, which only reads", async () => {
    vi.useFakeTimers();
    try {
      const { stub, seen } = down();
      const deleted = stub.deleteContact("00000000-0000-4000-8000-000000000000");
      deleted.catch(() => {});
      await vi.runAllTimersAsync();
      const found = stub.findContacts(["a@example.com"]);
      found.catch(() => {});
      await vi.runAllTimersAsync();
      expect(seen).toEqual([
        "DELETE /contacts/00000000-0000-4000-8000-000000000000",
        "DELETE /contacts/00000000-0000-4000-8000-000000000000",
        "DELETE /contacts/00000000-0000-4000-8000-000000000000",
        "POST /contacts/batch/get",
        "POST /contacts/batch/get",
        "POST /contacts/batch/get",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
