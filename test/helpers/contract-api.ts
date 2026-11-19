import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  checkComponent,
  checkRequest,
  checkResponse,
  type MatchedOperation,
  matchOperation,
} from "./openapi-contract.js";

/*
 * An in-memory BillionSend API for the CLI's tests, held to the published
 * OpenAPI document. Every request is matched to a documented operation and
 * checked against its parameters and body; every answer is checked against
 * the documented status and schema. Anything off the contract (an
 * undocumented path or query parameter, an answer the document does not
 * describe) is a violation, and test/setup.ts fails the test that caused it.
 *
 * The behaviour behind the shapes (upsert rules, plan refusals, error names
 * and messages) follows the API as documented in each operation's
 * description; it is a stand-in, not the service. A rule the document does
 * not state is marked where it is kept.
 */

export type Plan = "free" | "starter" | "pro" | "scale";
export type Permission = "full_access" | "sending_access";

export interface ContactRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  unsubscribed: boolean;
  properties: Record<string, string>;
  createdAt: string;
}

export interface DomainRow {
  id: string;
  name: string;
  region: string;
  status: string;
  customReturnPath: string;
  openTracking: boolean;
  clickTracking: boolean;
  trackingSubdomain: string | null;
  unsubscribeSubdomain: string | null;
  shared: boolean;
  createdAt: string;
}

export interface SuppressionRow {
  id: string;
  /** Null on a domain entry. */
  email: string | null;
  /** Set on a domain entry: every address at this exact domain. */
  domain?: string;
  origin: "bounce" | "complaint" | "manual";
  createdAt: string;
}

export interface Store {
  contacts: Map<string, ContactRow>;
  contactProperties: Map<
    string,
    {
      id: string;
      key: string;
      type: "string" | "number";
      fallback: string | number | null;
      createdAt: string;
    }
  >;
  topics: Map<
    string,
    {
      id: string;
      name: string;
      description: string | undefined;
      defaultSubscription: "opt_in" | "opt_out";
      visibility: "private" | "public";
      createdAt: string;
    }
  >;
  segments: Map<
    string,
    { id: string; name: string; filter: SegmentFilter | null; createdAt: string }
  >;
  /** `${segmentId}:${contactId}` */
  segmentMembers: Set<string>;
  /** contactId → topicId → subscribed */
  topicSubscriptions: Map<string, Map<string, boolean>>;
  domains: Map<string, DomainRow>;
  webhooks: Map<
    string,
    {
      id: string;
      endpoint: string;
      events: string[] | null;
      status: "enabled" | "disabled";
      secret: string;
      createdAt: string;
    }
  >;
  templates: Map<
    string,
    {
      id: string;
      name: string;
      alias: string | null;
      from: string | null;
      replyTo: string[] | null;
      subject: string | null;
      html: string;
      text: string | null;
      variables: {
        key: string;
        type: "string" | "number";
        fallback_value: string | number | null;
        created_at: string;
        updated_at: string;
      }[];
      createdAt: string;
      updatedAt: string;
    }
  >;
  broadcasts: Map<
    string,
    {
      id: string;
      name: string | null;
      segmentId: string | null;
      topicId: string | null;
      from: string;
      subject: string;
      replyTo: string[] | null;
      previewText: string | null;
      html: string | null;
      text: string | null;
      status: string;
      createdAt: string;
    }
  >;
  suppressions: Map<string, SuppressionRow>;
}

interface SegmentFilter {
  match: "all" | "any";
  conditions: { field: string; op: string; value: string | null }[];
}

export interface ContractApi {
  /** http://127.0.0.1:<ephemeral port> */
  baseUrl: string;
  /** Full-access key of the team. */
  apiKey: string;
  store: Store;
  /** Requests or answers off the published contract; test/setup.ts fails a test that leaves any. */
  violations: string[];
  /** Every (METHOD, template) this instance served, for the coverage test. */
  served: Set<string>;
  /** The JSON body of each request as it arrived, with the `METHOD template` it matched. */
  bodies: { operation: string; body: unknown }[];
  createApiKey(permission?: Permission): string;
  /** The number of rows in one store table; topic subscriptions count one per (contact, topic). */
  count(table: keyof Store): number;
  stop(): Promise<void>;
}

const live = new Set<ContractApi>();

/** Violations of every contract API still running; reading them clears them. */
export function takeViolations(): string[] {
  const out: string[] = [];
  for (const api of live) out.push(...api.violations.splice(0));
  return out;
}

const TEXT_OPS = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "ends_with",
  "is_set",
  "is_not_set",
];
const TOPIC_NAME_MAX = 50;

/** Plan limits as GET /usage reports them (null = unlimited). */
const PLAN_LIMITS: Record<
  Plan,
  {
    emailsPerDay: number | null;
    emailsPerMonth: number | null;
    domains: number | null;
    contacts: number | null;
    webhookEndpoints: number | null;
  }
> = {
  free: {
    emailsPerDay: 100,
    emailsPerMonth: null,
    domains: 3,
    contacts: 1000,
    webhookEndpoints: 1,
  },
  starter: {
    emailsPerDay: null,
    emailsPerMonth: 20_000,
    domains: 10,
    contacts: null,
    webhookEndpoints: null,
  },
  pro: {
    emailsPerDay: null,
    emailsPerMonth: 60_000,
    domains: null,
    contacts: null,
    webhookEndpoints: null,
  },
  scale: {
    emailsPerDay: null,
    emailsPerMonth: 200_000,
    domains: null,
    contacts: null,
    webhookEndpoints: null,
  },
};

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Consumer mailbox providers the API refuses as a domain suppression. */
const PUBLIC_MAILBOX_DOMAINS = new Set(["gmail.com", "outlook.com", "yahoo.com"]);
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

class HttpError {
  constructor(
    readonly status: number,
    readonly name: string,
    readonly message: string,
  ) {}
}
const fail = (status: number, name: string, message: string): never => {
  throw new HttpError(status, name, message);
};
const notFound = (what: string): never => fail(404, "not_found", `${what} not found`);

export async function startContractApi(
  options: { plan?: Plan; sharedInboxDomain?: string; slug?: string } = {},
): Promise<ContractApi> {
  const plan = options.plan ?? "pro";
  const limits = PLAN_LIMITS[plan];
  const keys = new Map<string, Permission>();
  const mintKey = (permission: Permission = "full_access") => {
    const token = `bs_${randomBytes(18).toString("base64url")}`;
    keys.set(token, permission);
    return token;
  };
  const apiKey = mintKey();

  const store: Store = {
    contacts: new Map(),
    contactProperties: new Map(),
    topics: new Map(),
    segments: new Map(),
    segmentMembers: new Set(),
    topicSubscriptions: new Map(),
    domains: new Map(),
    webhooks: new Map(),
    templates: new Map(),
    broadcasts: new Map(),
    suppressions: new Map(),
  };
  const violations: string[] = [];
  const served = new Set<string>();
  const bodies: { operation: string; body: unknown }[] = [];

  // A strictly increasing clock: list order and "oldest first" must not hinge on two rows sharing a millisecond.
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  const now = () => {
    tick += 1;
    return new Date(tick).toISOString();
  };

  if (options.sharedInboxDomain) {
    const id = randomUUID();
    store.domains.set(id, {
      id,
      name: `${options.slug ?? "team"}.${options.sharedInboxDomain}`,
      region: "us-east-1",
      status: "verified",
      customReturnPath: "send",
      openTracking: false,
      clickTracking: false,
      trackingSubdomain: null,
      unsubscribeSubdomain: null,
      shared: true,
      createdAt: now(),
    });
  }

  // ---------- wire shapes ----------

  const listPage = <T extends { id: string; createdAt: string }>(
    rows: Iterable<T>,
    url: URL,
    wire: (row: T) => unknown,
  ) => {
    // Newest first; `after` pages toward older rows, `before` toward newer ones.
    const sorted = [...rows].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");
    let start = 0;
    let end = sorted.length;
    if (after) {
      const i = sorted.findIndex((r) => r.id === after);
      if (i < 0) fail(404, "not_found", "Pagination cursor not found");
      start = i + 1;
    }
    if (before) {
      const i = sorted.findIndex((r) => r.id === before);
      if (i < 0) fail(404, "not_found", "Pagination cursor not found");
      end = i;
      start = Math.max(0, end - limit);
    }
    const page = sorted.slice(start, Math.min(end, start + limit));
    return { object: "list", data: page.map(wire), has_more: start + page.length < end };
  };

  const records = (d: DomainRow) => {
    const rows: Record<string, unknown>[] = [
      ...[1, 2, 3].map((n) => ({
        record: "DKIM",
        name: `bs${n}._domainkey.${d.name}`,
        type: "CNAME",
        ttl: "Auto",
        status: "not_started",
        value: `bs${n}.${d.id.slice(0, 8)}.dkim.billionsend-dns.com`,
      })),
      {
        record: "SPF",
        name: `${d.customReturnPath}.${d.name}`,
        type: "MX",
        ttl: "Auto",
        status: "not_started",
        value: `feedback-smtp.${d.region}.amazonses.com`,
        priority: 10,
      },
      {
        record: "SPF",
        name: `${d.customReturnPath}.${d.name}`,
        type: "TXT",
        ttl: "Auto",
        status: "not_started",
        value: "v=spf1 include:amazonses.com ~all",
      },
      {
        record: "DMARC",
        name: `_dmarc.${d.name}`,
        type: "TXT",
        ttl: "Auto",
        status: "not_started",
        value: "v=DMARC1; p=none;",
      },
    ];
    if (d.trackingSubdomain) {
      rows.push({
        record: "Tracking",
        name: `${d.trackingSubdomain}.${d.name}`,
        type: "CNAME",
        ttl: "Auto",
        status: "not_started",
        value: "t.billiondns.com",
      });
    }
    if (d.unsubscribeSubdomain) {
      rows.push({
        record: "Unsubscribe",
        name: `${d.unsubscribeSubdomain}.${d.name}`,
        type: "CNAME",
        ttl: "Auto",
        status: "not_started",
        value: "u.billiondns.com",
      });
    }
    return rows;
  };

  const suppressionItem = (s: SuppressionRow) => ({
    id: s.id,
    email: s.email,
    kind: s.domain === undefined ? "email" : "domain",
    domain: s.domain ?? null,
    // A bounce or a complaint is permanent.
    removable: s.origin === "manual",
    origin: s.origin,
    source_id: null,
    created_at: s.createdAt,
  });

  const domainItem = (d: DomainRow) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    created_at: d.createdAt,
    region: d.region,
    open_tracking: d.openTracking,
    click_tracking: d.clickTracking,
    tracking_subdomain: d.trackingSubdomain,
    tracking_status: d.trackingSubdomain ? "pending" : null,
    tracking_error: null,
    unsubscribe_subdomain: d.unsubscribeSubdomain,
    unsubscribe_status: d.unsubscribeSubdomain ? "pending" : null,
    unsubscribe_error: null,
    unsubscribe_page: {
      brand_name: null,
      message: null,
      success_message: null,
      redirect_url: null,
      background_color: null,
      text_color: null,
      accent_color: null,
      logo_radius: null,
      logo_url: null,
    },
    capabilities: { sending: "enabled", receiving: "disabled" },
    receiving_catch_all: false,
    send_transactional_to_unsubscribed: false,
    shared: d.shared,
    sending_mode: d.shared ? "reply_only" : "open",
    sending_mode_reason: null,
  });
  const domainDetail = (d: DomainRow) => ({
    ...domainItem(d),
    object: "domain",
    records: records(d),
  });

  const broadcastItem = (b: Store["broadcasts"] extends Map<string, infer R> ? R : never) => ({
    id: b.id,
    name: b.name,
    segment_id: b.segmentId,
    status: b.status,
    created_at: b.createdAt,
    scheduled_at: null,
    sent_at: null,
    failure_reason: null,
    failed_at: null,
    sent_count: null,
    finishes_at: null,
  });

  const propertyType = (key: string) =>
    [...store.contactProperties.values()].find((p) => p.key.toLowerCase() === key.toLowerCase())
      ?.type ?? "string";

  const contactItem = (c: ContactRow) => ({
    id: c.id,
    email: c.email,
    first_name: c.firstName,
    last_name: c.lastName,
    created_at: c.createdAt,
    unsubscribed: c.unsubscribed,
    unsubscribed_domains: [],
    verification_status: null,
    verified_at: null,
  });

  const contactTopics = (contactId: string) => {
    const subs = store.topicSubscriptions.get(contactId) ?? new Map<string, boolean>();
    return [...store.topics.values()].map((t) => {
      const explicit = subs.get(t.id);
      return {
        id: t.id,
        name: t.name,
        description: t.description ?? null,
        subscription:
          explicit === undefined ? t.defaultSubscription : explicit ? "opt_in" : "opt_out",
        explicit: explicit !== undefined,
        visibility: t.visibility,
      };
    });
  };

  // ---------- rules the bodies need beyond their schemas ----------

  const checkFilter = (filter: SegmentFilter | null | undefined) => {
    for (const [i, c] of (filter?.conditions ?? []).entries()) {
      const where = `filter.conditions.${i}`;
      const isProperty = c.field.startsWith("property:");
      if (isProperty || ["email", "first_name", "last_name"].includes(c.field)) {
        if (isProperty && c.field.length === "property:".length)
          fail(422, "validation_error", `${where}: property field requires a key`);
        if (!TEXT_OPS.includes(c.op))
          fail(422, "validation_error", `${where}: unsupported operator "${c.op}"`);
      } else if (c.field === "unsubscribed") {
        if (!["is_true", "is_false"].includes(c.op))
          fail(422, "validation_error", `${where}: unsupported operator "${c.op}"`);
      } else if (c.field === "created_at") {
        if (!["before", "after"].includes(c.op))
          fail(422, "validation_error", `${where}: unsupported operator "${c.op}"`);
      } else {
        fail(422, "validation_error", `${where}: unsupported field "${c.field}"`);
      }
    }
  };

  const findTemplate = (idOrAlias: string) =>
    store.templates.get(idOrAlias) ??
    [...store.templates.values()].find((t) => t.alias === idOrAlias) ??
    notFound("Template");

  const linkHostsNeedPaid = (body: {
    tracking_subdomain?: unknown;
    unsubscribe_subdomain?: unknown;
  }) => {
    if ((body.tracking_subdomain || body.unsubscribe_subdomain) && plan === "free") {
      fail(
        403,
        "plan_limit_reached",
        "A tracking or unsubscribe subdomain of your own needs a paid plan",
      );
    }
  };

  type BatchItem = {
    email: string;
    first_name?: string;
    last_name?: string;
    unsubscribed?: boolean;
    properties?: Record<string, unknown>;
    segments?: { id: string }[];
    topics?: { id: string; subscription: "opt_in" | "opt_out" }[];
  };
  type ItemResult =
    | { ok: true; id: string; status: "created" | "updated" | "skipped" }
    | { ok: false; status: number; name: string; message: string };

  const coerceProperties = (input: Record<string, unknown>): Record<string, string> | string => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "object")
        return "contact properties must be flat string or number values";
      if (propertyType(key) === "number" && !Number.isFinite(Number(value)))
        return `property "${key}" must be a number`;
      out[key] = String(value);
    }
    return out;
  };

  const batchContacts = (raw: unknown[], onConflict: "error" | "skip" | "upsert"): ItemResult[] => {
    const results: ItemResult[] = [];
    const seen = new Map<string, number>();
    let room =
      limits.contacts === null ? Number.POSITIVE_INFINITY : limits.contacts - store.contacts.size;
    for (const [index, value] of raw.entries()) {
      // The document types the body as an array of anything; its description says each item is a CreateContactRequest.
      const problems = checkComponent("CreateContactRequest", value);
      if (problems.length > 0) {
        results.push({
          ok: false,
          status: 422,
          name: "validation_error",
          message: problems[0] ?? "",
        });
        continue;
      }
      const item = value as BatchItem;
      const props = coerceProperties(item.properties ?? {});
      if (typeof props === "string") {
        results.push({ ok: false, status: 422, name: "validation_error", message: props });
        continue;
      }
      const key = item.email.toLowerCase();
      const earlier = seen.get(key);
      if (earlier !== undefined && onConflict === "error") {
        results.push({
          ok: false,
          status: 422,
          name: "validation_error",
          message: "Duplicate email in batch",
        });
        continue;
      }
      seen.set(key, index);
      if ((item.segments ?? []).some((s) => !store.segments.has(s.id))) {
        results.push({ ok: false, status: 404, name: "not_found", message: "Segment not found" });
        continue;
      }
      if ((item.topics ?? []).some((t) => !store.topics.has(t.id))) {
        results.push({ ok: false, status: 404, name: "not_found", message: "Topic not found" });
        continue;
      }
      let contact = [...store.contacts.values()].find((c) => c.email.toLowerCase() === key);
      let status: "created" | "updated" | "skipped";
      if (!contact) {
        if (room <= 0) {
          results.push({
            ok: false,
            status: 403,
            name: "plan_limit_reached",
            message: `Your plan allows up to ${limits.contacts} contacts`,
          });
          continue;
        }
        room--;
        contact = {
          id: randomUUID(),
          email: item.email,
          firstName: item.first_name ?? null,
          lastName: item.last_name ?? null,
          unsubscribed: item.unsubscribed ?? false,
          properties: props,
          createdAt: now(),
        };
        store.contacts.set(contact.id, contact);
        status = "created";
      } else if (earlier !== undefined && onConflict === "skip") {
        status = "skipped";
      } else if (onConflict === "error") {
        results.push({
          ok: false,
          status: 409,
          name: "validation_error",
          message: "Contact already exists",
        });
        continue;
      } else if (onConflict === "skip") {
        results.push({ ok: true, id: contact.id, status: "skipped" });
        continue;
      } else {
        if (item.first_name !== undefined) contact.firstName = item.first_name;
        if (item.last_name !== undefined) contact.lastName = item.last_name;
        // A batch never re-subscribes anyone (operation description).
        if (item.unsubscribed === true) contact.unsubscribed = true;
        Object.assign(contact.properties, props);
        status = "updated";
      }
      if (status !== "skipped") {
        for (const s of item.segments ?? []) store.segmentMembers.add(`${s.id}:${contact.id}`);
        for (const t of item.topics ?? []) {
          const subs = store.topicSubscriptions.get(contact.id) ?? new Map<string, boolean>();
          subs.set(t.id, t.subscription === "opt_in");
          store.topicSubscriptions.set(contact.id, subs);
        }
      }
      results.push({ ok: true, id: contact.id, status });
    }
    return results;
  };

  /** reply_to takes one address or a list; the answer is always a list, null when none. */
  const asList = (value: unknown): string[] | null =>
    value === undefined || value === null ? null : Array.isArray(value) ? value : [String(value)];
  const templateVariables = (
    input:
      | { key: string; type: "string" | "number"; fallback_value?: string | number | null }[]
      | undefined,
    at: string,
  ) =>
    (input ?? []).map((v) => ({
      key: v.key,
      type: v.type,
      fallback_value: v.fallback_value ?? null,
      created_at: at,
      updated_at: at,
    }));

  const deleteContact = (id: string) => {
    store.contacts.delete(id);
    store.topicSubscriptions.delete(id);
    for (const member of [...store.segmentMembers]) {
      if (member.endsWith(`:${id}`)) store.segmentMembers.delete(member);
    }
  };

  // ---------- handlers, keyed by "METHOD template" ----------

  type Ctx = {
    url: URL;
    params: Record<string, string>;
    body: unknown;
    headers: Record<string, string | undefined>;
  };
  type Handler = (ctx: Ctx) => unknown;
  // biome-ignore lint/suspicious/noExplicitAny: request bodies are schema-checked before a handler runs.
  type AnyBody = any;

  const handlers: Record<string, Handler> = {
    "GET /usage": () => {
      const start = "2026-01-01T00:00:00.000Z";
      const monthly = limits.emailsPerMonth !== null;
      return {
        object: "usage",
        emails: {
          daily: {
            used: 0,
            limit: limits.emailsPerDay,
            sent: 0,
            received: 0,
            resets_at: "2026-01-02T00:00:00.000Z",
          },
          monthly: {
            used: 0,
            limit: limits.emailsPerMonth,
            sent: 0,
            received: 0,
            resets_at: "2026-02-01T00:00:00.000Z",
            starts_at: start,
            overage_enabled: monthly,
            overage_usd_per_1k: monthly ? 0.6 : null,
          },
        },
        contacts: { used: store.contacts.size, limit: limits.contacts },
        segments: { used: store.segments.size, limit: null },
        broadcasts: { used: store.broadcasts.size, limit: null },
        ai_credits: { used: 0, limit: null, next_increase_at: null },
        automation_runs: {
          used: 0,
          limit: Number.MAX_SAFE_INTEGER,
          resets_at: "2026-02-01T00:00:00.000Z",
        },
        domains: {
          used: [...store.domains.values()].filter((d) => !d.shared).length,
          limit: limits.domains,
        },
        rate_limit: { limit: 600, duration: "1m" },
        plan,
        inboxes: { used: 0, limit: plan === "free" ? 1 : null },
        webhook_endpoints: { used: store.webhooks.size, limit: limits.webhookEndpoints },
        verification: {
          verified: 0,
          from_grant: 0,
          metered: 0,
          cost_cents: 0,
          price_per_1k_cents: 0,
        },
      };
    },

    // Domains
    "GET /domains": ({ url }) => listPage(store.domains.values(), url, domainItem),
    "POST /domains": ({ body }: { body: AnyBody }) => {
      const name = String(body.name);
      if (!DOMAIN_RE.test(name)) fail(422, "validation_error", "name: Invalid domain name");
      if ([...store.domains.values()].some((d) => d.name === name))
        fail(409, "conflict", "domain already added");
      linkHostsNeedPaid(body);
      const own = [...store.domains.values()].filter((d) => !d.shared).length;
      if (limits.domains !== null && own >= limits.domains)
        fail(403, "plan_limit_reached", `Your plan allows up to ${limits.domains} domains`);
      const returnPath = body.custom_return_path ?? "bounce";
      if (!LABEL_RE.test(returnPath))
        fail(422, "validation_error", "custom_return_path: Invalid label");
      const row: DomainRow = {
        id: randomUUID(),
        name,
        region: body.region ?? "us-east-1",
        status: "pending",
        customReturnPath: returnPath,
        openTracking: body.open_tracking ?? false,
        clickTracking: body.click_tracking ?? false,
        trackingSubdomain: body.tracking_subdomain ?? null,
        unsubscribeSubdomain: body.unsubscribe_subdomain ?? null,
        shared: false,
        createdAt: now(),
      };
      store.domains.set(row.id, row);
      const { object: _object, ...created } = domainDetail(row);
      return created;
    },
    "GET /domains/{id}": ({ params }) =>
      domainDetail(store.domains.get(params.id ?? "") ?? notFound("Domain")),
    "PATCH /domains/{id}": ({
      params,
      body,
    }: {
      params: Record<string, string>;
      body: AnyBody;
    }) => {
      const d = store.domains.get(params.id ?? "") ?? notFound("Domain");
      // The return path is fixed when the domain is added: any PATCH naming it is refused.
      if ("custom_return_path" in body)
        fail(422, "validation_error", "custom_return_path cannot be changed");
      const newHost =
        (!!body.tracking_subdomain && body.tracking_subdomain !== d.trackingSubdomain) ||
        (!!body.unsubscribe_subdomain && body.unsubscribe_subdomain !== d.unsubscribeSubdomain);
      if (newHost) linkHostsNeedPaid(body);
      for (const label of [body.tracking_subdomain, body.unsubscribe_subdomain]) {
        if (label && !LABEL_RE.test(label))
          fail(422, "validation_error", "Invalid subdomain label");
      }
      if (body.open_tracking !== undefined) d.openTracking = body.open_tracking;
      if (body.click_tracking !== undefined) d.clickTracking = body.click_tracking;
      if (body.tracking_subdomain !== undefined)
        d.trackingSubdomain = body.tracking_subdomain || null;
      if (body.unsubscribe_subdomain !== undefined)
        d.unsubscribeSubdomain = body.unsubscribe_subdomain || null;
      return domainDetail(d);
    },
    "DELETE /domains/{id}": ({ params }) => {
      const d = store.domains.get(params.id ?? "") ?? notFound("Domain");
      store.domains.delete(d.id);
      return { object: "domain", id: d.id, deleted: true };
    },

    // Contact properties
    "GET /contact-properties": ({ url }) =>
      listPage(store.contactProperties.values(), url, (p) => ({
        id: p.id,
        created_at: p.createdAt,
        key: p.key,
        type: p.type,
        fallback_value: p.fallback,
      })),
    "POST /contact-properties": ({ body }: { body: AnyBody }) => {
      if (
        [...store.contactProperties.values()].some(
          (p) => p.key.toLowerCase() === body.key.toLowerCase(),
        )
      )
        fail(409, "validation_error", "Property already exists");
      if (
        body.type === "number" &&
        body.fallback_value != null &&
        typeof body.fallback_value !== "number"
      )
        fail(422, "validation_error", "fallback_value: must be a number");
      const row = {
        id: randomUUID(),
        key: body.key as string,
        type: body.type as "string" | "number",
        fallback: (body.fallback_value ?? null) as string | number | null,
        createdAt: now(),
      };
      store.contactProperties.set(row.id, row);
      return {
        object: "contact_property",
        id: row.id,
        created_at: row.createdAt,
        key: row.key,
        type: row.type,
        fallback_value: row.fallback,
      };
    },
    "DELETE /contact-properties/{id}": ({ params }) => {
      const p = store.contactProperties.get(params.id ?? "") ?? notFound("Property");
      store.contactProperties.delete(p.id);
      for (const c of store.contacts.values()) delete c.properties[p.key];
      return { object: "contact_property", id: p.id, deleted: true };
    },

    // Topics (one unpaged list: the document gives GET /topics no paging parameters)
    "GET /topics": () => ({
      object: "list",
      data: [...store.topics.values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((t) => ({
          id: t.id,
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          default_subscription: t.defaultSubscription,
          visibility: t.visibility,
          domain_id: null,
          created_at: t.createdAt,
        })),
      has_more: false,
    }),
    "POST /topics": ({ body }: { body: AnyBody }) => {
      if (body.name.length > TOPIC_NAME_MAX)
        fail(422, "validation_error", `name: at most ${TOPIC_NAME_MAX} characters`);
      const row = {
        id: randomUUID(),
        name: body.name as string,
        description: body.description as string | undefined,
        defaultSubscription: body.default_subscription as "opt_in" | "opt_out",
        visibility: (body.visibility ?? "private") as "private" | "public",
        createdAt: now(),
      };
      store.topics.set(row.id, row);
      return {
        id: row.id,
        name: row.name,
        ...(row.description !== undefined ? { description: row.description } : {}),
        default_subscription: row.defaultSubscription,
        visibility: row.visibility,
        domain_id: null,
        created_at: row.createdAt,
      };
    },
    "PATCH /topics/{id}": ({ params, body }: { params: Record<string, string>; body: AnyBody }) => {
      const t = store.topics.get(params.id ?? "") ?? notFound("Topic");
      if (body.name !== undefined) t.name = body.name;
      if (body.description !== undefined) t.description = body.description;
      if (body.visibility !== undefined) t.visibility = body.visibility;
      return { id: t.id };
    },
    "DELETE /topics/{id}": ({ params }) => {
      const t = store.topics.get(params.id ?? "") ?? notFound("Topic");
      store.topics.delete(t.id);
      for (const subs of store.topicSubscriptions.values()) subs.delete(t.id);
      return { id: t.id, object: "topic", deleted: true };
    },

    // Segments
    "GET /segments": ({ url }) =>
      listPage(store.segments.values(), url, (s) => ({
        object: "segment",
        id: s.id,
        name: s.name,
        domain_id: null,
        filter: s.filter,
        created_at: s.createdAt,
      })),
    "POST /segments": ({ body }: { body: AnyBody }) => {
      checkFilter(body.filter);
      const row = {
        id: randomUUID(),
        name: body.name as string,
        filter: body.filter ?? null,
        createdAt: now(),
      };
      store.segments.set(row.id, row);
      return {
        object: "segment",
        id: row.id,
        name: row.name,
        domain_id: null,
        filter: row.filter,
        created_at: row.createdAt,
      };
    },
    "PATCH /segments/{id}": ({
      params,
      body,
    }: {
      params: Record<string, string>;
      body: AnyBody;
    }) => {
      const s = store.segments.get(params.id ?? "") ?? notFound("Segment");
      checkFilter(body.filter);
      if (body.name !== undefined) s.name = body.name;
      if (body.filter !== undefined) s.filter = body.filter;
      return {
        object: "segment",
        id: s.id,
        name: s.name,
        domain_id: null,
        filter: s.filter,
        created_at: s.createdAt,
      };
    },
    "DELETE /segments/{id}": ({ params }) => {
      const s = store.segments.get(params.id ?? "") ?? notFound("Segment");
      store.segments.delete(s.id);
      for (const member of [...store.segmentMembers]) {
        if (member.startsWith(`${s.id}:`)) store.segmentMembers.delete(member);
      }
      return { object: "segment", id: s.id, deleted: true };
    },

    // Webhooks
    "GET /webhooks": ({ url }) =>
      listPage(store.webhooks.values(), url, (w) => ({
        id: w.id,
        endpoint: w.endpoint,
        created_at: w.createdAt,
        status: w.status,
        events: w.events,
        inbox_ids: null,
      })),
    "POST /webhooks": ({ body }: { body: AnyBody }) => {
      if (!String(body.endpoint).startsWith("https://"))
        fail(422, "validation_error", "endpoint: must be an https URL");
      if (limits.webhookEndpoints !== null && store.webhooks.size >= limits.webhookEndpoints)
        fail(
          403,
          "plan_limit_reached",
          `Your plan allows up to ${limits.webhookEndpoints} webhook endpoints`,
        );
      const secret = body.signing_secret ?? `whsec_${randomBytes(32).toString("base64")}`;
      if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
        fail(422, "validation_error", "signing_secret: must be whsec_ followed by base64");
      const row = {
        id: randomUUID(),
        endpoint: body.endpoint as string,
        events: [...new Set(body.events as string[])],
        status: "enabled" as const,
        secret,
        createdAt: now(),
      };
      store.webhooks.set(row.id, row);
      return { object: "webhook", id: row.id, signing_secret: secret };
    },
    "GET /webhooks/{id}": ({ params }) => {
      const w = store.webhooks.get(params.id ?? "") ?? notFound("Webhook");
      return {
        object: "webhook",
        id: w.id,
        endpoint: w.endpoint,
        created_at: w.createdAt,
        status: w.status,
        events: w.events,
        inbox_ids: null,
        signing_secret: w.secret,
        previous_secret_expires_at: null,
      };
    },
    "PATCH /webhooks/{id}": ({
      params,
      body,
    }: {
      params: Record<string, string>;
      body: AnyBody;
    }) => {
      const w = store.webhooks.get(params.id ?? "") ?? notFound("Webhook");
      if (body.endpoint !== undefined) w.endpoint = body.endpoint;
      if (body.events !== undefined) w.events = [...new Set(body.events as string[])];
      if (body.status !== undefined) w.status = body.status;
      return { object: "webhook", id: w.id };
    },
    "DELETE /webhooks/{id}": ({ params }) => {
      const w = store.webhooks.get(params.id ?? "") ?? notFound("Webhook");
      store.webhooks.delete(w.id);
      return { object: "webhook", id: w.id, deleted: true };
    },

    // Templates
    "GET /templates": ({ url }) =>
      listPage(store.templates.values(), url, (t) => ({
        id: t.id,
        name: t.name,
        alias: t.alias,
        status: "published",
        published_at: t.updatedAt,
        created_at: t.createdAt,
        updated_at: t.updatedAt,
      })),
    "POST /templates": ({ body }: { body: AnyBody }) => {
      if (body.alias && [...store.templates.values()].some((t) => t.alias === body.alias))
        fail(409, "validation_error", "Template alias already exists");
      const at = now();
      const row = {
        id: randomUUID(),
        name: body.name as string,
        alias: (body.alias ?? null) as string | null,
        from: (body.from ?? null) as string | null,
        replyTo: asList(body.reply_to),
        subject: (body.subject ?? null) as string | null,
        html: body.html as string,
        text: (body.text ?? null) as string | null,
        variables: templateVariables(body.variables, at),
        createdAt: at,
        updatedAt: at,
      };
      store.templates.set(row.id, row);
      return { object: "template", id: row.id };
    },
    "GET /templates/{id}": ({ params }) => {
      const t = findTemplate(params.id ?? "");
      return {
        object: "template",
        id: t.id,
        name: t.name,
        alias: t.alias,
        status: "published",
        published_at: t.updatedAt,
        created_at: t.createdAt,
        updated_at: t.updatedAt,
        current_version_id: t.id,
        from: t.from,
        subject: t.subject,
        reply_to: t.replyTo,
        html: t.html,
        text: t.text,
        variables: t.variables,
        has_unpublished_versions: false,
      };
    },
    "PATCH /templates/{id}": ({
      params,
      body,
    }: {
      params: Record<string, string>;
      body: AnyBody;
    }) => {
      const t = findTemplate(params.id ?? "");
      if (
        body.alias &&
        [...store.templates.values()].some((o) => o.alias === body.alias && o.id !== t.id)
      )
        fail(409, "validation_error", "Template alias already exists");
      for (const [wire, field] of [
        ["name", "name"],
        ["alias", "alias"],
        ["subject", "subject"],
        ["html", "html"],
        ["text", "text"],
      ] as const) {
        if (body[wire] !== undefined) (t as Record<string, unknown>)[field] = body[wire];
      }
      if (body.from !== undefined) t.from = body.from;
      if (body.reply_to !== undefined) t.replyTo = asList(body.reply_to);
      t.updatedAt = now();
      if (body.variables !== undefined)
        t.variables = templateVariables(body.variables, t.updatedAt);
      return { object: "template", id: t.id };
    },
    "DELETE /templates/{id}": ({ params }) => {
      const t = findTemplate(params.id ?? "");
      store.templates.delete(t.id);
      return { object: "template", id: t.id, deleted: true };
    },

    // Broadcasts
    "GET /broadcasts": ({ url }) => listPage(store.broadcasts.values(), url, broadcastItem),
    "GET /broadcasts/{id}": ({ params }) => {
      const b = store.broadcasts.get(params.id ?? "") ?? notFound("Broadcast");
      return {
        ...broadcastItem(b),
        object: "broadcast",
        from: b.from,
        subject: b.subject,
        reply_to: b.replyTo,
        preview_text: b.previewText,
        topic_id: b.topicId,
        domain_id: null,
        html: b.html,
        text: b.text,
      };
    },
    "POST /broadcasts": ({ body }: { body: AnyBody }) => {
      // The document leaves html and text both optional; the API wants one of them.
      if (body.html === undefined && body.text === undefined)
        fail(422, "validation_error", "Either html or text must be provided");
      if (body.segment_id !== undefined && !store.segments.has(body.segment_id))
        fail(422, "validation_error", "Segment not found");
      if (body.topic_id != null && !store.topics.has(body.topic_id)) notFound("Topic");
      const row = {
        id: randomUUID(),
        name: (body.name ?? null) as string | null,
        segmentId: (body.segment_id ?? null) as string | null,
        topicId: (body.topic_id ?? null) as string | null,
        from: body.from as string,
        subject: body.subject as string,
        replyTo:
          body.reply_to === undefined
            ? null
            : Array.isArray(body.reply_to)
              ? (body.reply_to as string[])
              : [body.reply_to as string],
        previewText: (body.preview_text ?? null) as string | null,
        html: (body.html ?? null) as string | null,
        text: (body.text ?? null) as string | null,
        status: "draft",
        createdAt: now(),
      };
      store.broadcasts.set(row.id, row);
      return { id: row.id };
    },
    "DELETE /broadcasts/{id}": ({ params }) => {
      const b = store.broadcasts.get(params.id ?? "") ?? notFound("Broadcast");
      store.broadcasts.delete(b.id);
      return { object: "broadcast", id: b.id, deleted: true };
    },

    // Contacts
    "GET /contacts": ({ url }) => listPage(store.contacts.values(), url, contactItem),
    "POST /contacts/batch": ({ url, body, headers }) => {
      const onConflict = (url.searchParams.get("on_conflict") ?? "error") as
        | "error"
        | "skip"
        | "upsert";
      const strict = headers["x-batch-validation"] !== "permissive";
      const items = body as unknown[];
      if (items.length > 1000) fail(422, "validation_error", "at most 1000 contacts per batch");
      const results = batchContacts(items, onConflict);
      if (strict) {
        const index = results.findIndex((r) => !r.ok);
        const failed = results[index];
        if (failed && !failed.ok)
          fail(failed.status, failed.name, `contacts.${index}: ${failed.message}`);
      }
      const data: unknown[] = [];
      const errors: unknown[] = [];
      const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
      for (const [index, r] of results.entries()) {
        if (r.ok) {
          data.push({ object: "contact", index, id: r.id, status: r.status });
          counts[r.status]++;
        } else {
          errors.push({ index, statusCode: r.status, name: r.name, message: r.message });
          counts.failed++;
        }
      }
      return { data, counts, ...(strict ? {} : { errors }) };
    },
    "POST /contacts/batch/get": ({ body }: { body: AnyBody }) => {
      const refs = body.contacts as { id?: string; email?: string }[];
      const data: unknown[] = [];
      const missing: unknown[] = [];
      for (const [index, ref] of refs.entries()) {
        const row = [...store.contacts.values()].find((c) =>
          ref.id !== undefined
            ? c.id === ref.id
            : c.email.toLowerCase() === ref.email?.toLowerCase(),
        );
        if (row) {
          data.push({
            object: "contact",
            ...contactItem(row),
            ...(body.include?.includes("topics") ? { topics: contactTopics(row.id) } : {}),
          });
        } else
          missing.push({
            index,
            ...(ref.id === undefined ? { email: ref.email } : { id: ref.id }),
          });
      }
      return { object: "list", data, missing };
    },
    "GET /contacts/{id}": ({ params }) => {
      const c = store.contacts.get(params.id ?? "") ?? notFound("Contact");
      const properties: Record<string, { type: string; value: string | number }> = {};
      for (const [key, value] of Object.entries(c.properties)) {
        properties[key] =
          propertyType(key) === "number"
            ? { type: "number", value: Number(value) }
            : { type: "string", value };
      }
      return { ...contactItem(c), object: "contact", properties };
    },
    "DELETE /contacts/{id}": ({ params }) => {
      const c = store.contacts.get(params.id ?? "") ?? notFound("Contact");
      deleteContact(c.id);
      return { object: "contact", contact: c.id, deleted: true };
    },
    "GET /contacts/{id}/topics": ({ params }) => {
      const c = store.contacts.get(params.id ?? "") ?? notFound("Contact");
      return { object: "list", data: contactTopics(c.id), has_more: false };
    },
    "PATCH /contacts/{id}/topics": ({ params, body }) => {
      const c = store.contacts.get(params.id ?? "") ?? notFound("Contact");
      const entries = body as { id: string; subscription: "opt_in" | "opt_out" }[];
      if (entries.some((e) => !store.topics.has(e.id))) notFound("Topic");
      const subs = store.topicSubscriptions.get(c.id) ?? new Map<string, boolean>();
      for (const e of entries) subs.set(e.id, e.subscription === "opt_in");
      store.topicSubscriptions.set(c.id, subs);
      return { id: c.id };
    },
    "POST /contacts/{id}/segments/{segmentId}": ({ params }) => {
      const c = store.contacts.get(params.id ?? "") ?? notFound("Contact");
      const s = store.segments.get(params.segmentId ?? "") ?? notFound("Segment");
      store.segmentMembers.add(`${s.id}:${c.id}`);
      return { id: c.id };
    },

    // Suppressions
    "GET /suppressions": ({ url }) => {
      const origin = url.searchParams.get("origin");
      const kind = url.searchParams.get("kind") ?? "email";
      const rows = [...store.suppressions.values()].filter(
        (s) =>
          (!origin || s.origin === origin) &&
          (kind === "all" || (kind === "domain") === (s.domain !== undefined)),
      );
      return listPage(rows, url, suppressionItem);
    },
    "POST /suppressions/batch/add": ({ body }: { body: AnyBody }) => {
      const data: unknown[] = [];
      const seen = new Set<string>();
      for (const email of (body.emails ?? []) as string[]) {
        const key = email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        let row = [...store.suppressions.values()].find((s) => s.email === key);
        if (!row) {
          row = { id: randomUUID(), email: key, origin: body.origin ?? "manual", createdAt: now() };
          store.suppressions.set(row.id, row);
        }
        data.push({ object: "suppression", id: row.id });
      }
      // Domain entries follow the addresses' in the answer; they are manual entries.
      for (const domain of (body.domains ?? []) as string[]) {
        const key = domain.toLowerCase();
        if (seen.has(`@${key}`)) continue;
        seen.add(`@${key}`);
        if (PUBLIC_MAILBOX_DOMAINS.has(key))
          fail(422, "validation_error", `domains: ${key} is a public mailbox provider`);
        let row = [...store.suppressions.values()].find((s) => s.domain === key);
        if (!row) {
          row = { id: randomUUID(), email: null, domain: key, origin: "manual", createdAt: now() };
          store.suppressions.set(row.id, row);
        }
        data.push({ object: "suppression", id: row.id });
      }
      return { data };
    },
    "POST /suppressions/batch/remove": ({ body }: { body: AnyBody }) => {
      const data: unknown[] = [];
      const notRemoved: unknown[] = [];
      const ids = new Set<string>(body.ids ?? []);
      const emails = new Set<string>((body.emails ?? []).map((e: string) => e.toLowerCase()));
      for (const s of [...store.suppressions.values()]) {
        if (!ids.has(s.id) && !(s.email !== null && emails.has(s.email))) continue;
        // A bounce or complaint entry is permanent: it stays and is listed in not_removed.
        if (!suppressionItem(s).removable) {
          notRemoved.push({
            object: "suppression",
            id: s.id,
            origin: s.origin,
            reason: "permanent",
          });
          continue;
        }
        store.suppressions.delete(s.id);
        data.push({ object: "suppression", id: s.id, deleted: true });
      }
      return { data, not_removed: notRemoved };
    },

    "GET /unsubscribes": ({ url }) =>
      listPage([], url, (x: { id: string; createdAt: string }) => x),
  };

  // ---------- the server ----------

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        data += chunk;
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  const answer = (
    res: ServerResponse,
    matched: MatchedOperation | null,
    status: number,
    body: unknown,
  ) => {
    if (matched) {
      for (const problem of checkResponse(matched, status, body)) {
        violations.push(`${matched.method} ${matched.template} → ${status}: ${problem}`);
      }
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const error = (status: number, name: string, message: string) => ({
    statusCode: status,
    name,
    message,
  });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://contract.test");
      const method = req.method ?? "GET";
      const matched = matchOperation(method, url.pathname);
      if (!matched) {
        violations.push(`${method} ${url.pathname}: not an operation of the published API`);
        return answer(res, null, 404, error(404, "not_found", "Route not found"));
      }
      const key = `${matched.method} ${matched.template}`;
      served.add(key);
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      const raw = await readBody(req);
      let body: unknown;
      if (raw !== "") {
        try {
          body = JSON.parse(raw);
        } catch {
          return answer(res, matched, 400, error(400, "validation_error", "Invalid JSON"));
        }
      }

      bodies.push({ operation: key, body });

      const security = matched.operation.security;
      if (!(Array.isArray(security) && security.length === 0)) {
        const auth = headers.authorization ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
        if (!token?.startsWith("bs_"))
          return answer(
            res,
            matched,
            401,
            error(401, "missing_api_key", "Missing or malformed API key"),
          );
        const permission = keys.get(token);
        if (!permission)
          return answer(res, matched, 401, error(401, "invalid_api_key", "API key is invalid"));
        if (permission === "sending_access" && !url.pathname.startsWith("/emails")) {
          return answer(
            res,
            matched,
            403,
            error(403, "restricted_api_key", "This API key can only send emails"),
          );
        }
      }

      const { problems, bodyProblems } = checkRequest(matched, url, headers, body, raw !== "");
      // Off-contract requests are violations; like the API, an unknown query parameter is otherwise ignored.
      for (const problem of problems) violations.push(`${key}: request ${problem}`);
      const refused = [
        ...problems.filter((p) => !p.endsWith("is not documented")),
        ...bodyProblems,
      ];
      if (refused.length > 0) {
        return answer(
          res,
          problems.length > 0 ? null : matched,
          422,
          error(422, "validation_error", refused[0] ?? ""),
        );
      }

      const handler = handlers[key];
      if (!handler) {
        violations.push(
          `${key}: documented, but the contract API in this repository has no handler for it`,
        );
        return answer(res, null, 501, error(501, "not_implemented", key));
      }
      try {
        return answer(res, matched, 200, handler({ url, params: matched.params, body, headers }));
      } catch (e) {
        if (e instanceof HttpError)
          return answer(res, matched, e.status, error(e.status, e.name, e.message));
        violations.push(`${key}: handler threw ${String(e)}`);
        return answer(res, null, 500, error(500, "internal_server_error", String(e)));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const api: ContractApi = {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    store,
    violations,
    served,
    bodies,
    createApiKey: mintKey,
    count: (table) =>
      table === "topicSubscriptions"
        ? [...store.topicSubscriptions.values()].reduce((n, subs) => n + subs.size, 0)
        : store[table].size,
    stop: async () => {
      live.delete(api);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  live.add(api);
  return api;
}
