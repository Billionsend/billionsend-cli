import { afterEach, describe, expect, it } from "vitest";
import { createHttp } from "../src/http.js";
import { createLogger } from "../src/log.js";
import { USER_AGENT } from "../src/meta.js";
import { RESOURCES } from "../src/model.js";
import { createResendSource, selectSegments } from "../src/providers/resend.js";
import {
  type FakeResend,
  type FakeResendData,
  loadFixtures,
  startFakeResend,
} from "./helpers/fake-resend.js";

/*
 * The source's answers are not always complete: a field a plan or an older account never sets is
 * missing, not null. Each one is read as its documented default, never as a crash or an invented value.
 */

let fake: FakeResend | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const log = createLogger({ level: "error" });

async function sourceOf(data: FakeResendData) {
  fake = await startFakeResend(data);
  const http = createHttp({
    baseUrl: fake.url,
    token: fake.token,
    userAgent: USER_AGENT,
    rps: 1000,
    name: "Resend",
    log,
    readOnly: true,
  });
  return createResendSource(http, log);
}

const empty = (): FakeResendData => ({
  ...loadFixtures(),
  domains: [],
  api_keys: [],
  contact_properties: [],
  topics: [],
  segments: [],
  contacts: [],
  broadcasts: [],
  templates: [],
  webhooks: [],
  suppressions: [],
  metrics: null,
});

describe("rows with only the fields that are always there", () => {
  it("read as the defaults the CLI documents", async () => {
    const data = empty();
    data.domains = [{ id: "d1", name: "bare.example", records: [{}] }];
    data.contact_properties = [{ id: "p1", key: "k", type: "string" }];
    data.topics = [{ id: "t1", name: "T" }];
    data.segments = [{ id: "s1", name: "S", member_ids: ["c1"] }];
    data.contacts = [
      {
        id: "c1",
        email: "a@example.com",
        properties: {
          flag: true,
          count: 3,
          nothing: null,
          wrapped: { value: "x", type: "string" },
        },
        topics: [{ id: "t1", name: "T", description: null, subscription: undefined as never }],
      },
    ];
    data.broadcasts = [{ id: "b1" }];
    data.templates = [
      {
        id: "tp1",
        name: "N",
        variables: [
          { key: "n", type: "number", fallback_value: 3 },
          { key: "o", type: "string", fallback_value: { a: 1 } },
          { key: "z", type: "string", fallback_value: null },
        ],
      },
    ];
    data.webhooks = [{ id: "w1", endpoint: "https://hooks.example.test/x" }];
    data.suppressions = [{ id: "x1", email: "x@example.com" }];
    const src = await sourceOf(data);
    const snapshot = await src.readShallow({ include: new Set(RESOURCES), includeSent: true });
    expect(snapshot.domains[0]).toMatchObject({
      name: "bare.example",
      region: "us-east-1",
      status: "unknown",
      openTracking: false,
      trackingSubdomain: null,
      records: [{ record: "", name: "", type: "", value: "" }],
    });
    expect(snapshot.topics[0]).toMatchObject({ defaultSubscription: "opt_in" });
    expect(snapshot.broadcasts[0]).toMatchObject({
      name: "",
      from: "",
      subject: "",
      status: "draft",
    });
    expect(snapshot.templates[0]).toMatchObject({
      subject: null,
      html: null,
      text: null,
      variables: [
        { key: "n", fallbackValue: 3 },
        { key: "o", fallbackValue: '{"a":1}' },
        { key: "z", fallbackValue: null },
      ],
    });
    expect(snapshot.webhooks[0]).toMatchObject({
      events: [],
      status: "enabled",
      signingSecret: null,
    });
    expect(snapshot.suppressions[0]).toMatchObject({ origin: "manual", createdAt: "" });

    const enriched = await src.enrichContacts(snapshot, {
      alreadyDone: new Set(),
      facets: ["properties", "topics"],
      onContact: async () => {},
    });
    expect(enriched.contacts[0]?.properties).toEqual({ flag: "true", count: 3 });
    expect(enriched.contacts[0]?.topics).toEqual([{ id: "t1", subscription: "opt_in" }]);
    // No metrics endpoint on this account: unknown, not zero.
    expect(await src.readMetrics()).toEqual({ emailsLast30Days: null });
  });

  it("an account with nothing to name has no team hint, and a sent total that is not a number is unknown", async () => {
    const data = empty();
    data.metrics = { sent: "many" as never };
    const src = await sourceOf(data);
    expect(await src.probe()).toEqual({ ok: true });
    expect(await src.readMetrics()).toEqual({ emailsLast30Days: null });
  });

  it("a list without has_more goes on while pages are full and stops at a short one", async () => {
    const data = empty();
    data.topics = [{ id: "t1", name: "T" }];
    const src = await sourceOf(data);
    fake?.injectOnce("/topics", {
      status: 200,
      body: { object: "list", data: [{ id: "t1", name: "T" }] },
    });
    const snapshot = await src.readShallow({ include: new Set(["topics"]) });
    expect(snapshot.topics.map((t) => t.name)).toEqual(["T"]);
  });

  it("a detail answer that leaves out what the list carried falls back to the list's values", async () => {
    const data = empty();
    data.segments = [{ id: "s1", name: "From the list" }];
    data.webhooks = [
      {
        id: "w1",
        endpoint: "https://hooks.example.test/x",
        events: ["email.sent"],
        status: "disabled",
      },
    ];
    const src = await sourceOf(data);
    fake?.injectOnce("/segments/s1", { status: 200, body: { id: "s1" } });
    fake?.injectOnce("/webhooks/w1", { status: 200, body: { id: "w1" } });
    const snapshot = await src.readShallow({ include: new Set(["segments", "webhooks"]) });
    expect(snapshot.segments[0]).toMatchObject({ name: "From the list", filter: null });
    expect(snapshot.webhooks[0]).toMatchObject({
      endpoint: "https://hooks.example.test/x",
      events: ["email.sent"],
      status: "disabled",
    });
  });

  it("contacts in two chosen segments are read once", async () => {
    const data = empty();
    data.segments = [
      { id: "s1", name: "One", member_ids: ["c1", "c2"] },
      { id: "s2", name: "Two", member_ids: ["c2", "c3"] },
    ];
    data.contacts = ["c1", "c2", "c3"].map((id) => ({ id, email: `${id}@example.com` }));
    const src = await sourceOf(data);
    const snapshot = await src.readShallow({
      include: new Set(["contacts", "segments"]),
      segments: ["One", "Two"],
    });
    expect(snapshot.contacts.map((c) => c.email)).toEqual([
      "c1@example.com",
      "c2@example.com",
      "c3@example.com",
    ]);
  });
});

describe("a wrong segment name on a big account", () => {
  it("lists the first 30 segments and says how many more there are", () => {
    const all = Array.from({ length: 35 }, (_, i) => ({ id: `id-${i}`, name: `Segment ${i}` }));
    expect(() => selectSegments(all, ["nope"])).toThrow(
      /\n {2}Segment 29 {2}\(id-29\)\n {2}… and 5 more$/,
    );
  });
});
