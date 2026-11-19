import { describe, expect, it } from "vitest";
import type { SourceBroadcast, SourceDomain, SourceTemplate } from "../src/model.js";
import {
  broadcastCreateInput,
  domainCreateInput,
  TARGET_ALL_EVENTS,
  TARGET_RETURN_PATH,
  TARGET_RETURN_PATH_FALLBACK,
  templateCreateInput,
  translateMergeTags,
  translateSegmentFilter,
  translateWebhookEvents,
} from "../src/translate.js";

describe("translateMergeTags", () => {
  it.each([
    ["{{{contact.first_name|there}}}", "{{{FIRST_NAME|there}}}"],
    ["{{{contact.last_name}}}", "{{{LAST_NAME}}}"],
    ["{{{contact.email}}}", "{{{EMAIL}}}"],
    ["{{{contact.company|Acme}}}", "{{{company|Acme}}}"],
    ["{{{ contact.first_name |there}}}", "{{{FIRST_NAME|there}}}"],
    ["{{{RESEND_UNSUBSCRIBE_URL}}}", "{{{RESEND_UNSUBSCRIBE_URL}}}"],
    ["{{{unsubscribe_url}}}", "{{{UNSUBSCRIBE_URL}}}"],
    ["{{{UNSUBSCRIBE_URL}}}", "{{{UNSUBSCRIBE_URL}}}"],
    ["{{{FIRST_NAME|there}}}", "{{{FIRST_NAME|there}}}"],
    ["{{{order_id}}}", "{{{order_id}}}"],
    ["no tokens", "no tokens"],
  ])("%s → %s", (input, expected) => {
    expect(translateMergeTags(input)).toEqual({ html: expected, untranslated: [] });
  });

  it.each([
    ["{{{foo bar}}}"],
    ["{{{contact.first-name}}}"],
    ["{{{contact.address.city}}}"],
    ["{{{FIRST_NAME|a{b}}}"],
    ["{{{}}}"],
  ])("leaves %s as-is and reports it", (token) => {
    const html = `<p>${token}</p>`;
    expect(translateMergeTags(html)).toEqual({ html, untranslated: [token] });
  });

  it("translates every token in a document and reports each bad one once", () => {
    const { html, untranslated } = translateMergeTags(
      "Hi {{{contact.first_name|there}}}, {{{foo bar}}} {{{contact.company}}} {{{foo bar}}}",
    );
    expect(html).toBe("Hi {{{FIRST_NAME|there}}}, {{{foo bar}}} {{{company}}} {{{foo bar}}}");
    expect(untranslated).toEqual(["{{{foo bar}}}"]);
  });
});

describe("translateSegmentFilter", () => {
  it.each([
    [
      "Resend-style operator/conditions",
      {
        operator: "and",
        conditions: [{ field: "email", operator: "ends_with", value: "@example.com" }],
      },
      { match: "all", conditions: [{ field: "email", op: "ends_with", value: "@example.com" }] },
    ],
    [
      "already the target shape",
      { match: "any", conditions: [{ field: "first_name", op: "is_set", value: null }] },
      { match: "any", conditions: [{ field: "first_name", op: "is_set", value: null }] },
    ],
    [
      "or + property prefix + operator aliases",
      {
        operator: "or",
        conditions: [
          { field: "properties.plan", operator: "eq", value: "pro" },
          { field: "property:seats", operator: "exists" },
          { field: "contact.city", operator: "is_empty", value: "ignored" },
        ],
      },
      {
        match: "any",
        conditions: [
          { field: "property:plan", op: "equals", value: "pro" },
          { field: "property:seats", op: "is_set", value: null },
          { field: "property:city", op: "is_not_set", value: null },
        ],
      },
    ],
    [
      "unsubscribed and created_at",
      {
        conditions: [
          { field: "unsubscribed", operator: "equals", value: true },
          { field: "unsubscribed", operator: "is_false" },
          { field: "created_at", operator: "gt", value: "2024-01-01T00:00:00Z" },
        ],
      },
      {
        match: "all",
        conditions: [
          { field: "unsubscribed", op: "is_true", value: null },
          { field: "unsubscribed", op: "is_false", value: null },
          { field: "created_at", op: "after", value: "2024-01-01T00:00:00Z" },
        ],
      },
    ],
    [
      "numeric values become strings",
      { conditions: [{ field: "properties.seats", operator: "equals", value: 5 }] },
      {
        match: "all",
        conditions: [{ field: "property:seats", op: "equals", value: "5" }],
      },
    ],
  ])("maps %s", (_label, input, expected) => {
    expect(translateSegmentFilter(input)).toEqual({ filter: expected, reason: null });
  });

  it.each([
    [null, "filter is not an object"],
    ["x", "filter is not an object"],
    [{ operator: "xor", conditions: [] }, 'unknown match mode "xor"'],
    [{ operator: "and" }, "filter has no conditions"],
    [{ conditions: [{ operator: "equals", value: "x" }] }, "unsupported condition without a field"],
    [
      { conditions: [{ field: "email", value: "x" }] },
      'unsupported condition on "email" without an operator',
    ],
    [
      { conditions: [{ field: "plan_tier", operator: "equals", value: "enterprise" }] },
      'unsupported field "plan_tier"',
    ],
    [
      { conditions: [{ field: "email", operator: "regex", value: "x" }] },
      'unsupported operator "regex" on "email"',
    ],
    [
      { conditions: [{ field: "email", operator: "equals" }] },
      'unsupported operator "equals" on "email" needs a value',
    ],
    [
      { conditions: [{ field: "unsubscribed", operator: "contains", value: "x" }] },
      'unsupported operator "contains" on "unsubscribed"',
    ],
    [
      { conditions: [{ field: "created_at", operator: "before", value: "yesterday" }] },
      'unsupported operator "before" on "created_at" needs an ISO date',
    ],
  ])("rejects %j", (input, reason) => {
    expect(translateSegmentFilter(input)).toEqual({ filter: null, reason });
  });
});

describe("translateWebhookEvents", () => {
  it("keeps the target's events in order, deduplicated, and reports the rest", () => {
    expect(
      translateWebhookEvents([
        "email.sent",
        "template.created",
        "email.sent",
        "audience.created",
        "email.clicked",
        "email.received",
        "contact.created",
      ]),
    ).toEqual({
      events: ["email.sent", "email.clicked", "email.received", "contact.created"],
      dropped: ["template.created", "audience.created"],
    });
  });

  it("accepts every event the target emits", () => {
    const all = [
      "email.scheduled",
      "email.sent",
      "email.delivered",
      "email.delivery_delayed",
      "email.bounced",
      "email.complained",
      "email.failed",
      "email.suppressed",
      "email.opened",
      "email.clicked",
      "email.received",
      "contact.created",
      "contact.updated",
      "contact.deleted",
      "contact.topics.updated",
      "suppression.added",
      "suppression.removed",
      "domain.created",
      "domain.updated",
      "domain.deleted",
      "topic.created",
      "topic.updated",
      "topic.deleted",
    ];
    expect(translateWebhookEvents(all)).toEqual({ events: all, dropped: [] });
  });

  it("carries Resend's inbox events over, assignment included, and drops names BillionSend has no event for", () => {
    expect(
      translateWebhookEvents([
        "inbox.email.received",
        "inbox.thread.assigned",
        "inbox.thread.unassigned",
        "inbox.thread.archived",
        "inbox.draft.sent",
      ]),
    ).toEqual({
      events: [
        "inbox.email.received",
        "inbox.thread.assigned",
        "inbox.thread.unassigned",
        "inbox.draft.sent",
      ],
      dropped: ["inbox.thread.archived"],
    });
  });

  it("reads an endpoint on every event as every event but the opt-in inbox ones", () => {
    expect(TARGET_ALL_EVENTS).toContain("email.received");
    expect(TARGET_ALL_EVENTS.some((event) => event.startsWith("inbox."))).toBe(false);
  });
});

const domain = (overrides: Partial<SourceDomain> = {}): SourceDomain => ({
  name: "example.com",
  region: "us-east-1",
  openTracking: true,
  clickTracking: false,
  trackingSubdomain: null,
  customReturnPath: null,
  records: [
    { record: "SPF", name: "send", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com" },
    { record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=..." },
  ],
  status: "verified",
  ...overrides,
});

describe("domainCreateInput", () => {
  it("gives BillionSend `bounce` when Resend uses the default send label", () => {
    expect(domainCreateInput(domain())).toEqual({
      input: { name: "example.com", custom_return_path: "bounce" },
      tracking: { open_tracking: true, click_tracking: false },
      sourceReturnPath: "send",
    });
  });

  it("treats a domain whose label cannot be read as Resend's default send", () => {
    const d = domain({ records: [] });
    expect(domainCreateInput(d)).toMatchObject({
      input: { custom_return_path: "bounce" },
      sourceReturnPath: "send",
    });
  });

  it.each([
    ["bounces", "bounces"],
    ["bounces.updates", "bounces"],
    ["bounces.updates.example.com", "bounces"],
    ["Bounces", "bounces"],
    ["send.updates", "send"],
  ])(
    "takes Resend's return-path label from the SPF record name %s and never reuses it",
    (name, label) => {
      const d = domain({
        name: "updates.example.com",
        records: [{ record: "SPF", name, type: "MX", value: "x" }],
      });
      expect(domainCreateInput(d)).toMatchObject({
        input: { name: "updates.example.com", custom_return_path: "bounce" },
        sourceReturnPath: label,
      });
    },
  );

  it("uses the fixed fallback when Resend's own label is already bounce, in any case", () => {
    for (const name of ["bounce", "Bounce.updates"]) {
      const d = domain({ records: [{ record: "SPF", name, type: "MX", value: "x" }] });
      expect(domainCreateInput(d)).toMatchObject({
        input: { custom_return_path: TARGET_RETURN_PATH_FALLBACK },
        sourceReturnPath: "bounce",
      });
    }
    expect(TARGET_RETURN_PATH_FALLBACK).not.toBe(TARGET_RETURN_PATH);
  });

  it("prefers an explicit customReturnPath and carries the tracking subdomain", () => {
    const d = domain({ customReturnPath: "mail", trackingSubdomain: "track" });
    expect(domainCreateInput(d)).toEqual({
      input: { name: "example.com", custom_return_path: "bounce" },
      tracking: { open_tracking: true, click_tracking: false, tracking_subdomain: "track" },
      sourceReturnPath: "mail",
    });
    expect(domainCreateInput(domain({ customReturnPath: "bounce" })).input.custom_return_path).toBe(
      "bounces",
    );
  });

  it("never forwards the source region: the target provisions in the region it serves", () => {
    expect(domainCreateInput(domain({ region: "ap-south-1" })).input).toEqual({
      name: "example.com",
      custom_return_path: "bounce",
    });
  });
});

const template = (overrides: Partial<SourceTemplate> = {}): SourceTemplate => ({
  id: "t1",
  name: "Welcome",
  alias: "welcome",
  from: null,
  subject: "Hi {{{contact.first_name|friend}}}",
  replyTo: null,
  html: "<h1>{{{contact.first_name}}}</h1>",
  text: "{{{contact.first_name}}}",
  variables: [],
  ...overrides,
});

describe("templateCreateInput", () => {
  it("translates merge tags in subject, html and text", () => {
    expect(templateCreateInput(template())).toEqual({
      input: {
        name: "Welcome",
        alias: "welcome",
        subject: "Hi {{{FIRST_NAME|friend}}}",
        html: "<h1>{{{FIRST_NAME}}}</h1>",
        text: "{{{FIRST_NAME}}}",
      },
      notes: [],
      reason: null,
    });
  });

  it("carries from, reply_to and variables over and notes variables it cannot store and untranslatable tags", () => {
    const t = template({
      alias: null,
      from: "Acme <hi@example.com>",
      replyTo: ["a@example.com", "b@example.com"],
      html: "<p>{{{foo bar}}}</p>",
      text: null,
      subject: null,
      variables: [
        { key: "first_name", type: "string", fallbackValue: "friend" },
        { key: "items", type: "list" },
        { key: "bad key", type: "string" },
      ],
    });
    expect(templateCreateInput(t)).toEqual({
      input: {
        name: "Welcome",
        from: "Acme <hi@example.com>",
        reply_to: ["a@example.com", "b@example.com"],
        html: "<p>{{{foo bar}}}</p>",
        variables: [{ key: "first_name", type: "string", fallback_value: "friend" }],
      },
      notes: [
        "variables bad key not stored: a key is 1–50 letters, digits or underscores",
        "variables items (list) not stored: BillionSend variables are strings or numbers",
        "merge tags left as-is: {{{foo bar}}}",
      ],
      reason: null,
    });
  });

  it("keeps the first 50 of a longer Reply-To list and variable list, and says so", () => {
    const t = template({
      replyTo: Array.from({ length: 52 }, (_, i) => `r${i}@example.com`),
      variables: Array.from({ length: 51 }, (_, i) => ({ key: `v${i}`, type: "string" })),
    });
    const { input, notes } = templateCreateInput(t);
    expect(input?.reply_to).toHaveLength(50);
    expect(input?.variables).toHaveLength(50);
    expect(notes).toEqual([
      "reply_to has 52 addresses; a template stores 50, the first 50 were kept",
      "51 variables; a template stores 50, the first 50 were kept",
    ]);
  });

  it("refuses a template without html", () => {
    expect(templateCreateInput(template({ html: null }))).toEqual({
      input: null,
      notes: [],
      reason: "template has no html body",
    });
  });
});

const broadcast = (overrides: Partial<SourceBroadcast> = {}): SourceBroadcast => ({
  id: "b1",
  name: "News",
  from: "Acme <news@example.com>",
  subject: "Hello {{{contact.first_name|there}}}",
  replyTo: null,
  previewText: null,
  html: "<p>{{{contact.first_name}}} {{{RESEND_UNSUBSCRIBE_URL}}}</p>",
  text: null,
  status: "draft",
  segmentId: null,
  topicId: null,
  scheduledAt: null,
  ...overrides,
});

describe("broadcastCreateInput", () => {
  it("builds a draft with translated tags and the given ids", () => {
    expect(broadcastCreateInput(broadcast(), { segmentId: "s1", topicId: "t1" })).toEqual({
      input: {
        name: "News",
        from: "Acme <news@example.com>",
        subject: "Hello {{{FIRST_NAME|there}}}",
        html: "<p>{{{FIRST_NAME}}} {{{RESEND_UNSUBSCRIBE_URL}}}</p>",
        segment_id: "s1",
        topic_id: "t1",
      },
      notes: [],
      reason: null,
    });
  });

  it.each([
    [
      { status: "scheduled", scheduledAt: "2026-09-15T10:00:00.000Z" },
      "scheduled on Resend for 2026-09-15T10:00:00.000Z; imported as a draft — schedule it again",
    ],
    [{ status: "sent" }, "already sent on Resend; imported as a draft"],
    [{ status: "queued" }, "status queued on Resend; imported as a draft"],
  ])("notes the status %j", (overrides, note) => {
    const { input, notes } = broadcastCreateInput(broadcast(overrides), {
      segmentId: null,
      topicId: null,
    });
    expect(input).not.toBeNull();
    expect(notes).toEqual([note]);
  });

  it("carries reply_to, preview_text and text; notes untranslatable tags", () => {
    const b = broadcast({
      html: null,
      text: "Hi {{{contact.first_name}}} {{{x y}}}",
      replyTo: ["r@example.com"],
      previewText: "Preview",
    });
    expect(broadcastCreateInput(b, { segmentId: null, topicId: null })).toEqual({
      input: {
        name: "News",
        from: "Acme <news@example.com>",
        subject: "Hello {{{FIRST_NAME|there}}}",
        text: "Hi {{{FIRST_NAME}}} {{{x y}}}",
        reply_to: ["r@example.com"],
        preview_text: "Preview",
      },
      notes: ["merge tags left as-is: {{{x y}}}"],
      reason: null,
    });
  });

  it("refuses a broadcast without a body", () => {
    expect(
      broadcastCreateInput(broadcast({ html: null, text: null }), {
        segmentId: null,
        topicId: null,
      }),
    ).toEqual({ input: null, notes: [], reason: "broadcast has no body" });
  });
});
