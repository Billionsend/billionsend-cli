import {
  BATCH_MAX,
  type BillionSendTarget,
  type ContactBatchItem,
  type WriteResult,
} from "./billionsend.js";
import type { Logger } from "./log.js";
import type {
  DnsRecord,
  MigrateState,
  Plan,
  PlanItem,
  Resource,
  Snapshot,
  SourceContact,
} from "./model.js";
import type {
  BroadcastPayload,
  DomainPayload,
  PropertyPayload,
  SegmentPayload,
  TemplatePayload,
  TopicPayload,
  WebhookPayload,
} from "./plan.js";
import type { Progress, StepHandle } from "./progress.js";
import type { EnrichFacet, Source } from "./providers/index.js";
import { cutoverReadyLines } from "./report.js";
import { dim, warn } from "./theme.js";
import { chunk, formatNumber, pluralize } from "./utils.js";

export interface ResourceCounts {
  created: number;
  updated: number;
  /**
   * Contacts the batch endpoint matched to an existing contact: it answers
   * created, updated or skipped and never says whether anything changed, so
   * those are counted as matched, not as updated or unchanged.
   */
  matched: number;
  unchanged: number;
  skipped: number;
  manual: number;
  failed: number;
}
export type Counts = Partial<Record<Resource, ResourceCounts>>;

export interface ApplyOutcome {
  state: MigrateState;
  counts: Counts;
  /** Minted this run; printed once, never written to a file. */
  freshSecrets: { endpoint: string; secret: string }[];
  /** DNS records of the domains created this run, as the target reports them. */
  domainRecords: Record<string, DnsRecord[]>;
  /** Source id → target id for the resources code refers to by id. */
  ids: IdMapping[];
  /** Contacts that received at least one property / one topic subscription this run. */
  enrichment: {
    withProperties: number;
    withTopics: number;
    /** Property keys left out because they differ from another key only in case, with the contacts that had a value for each. */
    droppedProperties: DroppedProperty[];
  };
}

export interface DroppedProperty {
  key: string;
  /** The key kept: BillionSend property keys ignore case. */
  collidesWith: string;
  contacts: number;
}

export interface IdMapping {
  resource: "topics" | "segments";
  name: string;
  sourceId: string;
  targetId: string;
}

export interface ApplyInput {
  plan: Plan;
  snapshot: Snapshot;
  /** Resources this run covers; the cutover-ready block needs contacts, domains and suppressions among them. */
  include?: ReadonlySet<Resource> | undefined;
  source: Source;
  target: BillionSendTarget;
  state: MigrateState;
  onConflict: "upsert" | "skip" | "error";
  progress: Progress;
  log: Logger;
  /** Called after every write so an interrupt leaves the file consistent. */
  save: (state: MigrateState) => void;
}

/** Reverse dependency order: nothing is deleted before what refers to it. */
export const ROLLBACK_ORDER: Resource[] = [
  "broadcasts",
  "templates",
  "webhooks",
  "contacts",
  "segments",
  "topics",
  "properties",
  "suppressions",
  "domains",
];

export const RESOURCE_LABEL: Record<Resource, string> = {
  properties: "Contact properties",
  topics: "Topics",
  segments: "Segments",
  domains: "Domains",
  webhooks: "Webhooks",
  templates: "Templates",
  contacts: "Contacts",
  enrichment: "Enrichment",
  broadcasts: "Broadcasts",
  suppressions: "Suppressions",
  "api-keys": "API keys",
};

/** What "cutover ready" presumes is on the target; a run that left one out is not a cutover. */
const CUTOVER_RESOURCES: readonly Resource[] = ["contacts", "domains", "suppressions"];

/** The two enrichment passes, as the progress lines name them. */
export const ENRICHMENT_LABEL: Record<EnrichFacet, string> = {
  topics: "Enrichment · topics",
  properties: "Enrichment · properties",
};

const emptyCounts = (): ResourceCounts => ({
  created: 0,
  updated: 0,
  matched: 0,
  unchanged: 0,
  skipped: 0,
  manual: 0,
  failed: 0,
});

const finish = (step: StepHandle, failed: number, total: number): void => {
  if (failed > 0) step.fail(`${formatNumber(failed)} of ${formatNumber(total)} failed`);
  else step.done();
};

/**
 * How a contact's topics are written. `created` is a first enrichment and
 * carries the full topic list; `updated` is a later sync and only carries
 * opt-outs, so an opt-out made on the target after the first pass is never
 * flipped back to opt_in; `pending` is a contact this tool created that no
 * enrichment run has finished for yet (a contacts-only run came first, or its
 * enrichment failed): opt-outs, plus the opt-ins that matter, those on topics
 * that default to opt_out. An opt-in on a topic that defaults to opt_in changes
 * nothing for a new contact, and could undo an opt-out made since.
 */
export type EnrichmentMode = "created" | "pending" | "updated";

/** The enrichment upsert for one contact; see EnrichmentMode for what each mode carries. */
export function enrichmentItem(
  c: SourceContact,
  mode: EnrichmentMode,
  maps: {
    /** Source property key → the key to write it under on the target. */
    propertyKeys: ReadonlyMap<string, string>;
    topicBySource: ReadonlyMap<string, string>;
    /** Source ids of the topics that default to opt_out: an explicit opt_in changes something there. */
    optOutByDefault?: ReadonlySet<string> | undefined;
  },
  facets: readonly EnrichFacet[] = ["properties", "topics"],
): ContactBatchItem {
  const properties = facets.includes("properties")
    ? Object.fromEntries(
        Object.entries(c.properties ?? {}).flatMap(([key, value]) => {
          const targetKey = maps.propertyKeys.get(key);
          return targetKey === undefined ? [] : [[targetKey, value]];
        }),
      )
    : {};
  const topics = facets.includes("topics")
    ? (c.topics ?? []).flatMap((t) => {
        const id = maps.topicBySource.get(t.id);
        if (id === undefined) return [];
        if (t.subscription === "opt_out" || mode === "created") {
          return [{ id, subscription: t.subscription }];
        }
        // A later sync sends opt-outs only, so one made on the target is never flipped back. A
        // contact still waiting for its first enrichment also gets the opt-ins that matter: on a
        // topic that defaults to opt_out, dropping one leaves the contact unsubscribed.
        return mode === "pending" && maps.optOutByDefault?.has(t.id) === true
          ? [{ id, subscription: t.subscription }]
          : [];
      })
    : [];
  return {
    email: c.email,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(topics.length > 0 ? { topics } : {}),
  };
}

/** Writes the plan to the target in dependency order; one failed item never stops the run. */
export async function applyPlan(input: ApplyInput): Promise<ApplyOutcome> {
  const { plan, snapshot, source, target, state, progress, log } = input;
  const counts: Counts = {};
  const tally = (resource: Resource): ResourceCounts => {
    counts[resource] ??= emptyCounts();
    return counts[resource];
  };
  const created = (resource: Resource, id: string): void => {
    state.created[resource] ??= [];
    state.created[resource].push(id);
    tally(resource).created += 1;
  };
  const failed = (
    resource: Resource,
    key: string,
    { message, statusCode }: { message: string; statusCode?: number | undefined },
  ): void => {
    // Listed once, in the summary and the report; no per-item line on stderr as well.
    state.failures.push({ resource, key, message, statusCode });
    tally(resource).failed += 1;
  };
  // Addresses of contacts this tool created that no enrichment run has finished for (see MigrateState).
  const pending = new Set(state.progress.pendingEnrichment ?? []);
  const save = (): void => {
    state.updatedAt = new Date().toISOString();
    if (pending.size > 0) state.progress.pendingEnrichment = [...pending];
    else delete state.progress.pendingEnrichment;
    input.save(state);
  };
  const outcome: ApplyOutcome = {
    state,
    counts,
    freshSecrets: [],
    domainRecords: {},
    ids: [],
    enrichment: { withProperties: 0, withTopics: 0, droppedProperties: [] },
  };

  // Target ids by name (broadcast references) and by source id (contact associations).
  const topicByName = new Map<string, string>();
  const topicBySource = new Map<string, string>();
  const segmentByName = new Map<string, string>();
  const segmentBySource = new Map<string, string>();
  const propertyKeys = new Map<string, string>();
  /** Source property keys that were not created because another key differs from them only in case. */
  const collidingKeys = new Map<string, string>();
  const registerTopic = (name: string, id: string): void => {
    topicByName.set(name, id);
    const sourceTopic = snapshot.topics.find((t) => t.name === name);
    if (sourceTopic) topicBySource.set(sourceTopic.id, id);
  };
  const registerSegment = (name: string, id: string): void => {
    segmentByName.set(name, id);
    const sourceSegment = snapshot.segments.find((s) => s.name === name);
    if (sourceSegment) segmentBySource.set(sourceSegment.id, id);
  };
  for (const item of plan.items) {
    // The contacts' own numbers are what the batch endpoint answers per contact, never the plan's items.
    if (item.resource !== "contacts") {
      if (item.action === "unchanged") tally(item.resource).unchanged += 1;
      else if (item.action === "manual") tally(item.resource).manual += 1;
      else if (item.action === "skip") tally(item.resource).skipped += 1;
    }
    if (item.resource === "properties" && item.action === "manual") {
      const collidesWith = (item.payload as { collidesWith?: string } | undefined)?.collidesWith;
      if (collidesWith !== undefined) collidingKeys.set(item.key, collidesWith);
    }
    if (item.targetId === undefined) continue;
    if (item.resource === "topics") registerTopic(item.key, item.targetId);
    else if (item.resource === "segments") registerSegment(item.key, item.targetId);
    else if (item.resource === "properties") {
      // An existing key that differs only in case is the same property: write under its spelling.
      const targetKey = (item.payload as { targetKey?: string } | undefined)?.targetKey;
      propertyKeys.set(item.key, targetKey ?? item.key);
    }
  }

  async function runRows(
    resource: Resource,
    run: (item: PlanItem) => Promise<WriteResult<{ id: string }>>,
  ): Promise<void> {
    const items = plan.items.filter(
      (i) => i.resource === resource && (i.action === "create" || i.action === "update"),
    );
    if (items.length === 0) return;
    const step = progress.step(RESOURCE_LABEL[resource]);
    let n = 0;
    let failures = 0;
    for (const item of items) {
      const result = await run(item);
      if (result.ok) {
        if (item.action === "create") created(resource, result.id);
        else tally(resource).updated += 1;
      } else {
        failed(resource, item.key, { message: result.message, statusCode: result.status });
        failures += 1;
      }
      step.update(++n, items.length);
      save();
    }
    finish(step, failures, items.length);
  }

  await runRows("properties", async (item) => {
    const p = item.payload as PropertyPayload;
    const result = await target.createProperty({
      key: p.key,
      type: p.type,
      fallbackValue: p.fallback_value,
    });
    if (result.ok) propertyKeys.set(p.key, p.key);
    return result;
  });

  await runRows("topics", async (item) => {
    if (item.action === "update") {
      return target.updateTopic(item.targetId ?? "", item.payload as { description: string });
    }
    const p = item.payload as TopicPayload;
    const result = await target.createTopic({
      name: p.name,
      description: p.description,
      defaultSubscription: p.default_subscription,
      visibility: p.visibility,
    });
    if (result.ok) registerTopic(p.name, result.id);
    return result;
  });

  await runRows("segments", async (item) => {
    if (item.action === "update") {
      return target.updateSegment(item.targetId ?? "", item.payload as { filter: unknown });
    }
    const p = item.payload as SegmentPayload;
    const result = await target.createSegment({ name: p.name, filter: p.filter });
    if (result.ok) registerSegment(p.name, result.id);
    return result;
  });

  await runRows("domains", async (item) => {
    const { create, tracking } = item.payload as DomainPayload;
    const result = await target.createDomain({
      name: create.name,
      customReturnPath: create.custom_return_path,
    });
    if (!result.ok) return result;
    outcome.domainRecords[create.name] = result.records;
    const patched = await target.updateDomainTracking(result.id, {
      openTracking: tracking.open_tracking,
      clickTracking: tracking.click_tracking,
      trackingSubdomain: tracking.tracking_subdomain,
    });
    if (patched.ok) outcome.domainRecords[create.name] = patched.records;
    else
      failed("domains", create.name, {
        message: `created, but tracking settings failed: ${patched.message}`,
        statusCode: patched.status,
      });
    return result;
  });

  await runRows("webhooks", async (item) => {
    if (item.action === "update") {
      return target.updateWebhook(
        item.targetId ?? "",
        item.payload as { events?: string[]; status?: "enabled" | "disabled" },
      );
    }
    const p = item.payload as WebhookPayload;
    const copied =
      p.signingSecret === "copy"
        ? (snapshot.webhooks.find((w) => w.id === p.sourceId)?.signingSecret ?? null)
        : null;
    const result = await target.createWebhook({
      endpoint: p.endpoint,
      events: p.events,
      signingSecret: copied,
    });
    if (result.ok && copied === null) {
      outcome.freshSecrets.push({ endpoint: p.endpoint, secret: result.signingSecret });
    }
    return result;
  });

  await runRows("templates", (item) =>
    item.action === "update"
      ? target.updateTemplate(
          item.targetId ?? "",
          item.payload as { name: string; alias: string | null },
        )
      : target.createTemplate(item.payload as TemplatePayload),
  );

  // Pass 1 result per address; enrichment leaves skipped/failed contacts alone.
  const pass1 = new Map<string, "created" | "updated" | "skipped" | "failed">();
  if (plan.items.some((i) => i.resource === "contacts") && snapshot.contacts.length > 0) {
    const step = progress.step(RESOURCE_LABEL.contacts);
    const membership = new Map<string, { id: string }[]>();
    for (const segment of snapshot.segments) {
      const id = segmentBySource.get(segment.id);
      if (id === undefined) continue;
      for (const email of segment.memberEmails) {
        const key = email.toLowerCase();
        const list = membership.get(key) ?? [];
        list.push({ id });
        membership.set(key, list);
      }
    }
    const total = snapshot.contacts.length;
    const cursor = state.progress.contactsCursor ?? null;
    let done = cursor === null ? 0 : snapshot.contacts.findIndex((c) => c.id === cursor) + 1;
    if (done > 0) step.note(`resuming after ${formatNumber(done)} contacts done in an earlier run`);
    step.update(done, total);
    for (const slice of chunk(snapshot.contacts.slice(done), BATCH_MAX)) {
      const items = slice.map(
        (c): ContactBatchItem => ({
          email: c.email,
          first_name: c.firstName ?? undefined,
          last_name: c.lastName ?? undefined,
          unsubscribed: c.unsubscribed,
          segments: membership.get(c.email.toLowerCase()),
        }),
      );
      const out = await target.batchContacts(items, { onConflict: input.onConflict });
      for (const row of out.data) {
        const contact = slice[row.index];
        if (contact === undefined) continue;
        pass1.set(contact.email.toLowerCase(), row.status);
        if (row.status === "created") {
          created("contacts", row.id);
          pending.add(contact.email.toLowerCase());
        } else if (row.status === "updated") tally("contacts").matched += 1;
        else tally("contacts").skipped += 1;
      }
      for (const error of out.errors) {
        const contact = slice[error.index];
        pass1.set(contact?.email.toLowerCase() ?? "", "failed");
        failed("contacts", contact?.email ?? `#${error.index}`, error);
      }
      done += slice.length;
      state.progress.contactsCursor = slice.at(-1)?.id ?? null;
      step.update(done, total);
      save();
    }
    state.progress.contactsCursor = null;
    save();
    finish(step, tally("contacts").failed, total);
  }

  await runRows("broadcasts", (item) => {
    const { input: b, segmentName, topicName } = item.payload as BroadcastPayload;
    return target.createBroadcast({
      name: b.name,
      from: b.from,
      subject: b.subject,
      html: b.html,
      text: b.text,
      replyTo: b.reply_to,
      previewText: b.preview_text,
      segmentId: segmentName === null ? null : segmentByName.get(segmentName),
      topicId: topicName === null ? null : topicByName.get(topicName),
    });
  });

  if (plan.items.some((i) => i.resource === "suppressions") && snapshot.suppressions.length > 0) {
    const step = progress.step(RESOURCE_LABEL.suppressions);
    const existing = new Set(await target.listSuppressionIds());
    const total = snapshot.suppressions.length;
    let done = 0;
    for (const origin of ["bounce", "complaint", "manual"] as const) {
      const rows = snapshot.suppressions.filter((s) => s.origin === origin);
      for (const slice of chunk(rows, BATCH_MAX)) {
        const out = await target.addSuppressions(
          slice.map((s) => s.email),
          origin,
        );
        for (const id of out.ids) {
          if (existing.has(id)) {
            tally("suppressions").unchanged += 1;
          } else {
            existing.add(id);
            created("suppressions", id);
          }
        }
        for (const error of out.errors) {
          failed("suppressions", slice[error.index]?.email ?? `#${error.index}`, error);
        }
        done += slice.length;
        step.update(done, total);
        save();
      }
    }
    state.progress.suppressionsDone = true;
    save();
    finish(step, tally("suppressions").failed, total);
  }

  if (plan.items.some((i) => i.resource === "enrichment")) {
    // Until both passes have reached the end once, no contact counts as enriched
    // (an interrupted first run resumes with the full topic list); afterwards
    // only contacts created in this run are new.
    const synced = state.progress.enrichmentCompleted === true;
    const enrichedIds = new Set<string>();
    const failedIds = new Set<string>();
    const total = snapshot.contacts.length;
    const droppedContacts = new Map<string, number>();
    const optOutByDefault = new Set(
      snapshot.topics.filter((t) => t.defaultSubscription === "opt_out").map((t) => t.id),
    );
    // Opt-outs first: a broadcast sent between the passes must reach nobody who left.
    const passes: {
      facet: EnrichFacet;
      ledger: "topicsDone" | "enrichmentDone";
      wanted: boolean;
      skipped: string;
    }[] = [
      {
        facet: "topics",
        ledger: "topicsDone",
        wanted: snapshot.topics.length > 0 && topicBySource.size > 0,
        skipped: snapshot.topics.length === 0 ? "no topics on the source" : "topics not migrated",
      },
      {
        facet: "properties",
        ledger: "enrichmentDone",
        wanted: snapshot.properties.length > 0 && propertyKeys.size > 0,
        skipped:
          snapshot.properties.length === 0
            ? "no contact properties on the source"
            : "contact properties not migrated",
      },
    ];
    if (passes.some((p) => p.wanted)) {
      const leftOut = CUTOVER_RESOURCES.filter((r) => input.include?.has(r) === false);
      const lines =
        leftOut.length === 0
          ? cutoverReadyLines(plan.source, plan.target.baseUrl, outcome.domainRecords, plan)
          : [
              "",
              dim(
                `Enrichment follows. This run left out ${leftOut.join(", ")}, so it is not a cutover; run without --only for the cutover-ready checklist.`,
              ),
            ];
      for (const line of lines) progress.line(line);
      progress.line("");
    }
    /**
     * An opt-out a contact made on BillionSend stays: an opt-in is never written over
     * an explicit opt-out there. A contact created in this very run has none to keep.
     */
    const keepTargetOptOuts = async (
      entries: { item: ContactBatchItem; created: boolean }[],
    ): Promise<void> => {
      const asking = entries.filter(
        (e) => !e.created && e.item.topics?.some((t) => t.subscription === "opt_in") === true,
      );
      if (asking.length === 0) return;
      const optedOut = await target.explicitOptOuts(asking.map((e) => e.item.email));
      for (const e of asking) {
        const kept = optedOut.get(e.item.email.toLowerCase());
        if (kept !== undefined) {
          e.item.topics = e.item.topics?.filter(
            (t) => t.subscription !== "opt_in" || !kept.has(t.id),
          );
        }
      }
    };
    for (const pass of passes) {
      if (!pass.wanted) {
        progress.line(dim(`${ENRICHMENT_LABEL[pass.facet]}: skipped, ${pass.skipped}`));
        continue;
      }
      const step = progress.step(ENRICHMENT_LABEL[pass.facet]);
      const doneIds = new Set(state.progress[pass.ledger] ?? []);
      if (doneIds.size > 0) {
        step.note(
          `resuming: skipping ${pluralize(doneIds.size, "contact")} enriched in an earlier run`,
        );
      }
      const failedBefore = failedIds.size;
      let processed = 0;
      let withValues = 0;
      let buffer: { id: string; item: ContactBatchItem; created: boolean }[] = [];
      const flush = async (): Promise<void> => {
        if (pass.facet === "topics") await keepTargetOptOuts(buffer);
        const sendable = buffer.filter(
          (b) => b.item.properties !== undefined || b.item.topics !== undefined,
        );
        const failedNow = new Set<string>();
        if (sendable.length > 0) {
          const out = await target.batchContacts(
            sendable.map((b) => b.item),
            { onConflict: "upsert" },
          );
          for (const error of out.errors) {
            const entry = sendable[error.index];
            if (entry !== undefined) {
              failedNow.add(entry.id);
              failedIds.add(entry.id);
            }
            failed("enrichment", entry?.item.email ?? `#${error.index}`, error);
          }
          // The upsert creates a contact the contacts pass never saw (a signup
          // since the last run); it is ours to roll back like any other.
          for (const row of out.data) if (row.status === "created") created("contacts", row.id);
          withValues += sendable.length - failedNow.size;
          for (const b of sendable) if (!failedNow.has(b.id)) enrichedIds.add(b.id);
        }
        for (const b of buffer) if (!failedNow.has(b.id)) doneIds.add(b.id);
        // A contact is counted once however many passes wrote or failed it.
        tally("enrichment").updated = enrichedIds.size;
        tally("enrichment").failed = failedIds.size;
        state.progress[pass.ledger] = [...doneIds];
        buffer = [];
        save();
      };
      await source.enrichContacts(snapshot, {
        alreadyDone: doneIds,
        facets: [pass.facet],
        onProgress: (event) => step.update(event.n, event.total),
        onContact: async (contact) => {
          const status = pass1.get(contact.email.toLowerCase());
          if (status === "failed" || status === "skipped") return;
          processed += 1;
          if (pass.facet === "properties") {
            for (const [key, value] of Object.entries(contact.properties ?? {})) {
              if (collidingKeys.has(key) && String(value) !== "") {
                droppedContacts.set(key, (droppedContacts.get(key) ?? 0) + 1);
              }
            }
          }
          const item = enrichmentItem(
            contact,
            status === "created" || !synced
              ? "created"
              : pending.has(contact.email.toLowerCase())
                ? "pending"
                : "updated",
            { propertyKeys, topicBySource, optOutByDefault },
            [pass.facet],
          );
          // Without a contacts pass this run, the upsert may create the contact:
          // it must carry the unsubscribed flag (and names) rather than land
          // subscribed with only its properties. The API never re-subscribes.
          if (status === undefined) {
            item.unsubscribed = contact.unsubscribed;
            item.first_name = contact.firstName ?? undefined;
            item.last_name = contact.lastName ?? undefined;
          }
          buffer.push({ id: contact.id, item, created: status === "created" });
          if (buffer.length >= BATCH_MAX) await flush();
        },
      });
      await flush();
      const noun = pass.facet === "properties" ? "properties" : "topic subscriptions";
      if (pass.facet === "properties") outcome.enrichment.withProperties = withValues;
      else outcome.enrichment.withTopics = withValues;
      if (pass.facet === "properties" && processed > 0 && withValues === 0) {
        const message = "no contact carried a property value — check the source shape";
        step.note(warn(message));
        log.warn(message);
      }
      const failedInPass = failedIds.size - failedBefore;
      if (failedInPass > 0) {
        step.fail(`${formatNumber(failedInPass)} of ${formatNumber(total)} failed`);
      } else {
        step.done(`${formatNumber(total)} · ${formatNumber(withValues)} with ${noun}`);
      }
    }
    outcome.enrichment.droppedProperties = [...collidingKeys].map(([key, collidesWith]) => ({
      key,
      collidesWith,
      contacts: droppedContacts.get(key) ?? 0,
    }));
    // A contact the topics pass reached without a failure is enriched; a failed one stays pending.
    // Without a topics pass (excluded from this run) nothing was written, so nobody leaves the list;
    // with no topics on the source there is nothing left to wait for.
    if (snapshot.topics.length === 0) pending.clear();
    else if (passes.some((p) => p.facet === "topics" && p.wanted)) {
      for (const c of snapshot.contacts) {
        const email = c.email.toLowerCase();
        const status = pass1.get(email);
        if (status === "failed" || status === "skipped") continue;
        if (failedIds.has(c.id)) pending.add(email);
        else pending.delete(email);
      }
    }
    state.progress.enrichmentCompleted = true;
    if (tally("enrichment").failed === 0) {
      delete state.progress.enrichmentDone;
      delete state.progress.topicsDone;
      state.progress.contactsCursor = null;
    }
    save();
  }

  const mapping = (
    resource: IdMapping["resource"],
    rows: { id: string; name: string }[],
    bySource: ReadonlyMap<string, string>,
  ): IdMapping[] =>
    rows.flatMap((row) => {
      const targetId = bySource.get(row.id);
      return targetId === undefined
        ? []
        : [{ resource, name: row.name, sourceId: row.id, targetId }];
    });
  outcome.ids = [
    ...mapping("topics", snapshot.topics, topicBySource),
    ...mapping("segments", snapshot.segments, segmentBySource),
  ];
  return outcome;
}
