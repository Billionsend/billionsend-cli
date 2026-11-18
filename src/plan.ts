import { createHash } from "node:crypto";
import type {
  Plan,
  PlanAction,
  PlanItem,
  PlanOptionsRecord,
  Resource,
  Snapshot,
  SourceContact,
  TargetContact,
  TargetState,
  TargetWebhook,
} from "./model.js";
import { estimateSourceRequests } from "./providers/index.js";
import { bold, dim, note, ok, SYM, warn, wrapIndent } from "./theme.js";
import {
  type BroadcastCreateInput,
  broadcastCreateInput,
  type DomainCreateInput,
  type DomainTrackingInput,
  domainCreateInput,
  type SegmentFilter,
  type TargetWebhookEvent,
  type TemplateCreateInput,
  templateCreateInput,
  translateSegmentFilter,
  translateWebhookEvents,
} from "./translate.js";
import {
  canonicalJson,
  capitalize,
  formatDuration,
  formatNumber,
  pluralize,
  senderDomain,
  stripControl,
} from "./utils.js";

export const PLAN_VERSION = 2;
const BATCH_SIZE = 1000;

/** Item order: each resource only references ones created before it. */
const RESOURCE_ORDER: Resource[] = [
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
];

export interface PropertyPayload {
  key: string;
  type: "string" | "number";
  fallback_value?: string | number | null;
}
export interface TopicPayload {
  name: string;
  description?: string;
  default_subscription: "opt_in" | "opt_out";
  visibility?: "public" | "private";
}
export interface SegmentPayload {
  name: string;
  filter?: SegmentFilter;
}
export interface DomainPayload {
  create: DomainCreateInput;
  tracking: DomainTrackingInput;
}
/** Secrets never enter the plan: apply reads the source secret by `sourceId`. */
export interface WebhookPayload {
  endpoint: string;
  events: TargetWebhookEvent[];
  sourceId: string;
  signingSecret: "copy" | "fresh";
}
export type TemplatePayload = TemplateCreateInput;
/** segment_id/topic_id are filled at apply time by name, once those rows exist. */
/** Whether upserting the source contact would change the target's: a name it has that the target lacks or spells differently, or an opt-out the target does not have. */
function contactDiffers(source: SourceContact, target: TargetContact): boolean {
  if (source.unsubscribed && !target.unsubscribed) return true;
  if (source.firstName !== null && source.firstName !== target.firstName) return true;
  return source.lastName !== null && source.lastName !== target.lastName;
}

export interface BroadcastPayload {
  input: BroadcastCreateInput;
  segmentName: string | null;
  topicName: string | null;
}

export interface PlanOptions extends PlanOptionsRecord {
  /** The resources the plan covers: `only` minus `skip`, or what the picker left selected. */
  include: Set<Resource>;
  rps: number;
  /** Requests already spent reading the source; counted into the estimate. */
  sourceRequestsSpent: number;
  baseUrl: string;
  now?: Date | undefined;
}

type ItemInit = Omit<PlanItem, "resource" | "action" | "key">;

/** Field names whose values differ between source and target, for the update detail. */
function changedFields(pairs: [string, unknown, unknown][]): string[] {
  return pairs.filter(([, a, b]) => canonicalJson(a) !== canonicalJson(b)).map(([name]) => name);
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

export function buildPlan({
  snapshot,
  target,
  options,
}: {
  snapshot: Snapshot;
  target: TargetState;
  options: PlanOptions;
}): Plan {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const add = (resource: Resource, action: PlanAction, key: string, init: ItemInit = {}): void => {
    items.push({ resource, action, key, ...init });
  };
  const manual = (resource: Resource, key: string, detail: string): void =>
    add(resource, "manual", key, { detail });
  const has = (resource: Resource): boolean => options.include.has(resource);

  if (has("properties")) {
    // BillionSend property keys ignore case ((team, lower(key)) is unique); Resend's do not.
    const kept = new Map<string, string>();
    for (const p of snapshot.properties) {
      const lower = p.key.toLowerCase();
      const first = kept.get(lower);
      if (first !== undefined) {
        add("properties", "manual", p.key, {
          detail: `differs from \`${first}\` only in case; BillionSend property keys ignore case, so only \`${first}\` is created and no value of \`${p.key}\` is written (the contacts that have one are counted after the enrichment pass)`,
          payload: { collidesWith: first },
        });
        continue;
      }
      kept.set(lower, p.key);
      const existing = target.properties.find((t) => t.key.toLowerCase() === lower);
      if (!existing) {
        const payload: PropertyPayload = {
          key: p.key,
          type: p.type,
          ...(p.fallbackValue !== undefined ? { fallback_value: p.fallbackValue } : {}),
        };
        add("properties", "create", p.key, { payload, detail: p.type });
      } else if (existing.type !== p.type) {
        manual(
          "properties",
          p.key,
          `type differs: ${p.type} on Resend, ${existing.type} here — a property's type cannot change`,
        );
      } else if (existing.key !== p.key) {
        // The same property here; values are written under the spelling it already has.
        add("properties", "unchanged", p.key, {
          targetId: existing.id,
          detail: `already here as \`${existing.key}\` (keys ignore case)`,
          payload: { targetKey: existing.key },
        });
      } else {
        add("properties", "unchanged", p.key, { targetId: existing.id });
      }
    }
  }

  if (has("topics")) {
    for (const t of snapshot.topics) {
      const existing = target.topics.find((x) => x.name === t.name);
      if (!existing) {
        const payload: TopicPayload = {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          default_subscription: t.defaultSubscription,
          ...(t.visibility ? { visibility: t.visibility } : {}),
        };
        add("topics", "create", t.name, { payload, detail: t.defaultSubscription });
        continue;
      }
      if (existing.defaultSubscription !== t.defaultSubscription) {
        manual(
          "topics",
          t.name,
          `default_subscription differs: ${t.defaultSubscription} on Resend, ${existing.defaultSubscription} here — it is fixed at creation`,
        );
      }
      const changed = changedFields([
        ["description", t.description ?? "", existing.description ?? ""],
      ]);
      if (changed.length > 0) {
        add("topics", "update", t.name, {
          targetId: existing.id,
          detail: changed.join(", "),
          payload: { description: t.description ?? "" },
        });
      } else {
        add("topics", "unchanged", t.name, { targetId: existing.id });
      }
    }
  }

  if (has("segments")) {
    for (const s of snapshot.segments) {
      const translated = s.filter === null ? null : translateSegmentFilter(s.filter);
      const existing = target.segments.find((x) => x.name === s.name);
      const filter = translated?.filter ?? null;
      if (!existing) {
        const payload: SegmentPayload = { name: s.name, ...(filter ? { filter } : {}) };
        add("segments", "create", s.name, {
          payload,
          detail: `${filter ? "filter, " : ""}${pluralize(s.memberEmails.length, "member")}`,
        });
      } else if (filter && canonicalJson(filter) !== canonicalJson(existing.filter)) {
        add("segments", "update", s.name, {
          targetId: existing.id,
          detail: "filter",
          payload: { filter },
        });
      } else {
        add("segments", "unchanged", s.name, { targetId: existing.id });
      }
      if (translated?.reason) {
        manual(
          "segments",
          s.name,
          `filter not translated (${translated.reason}); ${pluralize(s.memberEmails.length, "member")} still imported`,
        );
      }
    }
  }

  if (has("domains")) {
    let creates = 0;
    for (const d of snapshot.domains) {
      const existing = target.domains.find((x) => x.name === d.name);
      if (existing) {
        add("domains", "unchanged", d.name, { targetId: existing.id });
        if (existing.status !== "verified") {
          manual("domains", d.name, `add ${pluralize(existing.records.length, "DNS record")}`);
        }
        continue;
      }
      const { input, tracking } = domainCreateInput(d);
      creates += 1;
      const payload: DomainPayload = { create: input, tracking };
      add("domains", "create", d.name, { payload });
      manual("domains", d.name, DNS_AFTER_APPLY);
    }
    const limit = target.usage.limits.domains;
    if (limit !== null && creates > 0 && target.domains.length + creates > limit) {
      warnings.push(
        `${pluralize(creates, "domain")} to create; the ${capitalize(target.usage.plan ?? "current")} plan allows ${limit} (${target.domains.length} already there)`,
      );
    }
  }

  if (has("webhooks")) {
    for (const w of snapshot.webhooks) {
      const { events, dropped } = translateWebhookEvents(w.events);
      const droppedNote = (): void => {
        if (dropped.length > 0)
          manual("webhooks", w.endpoint, `events not delivered here: ${dropped.join(", ")}`);
      };
      if (events.length === 0) {
        manual("webhooks", w.endpoint, "none of its events exist here; not created");
        droppedNote();
        continue;
      }
      const existing = target.webhooks.find((x) => x.endpoint === w.endpoint);
      if (!existing) {
        const payload: WebhookPayload = {
          endpoint: w.endpoint,
          events,
          sourceId: w.id,
          signingSecret: options.freshWebhookSecrets || !w.signingSecret ? "fresh" : "copy",
        };
        add("webhooks", "create", w.endpoint, {
          payload,
          detail: `${pluralize(events.length, "event")}, ${payload.signingSecret === "copy" ? "secret copied" : "fresh secret"}`,
        });
        droppedNote();
        continue;
      }
      const update = webhookUpdate(existing, events, w.status);
      if (update) {
        add("webhooks", "update", w.endpoint, {
          targetId: existing.id,
          detail: Object.keys(update).join(", "),
          payload: update,
        });
      } else {
        add("webhooks", "unchanged", w.endpoint, { targetId: existing.id });
      }
      droppedNote();
    }
  }

  if (has("templates")) {
    for (const t of snapshot.templates) {
      const { input, notes, reason } = templateCreateInput(t);
      const label = t.alias ?? t.name;
      const existing =
        (t.alias ? target.templates.find((x) => x.alias === t.alias) : undefined) ??
        target.templates.find((x) => x.name === t.name);
      if (!input) {
        manual("templates", label, reason ?? "cannot be created");
      } else if (!existing) {
        add("templates", "create", label, {
          payload: input,
          ...(t.alias ? { detail: t.name } : {}),
        });
      } else {
        // Only the fields that differ go in the PATCH: a body write also resets the target's visual-editor document.
        // from, reply_to and variables are compared only when the source has them: a template
        // with none leaves what the target holds alone.
        const desired: Record<string, unknown> = {
          name: input.name,
          alias: t.alias,
          subject: input.subject ?? null,
          html: input.html,
          text: input.text ?? null,
          ...(input.from === undefined ? {} : { from: input.from }),
          ...(input.reply_to === undefined ? {} : { reply_to: input.reply_to }),
          ...(input.variables === undefined
            ? {}
            : {
                variables: input.variables.map((v) => ({
                  key: v.key,
                  type: v.type,
                  fallback_value: v.fallback_value ?? null,
                })),
              }),
        };
        const current: Record<string, unknown> = {
          name: existing.name,
          alias: existing.alias,
          subject: existing.subject ?? null,
          html: existing.html ?? null,
          text: existing.text ?? null,
          from: existing.from ?? null,
          reply_to: existing.replyTo ?? null,
          variables: (existing.variables ?? []).map((v) => ({
            key: v.key,
            type: v.type,
            fallback_value: v.fallback_value,
          })),
        };
        const changed = changedFields(
          Object.keys(desired).map((field) => [field, desired[field], current[field]]),
        );
        if (changed.length > 0) {
          add("templates", "update", label, {
            targetId: existing.id,
            detail: changed.join(", "),
            payload: Object.fromEntries(changed.map((field) => [field, desired[field]])),
          });
        } else {
          add("templates", "unchanged", label, { targetId: existing.id });
        }
      }
      for (const note of notes) manual("templates", label, note);
    }
  }

  const contactCount = has("contacts") ? snapshot.contacts.length : 0;
  if (contactCount > 0) {
    const memberships = has("segments")
      ? snapshot.segments.reduce((n, s) => n + s.memberEmails.length, 0)
      : 0;
    // The batch endpoint upserts by address: the contacts the target already has are matched, not created.
    const members = new Set<string>();
    if (has("segments")) {
      for (const segment of snapshot.segments) {
        for (const email of segment.memberEmails) members.add(email.toLowerCase());
      }
    }
    const fresh: SourceContact[] = [];
    const matched = { changed: 0, same: 0 };
    for (const c of snapshot.contacts) {
      const there = target.contacts.get(c.email.toLowerCase());
      if (there === undefined) fresh.push(c);
      // A segment's members on the target are not read: a contact in one is upserted to make sure it is there.
      else if (contactDiffers(c, there) || members.has(c.email.toLowerCase())) matched.changed += 1;
      else matched.same += 1;
    }
    const existing = matched.changed + matched.same;
    const batchDetail = `batch upsert, ${pluralize(memberships, "segment membership")}`;
    if (fresh.length > 0 || existing === 0) {
      add("contacts", "create", "contacts", {
        count: fresh.length,
        detail:
          existing === 0
            ? batchDetail
            : `${formatNumber(fresh.length)} not on BillionSend yet; batch upsert, ${pluralize(memberships, "segment membership")} across all ${formatNumber(contactCount)} contacts`,
      });
    }
    if (existing > 0) {
      const there = (n: number, what: string): string =>
        `${formatNumber(n)} already on BillionSend (matched by address); ${what}`;
      if (options.onConflict === "skip") {
        add("contacts", "skip", "existing contacts", {
          count: existing,
          detail: there(existing, "--on-conflict skip leaves them as they are"),
        });
      } else if (options.onConflict === "error") {
        // The run still goes through them: the API refuses each one, and the run exits 3.
        add("contacts", "update", "existing contacts", {
          count: existing,
          detail: there(existing, "--on-conflict error refuses them, and the run exits 3"),
        });
      } else {
        if (matched.changed > 0) {
          add("contacts", "update", "existing contacts", {
            count: matched.changed,
            detail: there(
              matched.changed,
              "the upsert makes sure each is in its segment and writes a name or opt-out flag that differs",
            ),
          });
        }
        if (matched.same > 0) {
          add("contacts", "unchanged", "existing contacts", {
            count: matched.same,
            detail: there(matched.same, "names and opt-out flag are the same, in no segment"),
          });
        }
      }
    }
    // Only the contacts that are new count against the plan's cap; the existing ones are already counted.
    const limit = target.usage.limits.contacts;
    if (limit !== null && fresh.length > limit) {
      warnings.push(
        `${pluralize(fresh.length, "contact")} to create; the ${capitalize(target.usage.plan ?? "current")} plan allows ${formatNumber(limit)}`,
      );
    }
  }

  // Facets in pass order: opt-outs first, so a broadcast sent early reaches nobody who left.
  const facets = [
    ...(snapshot.topics.length > 0 ? ["topic subscriptions"] : []),
    ...(snapshot.properties.length > 0 ? ["properties"] : []),
  ];
  const enrichCount = snapshot.contacts.length;
  const enrichment =
    has("enrichment") &&
    enrichCount > 0 &&
    (contactCount > 0 || target.hasContacts === true) &&
    !snapshot.enriched &&
    facets.length > 0;
  if (enrichment) {
    add("enrichment", "update", "contacts", {
      count: enrichCount,
      detail: `${facets.join(", then ")}, read per contact`,
    });
    if (!has("topics") && snapshot.topics.length > 0) {
      warnings.push(
        "topics are excluded, so the topic-subscriptions pass has nothing to write and is skipped",
      );
    }
    if (!has("properties") && snapshot.properties.length > 0) {
      warnings.push(
        "contact properties are excluded, so the properties pass has nothing to write and is skipped",
      );
    }
  }

  if (has("broadcasts")) {
    for (const b of snapshot.broadcasts) {
      if (
        snapshot.segmentScope !== null &&
        b.segmentId !== null &&
        !snapshot.segmentScope.some((s) => s.id === b.segmentId)
      ) {
        add("broadcasts", "skip", b.name, { detail: "sent to a segment outside --segment" });
        continue;
      }
      if (b.status === "sent" && !options.includeSent) {
        add("broadcasts", "skip", b.name, {
          detail: "already sent; --include-sent imports sent broadcasts as drafts",
        });
        continue;
      }
      const existing = target.broadcasts.find((x) => x.name === b.name && x.status === "draft");
      if (existing) {
        add("broadcasts", "unchanged", b.name, {
          targetId: existing.id,
          detail: "matched by name; the draft's body is not compared",
        });
        continue;
      }
      const domain = senderDomain(b.from);
      const verified = target.domains.some((d) => d.name === domain && d.status === "verified");
      const { input, notes, reason } = broadcastCreateInput(b, { segmentId: null, topicId: null });
      if (!input) {
        manual("broadcasts", b.name, reason ?? "cannot be created");
        continue;
      }
      if (!verified) {
        manual(
          "broadcasts",
          b.name,
          `from domain ${domain ?? b.from} is not verified here — re-run apply after DNS verification`,
        );
        continue;
      }
      const payload: BroadcastPayload = {
        input,
        segmentName: snapshot.segments.find((s) => s.id === b.segmentId)?.name ?? null,
        topicName: snapshot.topics.find((t) => t.id === b.topicId)?.name ?? null,
      };
      add("broadcasts", "create", b.name, { payload, detail: "draft" });
      for (const note of notes) manual("broadcasts", b.name, note);
    }
  }

  const suppressionCount = has("suppressions") ? snapshot.suppressions.length : 0;
  if (suppressionCount > 0) {
    add("suppressions", "create", "suppressions", {
      count: suppressionCount,
      detail: "batch add with origin",
    });
  }

  if (has("api-keys")) {
    for (const k of snapshot.apiKeys) {
      manual("api-keys", k.name, "create by hand; Resend exposes only the name");
    }
  }

  items.sort((a, b) => RESOURCE_ORDER.indexOf(a.resource) - RESOURCE_ORDER.indexOf(b.resource));

  const batches = (n: number): number => Math.ceil(n / BATCH_SIZE);
  const rowWrites = items.filter(
    (i) => (i.action === "create" || i.action === "update") && i.count === undefined,
  ).length;
  const writes =
    rowWrites +
    // The lookup of the source's addresses on the target, then the upsert itself.
    batches(contactCount) * 2 +
    batches(suppressionCount) +
    (enrichment ? facets.length * batches(enrichCount) : 0);
  // The whole run, as `apply` does it (it reads the source again): every source request, spent or
  // still to come, goes at `rps`; target writes go at their own 10/s. Count and time cover the same requests.
  const reads =
    options.sourceRequestsSpent + (enrichment ? estimateSourceRequests(snapshot).enrichment : 0);
  const requests = reads + writes;
  const seconds = Math.ceil(reads / options.rps + writes / 10);

  return {
    version: 2,
    createdAt: (options.now ?? new Date()).toISOString(),
    source: snapshot.provider,
    target: {
      baseUrl: options.baseUrl,
      plan: target.usage.plan,
    },
    options: {
      only: options.only,
      skip: options.skip,
      segment: options.segment,
      onConflict: options.onConflict,
      includeSent: options.includeSent,
      freshWebhookSecrets: options.freshWebhookSecrets,
    },
    scope: snapshot.segmentScope === null ? null : { segments: snapshot.segmentScope },
    rps: options.rps,
    items,
    estimate: { requests, seconds },
    warnings,
    ...summarize(items),
  };
}

function summarize(items: PlanItem[]): Pick<Plan, "counts" | "manual"> {
  const counts: Record<PlanAction, number> = {
    create: 0,
    update: 0,
    unchanged: 0,
    manual: 0,
    skip: 0,
  };
  for (const item of items) counts[item.action] += 1;
  return {
    counts,
    manual: items
      .filter((i) => i.action === "manual")
      .map((i) => ({ title: `${i.resource}/${i.key}`, detail: i.detail ?? "" })),
  };
}

const DNS_AFTER_APPLY = "add DNS records (shown after apply)";

/**
 * Keeps the first `allowed` domain creates and turns the rest into manual
 * items (the plan's domain cap); their DNS reminder goes with them.
 */
export function capDomainCreates(plan: Plan, allowed: number): Plan {
  let kept = 0;
  const capped = new Set<string>();
  const items = plan.items.flatMap((item): PlanItem[] => {
    if (item.resource !== "domains") return [item];
    if (item.action === "create") {
      if (kept < allowed) {
        kept += 1;
        return [item];
      }
      capped.add(item.key);
      return [
        {
          resource: "domains",
          action: "manual",
          key: item.key,
          detail: "over the plan's domain limit; add by hand after upgrading",
        },
      ];
    }
    if (item.action === "manual" && item.detail === DNS_AFTER_APPLY && capped.has(item.key)) {
      return [];
    }
    return [item];
  });
  return { ...plan, items, ...summarize(items) };
}

function webhookUpdate(
  existing: TargetWebhook,
  events: TargetWebhookEvent[],
  status: string,
): { events?: TargetWebhookEvent[]; status?: string } | null {
  const update: { events?: TargetWebhookEvent[]; status?: string } = {};
  if (!sameSet(existing.events, events)) update.events = events;
  if ((status === "enabled" || status === "disabled") && status !== existing.status)
    update.status = status;
  return Object.keys(update).length > 0 ? update : null;
}

export interface PlanRow {
  action: PlanAction;
  /** The item's key, or "11 broadcasts" for a collapsed run. */
  name: string;
  detail?: string | undefined;
  /** Keys of the items folded into this row, in plan order. */
  keys?: string[] | undefined;
}

export interface PlanGroup {
  resource: Resource;
  /** "topics", or "contacts (721)" for a count item. */
  label: string;
  rows: PlanRow[];
}

const COLLAPSE_AT = 3;

/**
 * Items grouped by resource in apply order; a run of ≥3 items sharing action
 * and detail folds into one row (a tail of sent broadcasts reads as one line).
 * Creates and updates never fold: their names are what the user reviews
 * before confirming. Presentation only — the plan's items are untouched.
 */
export function groupPlanItems(items: readonly PlanItem[]): PlanGroup[] {
  const runKey = (i: PlanItem): string => `${i.action}\0${i.detail ?? ""}`;
  const groups: PlanGroup[] = [];
  for (const resource of RESOURCE_ORDER) {
    const own = items.filter((i) => i.resource === resource);
    if (own.length === 0) continue;
    const sizes = new Map<string, number>();
    for (const i of own) sizes.set(runKey(i), (sizes.get(runKey(i)) ?? 0) + 1);
    const folded = new Set<string>();
    const rows: PlanRow[] = [];
    for (const item of own) {
      const key = runKey(item);
      const writes = item.action === "create" || item.action === "update";
      if (writes || (sizes.get(key) ?? 0) < COLLAPSE_AT) {
        rows.push({ action: item.action, name: item.key, detail: item.detail });
      } else if (!folded.has(key)) {
        folded.add(key);
        const keys = own.filter((i) => runKey(i) === key).map((i) => i.key);
        rows.push({
          action: item.action,
          name: `${formatNumber(keys.length)} ${resource}`,
          detail: item.detail,
          keys,
        });
      }
    }
    const counted = own.filter((i) => i.count !== undefined);
    const count = counted.reduce((n, i) => n + (i.count ?? 0), 0);
    groups.push({
      resource,
      label: counted.length === 0 ? resource : `${resource} (${formatNumber(count)})`,
      rows,
    });
  }
  return groups;
}

const ACTION_STYLE: Record<PlanAction, [symbol: string, paint: (s: string) => string]> = {
  create: [SYM.create, ok],
  update: [SYM.update, warn],
  unchanged: [SYM.same, dim],
  manual: [SYM.manual, note],
  skip: [SYM.skip, dim],
};

const ACTIONS: readonly PlanAction[] = ["create", "update", "unchanged", "manual", "skip"];

function renderRow(row: PlanRow): string[] {
  const [symbol, paint] = ACTION_STYLE[row.action];
  const head = `  ${paint(symbol)} ${stripControl(row.name)}`;
  const lines = [
    row.detail === undefined
      ? head
      : wrapIndent(dim(stripControl(row.detail)), { indent: `${head}  `, hanging: "    " }),
  ];
  if (row.keys) lines.push(wrapIndent(dim(foldedKeysLine(row.keys)), { indent: "    " }));
  return lines;
}

/** `name1, name2 … and N more` — the continuation under a collapsed row. */
export const foldedKeysLine = (keys: readonly string[]): string =>
  `${keys.slice(0, 2).map(stripControl).join(", ")} … and ${formatNumber(keys.length - 2)} more`;

/** What --segment limited the plan to, in one sentence. */
export const scopeLine = (scope: NonNullable<Plan["scope"]>): string =>
  `Scope (--segment): only ${scope.segments.map((s) => s.name).join(", ")} and ${
    scope.segments.length === 1 ? "its" : "their"
  } members; contacts and the enrichment pass cover those contacts alone.`;

/** Legend, items grouped by resource, totals, warnings, estimate. */
export function renderPlan(plan: Plan): string {
  const c = plan.counts;
  const n = (count: number): string => (count > 0 ? bold(formatNumber(count)) : "0");
  const lines = [
    dim(ACTIONS.map((a) => `${ACTION_STYLE[a][0]} ${a}`).join("   ")),
    "",
    ...(plan.scope === null ? [] : [wrapIndent(dim(scopeLine(plan.scope)), { hanging: "  " }), ""]),
    ...groupPlanItems(plan.items).flatMap((g) => [g.label, ...g.rows.flatMap(renderRow)]),
    "",
    wrapIndent(
      `Plan: ${n(c.create)} to create, ${n(c.update)} to update, ${n(c.unchanged)} unchanged, ${n(c.manual)} manual${c.skip > 0 ? `, ${n(c.skip)} skipped` : ""}.`,
      { hanging: "  " },
    ),
    ...plan.warnings.map((w) => wrapIndent(warn(`warning: ${w}`), { hanging: "  " })),
    wrapIndent(
      dim(
        `Estimate: ~${formatNumber(plan.estimate.requests)} requests · ${formatDuration(plan.estimate.seconds)} at ${plan.rps} req/s`,
      ),
      { hanging: "  " },
    ),
  ];
  return `${lines.join("\n")}\n`;
}

/** sha256 of the canonical items JSON — the state file binds itself to this. */
export function planHash(plan: Plan): string {
  return createHash("sha256").update(canonicalJson(plan.items)).digest("hex");
}

export const serializePlan = (plan: Plan): string => `${JSON.stringify(plan, null, 2)}\n`;

export function parsePlan(text: string): Plan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("plan file is not valid JSON");
  }
  const plan = parsed as Partial<Plan> | null;
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.items)) {
    throw new Error("plan file is not a migration plan");
  }
  if (plan.version !== PLAN_VERSION) {
    throw new Error(
      `plan file version ${String(plan.version)} is not supported (expected ${PLAN_VERSION})`,
    );
  }
  if (plan.options === null || typeof plan.options !== "object") {
    throw new Error("plan file is not a migration plan");
  }
  return plan as Plan;
}

/** How the items of two plans differ, one line per `resource/key`, in the first plan's order then the second's. */
export function describePlanDiff(saved: Plan, current: Plan): string[] {
  const label = (i: PlanItem): string => `${i.resource}/${i.key}`;
  const byLabel = (plan: Plan): Map<string, PlanItem> =>
    new Map(plan.items.map((i) => [label(i), i]));
  const before = byLabel(saved);
  const after = byLabel(current);
  const lines: string[] = [];
  for (const [name, a] of before) {
    const b = after.get(name);
    if (b === undefined) lines.push(`${name}: in the file, not in the current plan`);
    else if (canonicalJson(a) !== canonicalJson(b)) {
      const count =
        a.count !== b.count
          ? `, ${formatNumber(a.count ?? 0)} → ${formatNumber(b.count ?? 0)}`
          : "";
      lines.push(
        `${name}: ${a.action} → ${b.action}${a.action === b.action && count === "" ? " (details differ)" : count}`,
      );
    }
  }
  for (const name of after.keys()) {
    if (!before.has(name)) lines.push(`${name}: not in the file, in the current plan`);
  }
  return lines;
}
