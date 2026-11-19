import type { ApplyOutcome, Counts, DroppedProperty, IdMapping, ResourceCounts } from "./apply.js";
import type { OutStream } from "./context.js";
import { CLOUD_API_URL, CLOUD_BILLING_URL, TRADEMARK_NOTICE } from "./meta.js";
import {
  type DnsRecord,
  type MigrateState,
  type Plan,
  type PlanItem,
  type ProviderId,
  RESOURCES,
  type Resource,
  type Snapshot,
  type TargetState,
  type TargetUsage,
} from "./model.js";
import { type MigratePaths, writePrivate, writePrivateJson } from "./paths.js";
import { type DomainPayload, foldedKeysLine, groupPlanItems, scopeLine } from "./plan.js";
import { countUp } from "./progress.js";
import { bold, dim, err, heading, info, note, SYM, shortId, wrapIndent } from "./theme.js";
import { returnPathNote } from "./translate.js";
import {
  capitalize,
  formatDuration,
  formatNumber,
  pluralize,
  retryableStatus,
  stripControlDeep,
} from "./utils.js";

export interface Offer {
  emailsLast30Days: number | null;
  perDay: number | null;
  domains: number;
  plan: string;
  fits: string | null;
  url: string;
  text: string[];
}

export interface Report {
  version: 1;
  finishedAt: string;
  source: ProviderId;
  sourceLabel: string;
  target: { baseUrl: string; plan: string | null };
  /** What --segment limited the run to; null for the whole account. */
  scope: Plan["scope"];
  counts: Counts;
  /** Contacts that received at least one property / one topic subscription in the enrichment passes, and the property values left out. */
  enrichment?:
    | {
        withProperties: number;
        withTopics: number;
        droppedProperties?: DroppedProperty[] | undefined;
      }
    | undefined;
  /** The source was only read; nothing there was changed. */
  sourceReadOnly: true;
  /** Minted this run. Printed once and part of the --json output; stripped from the files. */
  freshWebhookSecrets: { endpoint: string; secret: string }[];
  checklist: { done: string[]; left: string[] };
  /** Our DNS records per domain that still needs them. */
  dns: { domain: string; records: DnsRecord[]; note: string | null }[];
  apiKeys: string[];
  /** Source id → target id for topics and segments, the resources code refers to by id. */
  ids: IdMapping[];
  manual: Plan["manual"];
  failures: MigrateState["failures"];
  offer: Offer | null;
  trademark: string;
}

interface PlanRow {
  id: string;
  label: string;
  /** Emails a rung lets through in 30 days: a daily cap times 30, or the monthly volume; null = unlimited. */
  perMonth: number | null;
  domains: number | null;
  contacts: number | null;
}

/** Above the top rung the volume still fits: the rest bills as overage. */
const TOP: PlanRow = {
  id: "scale",
  label: "Scale 3M",
  perMonth: 3_000_000,
  domains: null,
  contacts: null,
};

/** BillionSend's plan ladder as https://billionsend.com/pricing lists it, cheapest first. */
const PLANS: PlanRow[] = [
  { id: "free", label: "Free", perMonth: 3_000, domains: 3, contacts: 1_000 },
  { id: "starter", label: "Starter", perMonth: 30_000, domains: 10, contacts: null },
  { id: "pro", label: "Pro 60K", perMonth: 60_000, domains: null, contacts: null },
  { id: "pro", label: "Pro 120K", perMonth: 120_000, domains: null, contacts: null },
  { id: "scale", label: "Scale 240K", perMonth: 240_000, domains: null, contacts: null },
  { id: "scale", label: "Scale 600K", perMonth: 600_000, domains: null, contacts: null },
  { id: "scale", label: "Scale 1.2M", perMonth: 1_200_000, domains: null, contacts: null },
  { id: "scale", label: "Scale 1.8M", perMonth: 1_800_000, domains: null, contacts: null },
  TOP,
];

const perMonthText = (n: number | null): string =>
  n === null ? "unlimited" : `${formatNumber(n)}/month`;
const domainsText = (n: number | null): string =>
  n === null ? "unlimited domains" : pluralize(n, "domain");

function buildOffer(
  usage: TargetUsage,
  snapshot: Snapshot,
  domains: number,
  sourceLabel: string,
): Offer | null {
  if (usage.plan === null) return null;
  const sent = snapshot.metrics.emailsLast30Days;
  const perDay = sent === null ? null : Math.ceil(sent / 30);
  const included = usage.limits.emailsPerMonth;
  const current: PlanRow = PLANS.find(
    (p) => p.id === usage.plan && (included === null || p.perMonth === included),
  ) ?? {
    id: usage.plan,
    label: capitalize(usage.plan),
    perMonth:
      included ?? (usage.limits.emailsPerDay === null ? null : usage.limits.emailsPerDay * 30),
    domains: usage.limits.domains,
    contacts: usage.limits.contacts,
  };
  const url = CLOUD_BILLING_URL;
  const short: string[] = [];
  const over = sent !== null && current.perMonth !== null && sent > current.perMonth;
  const volumeShort = over && !usage.overageEnabled;
  if (volumeShort) short.push(`${current.label} allows ${perMonthText(current.perMonth)}`);
  if (current.domains !== null && domains > current.domains) {
    short.push(
      `${current.label} allows ${pluralize(current.domains, "domain")}, you have ${domains}`,
    );
  }
  const contacts = snapshot.contacts.length;
  if (current.contacts !== null && contacts > current.contacts) {
    short.push(
      `${current.label} allows ${pluralize(current.contacts, "contact")}, you have ${formatNumber(contacts)}`,
    );
  }
  if (short.length === 0 && sent === null) return null;
  const text: string[] = [];
  if (sent !== null) {
    text.push(
      `On ${sourceLabel} you sent ${formatNumber(sent)} emails in the last 30 days (~${formatNumber(perDay ?? 0)}/day).`,
    );
  }
  let fits: string | null = current.id;
  if (short.length === 0) {
    text.push(
      over
        ? `${current.label} includes ${perMonthText(current.perMonth)}; the rest bills as overage.`
        : `${current.label} allows ${perMonthText(current.perMonth)}; that covers it.`,
    );
  } else {
    const fit = PLANS.find(
      (p) =>
        (p.perMonth === null || (sent ?? 0) <= p.perMonth) &&
        (p.domains === null || domains <= p.domains) &&
        (p.contacts === null || contacts <= p.contacts),
    );
    fits = fit?.id ?? TOP.id;
    const spec = (p: PlanRow) =>
      `${p.label} (${perMonthText(p.perMonth)}, ${domainsText(p.domains)})`;
    text.push(
      `${short.join("; ")}; ${
        fit ? `${spec(fit)} fits.` : `${spec(TOP)} is the top rung; emails past it bill as overage.`
      } Upgrade: ${url}`,
    );
  }
  return { emailsLast30Days: sent, perDay, domains, plan: current.id, fits, url, text };
}

export function buildReport({
  plan,
  snapshot,
  outcome,
  usage,
  targetState,
  baseUrl,
  sourceLabel,
}: {
  plan: Plan;
  snapshot: Snapshot;
  outcome: ApplyOutcome;
  usage: TargetUsage;
  targetState: TargetState;
  baseUrl: string;
  sourceLabel: string;
}): Report {
  const dns = Object.entries(outcome.domainRecords).map(([domain, records]) => ({
    domain,
    records,
    note: domainReturnPathNote(plan, domain),
  }));
  for (const domain of targetState.domains) {
    if (domain.status === "verified" || domain.name in outcome.domainRecords) continue;
    if (!snapshot.domains.some((d) => d.name === domain.name)) continue;
    dns.push({ domain: domain.name, records: domain.records, note: null });
  }
  const apiKeys = plan.items.filter((i) => i.resource === "api-keys").map((i) => i.key);
  const manual = [
    ...plan.manual.filter(
      (m) => !m.title.startsWith("api-keys/") && !m.detail.startsWith("add DNS records"),
    ),
    ...outcome.enrichment.droppedProperties
      .filter((d) => d.contacts > 0)
      .map((d) => ({
        title: `properties/${d.key}`,
        detail: `${pluralize(d.contacts, "contact")} had a value for it that was not written: BillionSend property keys ignore case and \`${d.collidesWith}\` is the same key`,
      })),
  ];
  const failures = outcome.state.failures;
  const retryable = failures.filter((f) => retryableStatus(f.statusCode)).length;
  const refused = failures.length - retryable;
  const done = (Object.entries(outcome.counts) as [Resource, Counts[Resource]][])
    .filter(([, c]) => c !== undefined && c.failed === 0 && c.created + c.updated + c.unchanged > 0)
    .map(([resource]) => resource);
  const left = [
    ...dns.map((d) => `add DNS records for ${d.domain}`),
    baseUrlStep(plan.source, baseUrl),
    ...(apiKeys.length > 0 ? [`create API keys: ${apiKeys.join(", ")}`] : []),
    ...(outcome.ids.length > 0
      ? [`replace ${sourceLabel} topic and segment ids in your code (id map below)`]
      : []),
    ...(manual.length > 0 ? [`review ${pluralize(manual.length, "manual note")}`] : []),
    ...(retryable > 0 ? [`retry ${pluralize(retryable, "failed item")}`] : []),
    ...(refused > 0
      ? [`review ${pluralize(refused, "refused item")} (see Failed); re-running won't change that`]
      : []),
  ];
  const domains = targetState.domains.length + (outcome.counts.domains?.created ?? 0);
  return {
    version: 1,
    finishedAt: new Date().toISOString(),
    source: plan.source,
    sourceLabel,
    target: { baseUrl, plan: usage.plan },
    scope: plan.scope,
    counts: outcome.counts,
    enrichment: outcome.enrichment,
    sourceReadOnly: true,
    freshWebhookSecrets: outcome.freshSecrets,
    checklist: { done, left },
    dns,
    apiKeys,
    ids: outcome.ids,
    manual,
    failures,
    offer: buildOffer(usage, snapshot, domains, sourceLabel),
    trademark: TRADEMARK_NOTICE,
  };
}

/**
 * The cutover step that points the user's app at BillionSend. The source's SDKs
 * read `<SOURCE>_BASE_URL` for the API address, so the address to put there is
 * BillionSend's public API, not necessarily the URL this run was given: a
 * local or proxy `--to-url` is named as what this run used, not as the value.
 */
export function baseUrlStep(source: ProviderId, baseUrl: string): string {
  const name = `${source.toUpperCase()}_BASE_URL`;
  const step = `set ${name}=${CLOUD_API_URL} in your app, so ${capitalize(source)} SDK calls go to BillionSend`;
  return baseUrl === CLOUD_API_URL
    ? step
    : `${step} (this run used ${baseUrl}; put that address there only if your app reaches BillionSend through it)`;
}

/** What the plan said about a created domain's return path, or null when it created none. */
export function domainReturnPathNote(plan: Plan, domain: string): string | null {
  const item = plan.items.find(
    (i) => i.resource === "domains" && i.action === "create" && i.key === domain,
  );
  const payload = item?.payload as DomainPayload | undefined;
  return payload?.create.custom_return_path === undefined
    ? null
    : returnPathNote(payload.create.custom_return_path, payload.sourceReturnPath);
}

/** One card per record: type and name, then the whole value on its own line (a DKIM key wraps as a block, never cut). */
export function dnsCards(records: DnsRecord[]): string[] {
  return records.flatMap((r, i) => [
    ...(i > 0 ? [""] : []),
    `  ${info(r.type)}  ${r.name}${r.priority === undefined ? "" : dim(`  priority ${r.priority}`)}`,
    `    ${bold(r.value)}`,
  ]);
}

/**
 * Printed as soon as everything but the per-contact enrichment is on the
 * target: sending can move while the enrichment passes are still running.
 */
export function cutoverReadyLines(
  source: ProviderId,
  baseUrl: string,
  domainRecords: Record<string, DnsRecord[]>,
  plan: Plan,
): string[] {
  const lines = [
    "",
    heading("Cutover ready"),
    "Everything but the per-contact enrichment is on BillionSend: transactional sending can move now.",
    "Topic opt-outs and properties land in the enrichment passes below; hold topic sends and broadcasts until they finish.",
    wrapIndent(`${dim("[")} ${dim("]")} ${baseUrlStep(source, baseUrl)}`, {
      indent: "  ",
      hanging: "      ",
    }),
  ];
  for (const [domain, records] of Object.entries(domainRecords)) {
    const note = domainReturnPathNote(plan, domain);
    lines.push(
      "",
      `DNS records for ${domain}:`,
      ...(note === null ? [] : [dim(`${note}.`)]),
      ...dnsCards(records),
    );
  }
  return lines;
}

/** Two lines per pair: the name, then `shortened-source → full-target` (the target id is the thing to copy). */
export function idRows(ids: IdMapping[]): string[] {
  return ids.flatMap((m) => [
    `  ${m.resource}/${m.name}`,
    `    ${dim(shortId(m.sourceId))} → ${bold(m.targetId)}`,
  ]);
}

/** Manual notes folded like the plan: a `resource/key` title is a manual plan item again. */
function manualRows(
  manual: Plan["manual"],
): { title: string; detail: string; names?: string[] | undefined }[] {
  const items: PlanItem[] = manual.map(({ title, detail }) => {
    const slash = title.indexOf("/");
    return {
      resource: title.slice(0, slash) as Resource,
      action: "manual",
      key: title.slice(slash + 1),
      detail,
    };
  });
  return groupPlanItems(items).flatMap((g) =>
    g.rows.map((row) => ({
      title: row.keys === undefined ? `${g.resource}/${row.name}` : row.name,
      detail: row.detail ?? "",
      names: row.keys,
    })),
  );
}

/** Digit runs outside URLs in bold, so the counts stand out of a sentence. */
const boldNumbers = (text: string): string =>
  text
    .split(" ")
    .map((word) => (word.includes("://") ? word : word.replace(/\d[\d,.]*\d|\d/g, bold)))
    .join(" ");

const ITEM = { indent: "  ", hanging: "    " };

const COUNT_LABEL: Partial<Record<Resource, string>> = { enrichment: "contacts enriched" };

/** Per-resource counts in apply order. */
const orderedCounts = (counts: Counts): [Resource, ResourceCounts][] =>
  RESOURCES.flatMap((resource) => {
    const c = counts[resource];
    return c === undefined ? [] : [[resource, c] as [Resource, ResourceCounts]];
  });

export function countRows(
  counts: Counts,
  enrichment?: Report["enrichment"],
): { label: string; value: number }[] {
  const rows: { label: string; value: number }[] = [];
  for (const [resource, c] of orderedCounts(counts)) {
    const name = COUNT_LABEL[resource];
    if (name !== undefined) {
      if (c.updated > 0) rows.push({ label: name, value: c.updated });
      if (resource === "enrichment" && enrichment !== undefined) {
        rows.push({ label: "with topic subscriptions", value: enrichment.withTopics });
        rows.push({ label: "with properties", value: enrichment.withProperties });
        const dropped = (enrichment.droppedProperties ?? []).reduce((n, d) => n + d.contacts, 0);
        if (dropped > 0) rows.push({ label: "property values not written", value: dropped });
      }
    } else {
      if (c.created > 0) rows.push({ label: `${resource} created`, value: c.created });
      if (c.updated > 0) rows.push({ label: `${resource} updated`, value: c.updated });
      if (c.matched > 0) rows.push({ label: `${resource} matched existing`, value: c.matched });
      if (c.unchanged > 0) rows.push({ label: `${resource} unchanged`, value: c.unchanged });
    }
    if (c.failed > 0) rows.push({ label: `${resource} failed`, value: c.failed });
  }
  return rows;
}

export const SYNC_HINT = (source: ProviderId): string =>
  `Run \`billionsend migrate --from ${source}\` again right before cutover to sync new contacts.`;

/** The numbers, the read-only assurance, secrets once, the checklist, the sync hint, then the plan offer. */
export async function printSummary(out: OutStream, raw: Report): Promise<void> {
  const report = stripControlDeep(raw);
  const line = (
    text: string,
    opts: { indent: string; hanging?: string; keep?: readonly string[] } = ITEM,
  ): void => {
    out.write(`${wrapIndent(text, opts)}\n`);
  };
  out.write(`\n${heading("Done")}\n\n`);
  await countUp(countRows(report.counts, report.enrichment), { stream: out });
  out.write(`\n${dim(`${report.sourceLabel} was only read; nothing there was changed.`)}\n`);
  if (report.scope !== null) out.write(`${dim(wrapIndent(scopeLine(report.scope)))}\n`);
  if (report.freshWebhookSecrets.length > 0) {
    out.write("\nWebhook signing secrets, shown once (they are not saved anywhere):\n");
    for (const { endpoint, secret } of report.freshWebhookSecrets) {
      out.write(`  ${endpoint}  ${bold(secret)}\n`);
    }
  }
  const { done, left } = report.checklist;
  out.write(`\n${bold(String(done.length))} of ${done.length + left.length} steps done — left:\n`);
  for (const item of left)
    line(`${dim("[")} ${dim("]")} ${item}`, { indent: "  ", hanging: "      " });
  for (const { domain, records, note } of report.dns) {
    out.write(`\nDNS records for ${domain}:\n`);
    if (note !== null) out.write(`${dim(`${note}.`)}\n`);
    for (const card of dnsCards(records)) out.write(`${card}\n`);
  }
  if (report.ids.length > 0) {
    out.write(`\nId map (${report.sourceLabel} → BillionSend; full pairs in migrate-report.md):\n`);
    for (const row of idRows(report.ids)) out.write(`${row}\n`);
  }
  if (report.manual.length > 0) {
    out.write("\nManual notes:\n");
    for (const { title, detail, names } of manualRows(report.manual)) {
      line(`${note(SYM.manual)} ${title} — ${detail}`);
      if (names !== undefined) line(dim(foldedKeysLine(names)), { indent: "    " });
    }
  }
  if (report.failures.length > 0) {
    out.write("\nFailed:\n");
    for (const f of report.failures) {
      // The symbol, the resource and the address stay in one piece: only the words after the dash wrap.
      const head = `${err(SYM.err)} ${f.resource}/${f.key}`;
      line(`${head} — ${f.message}`, { ...ITEM, keep: [head, f.key] });
    }
  }
  out.write(`\n${dim(wrapIndent(SYNC_HINT(report.source)))}\n`);
  if (report.offer !== null)
    out.write(`\n${wrapIndent(boldNumbers(report.offer.text.join(" ")))}\n`);
}

export function renderReportMd(raw: Report): string {
  const report = stripControlDeep(raw);
  const lines = [
    `# Migration report — ${report.sourceLabel} → BillionSend`,
    "",
    `Finished ${report.finishedAt} · target ${report.target.baseUrl}${report.target.plan === null ? "" : ` · plan ${capitalize(report.target.plan)}`}`,
    "",
    "## Numbers",
    "",
    "| Resource | Created | Updated | Matched existing | Unchanged | Skipped | Manual | Failed |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...orderedCounts(report.counts).map(
      ([resource, c]) =>
        `| ${resource} | ${c.created} | ${c.updated} | ${c.matched} | ${c.unchanged} | ${c.skipped} | ${c.manual} | ${c.failed} |`,
    ),
    "",
    "Matched existing: contacts the batch endpoint found already in your account. It does not say whether a matched contact changed, so these are not counted as updated or unchanged.",
    "",
    ...(report.scope === null ? [] : [scopeLine(report.scope), ""]),
    `${report.sourceLabel} was only read; nothing there was changed.`,
    "",
    "## Checklist",
    "",
    ...report.checklist.done.map((step) => `- [x] ${step}`),
    ...report.checklist.left.map((step) => `- [ ] ${step}`),
  ];
  for (const { domain, records, note } of report.dns) {
    lines.push(
      "",
      `### DNS records for ${domain}`,
      "",
      ...(note === null ? [] : [`${note}.`, ""]),
      "| Type | Name | Priority | Value |",
      "| --- | --- | --- | --- |",
      ...records.map((r) => `| ${r.type} | ${r.name} | ${r.priority ?? ""} | \`${r.value}\` |`),
    );
  }
  if (report.apiKeys.length > 0) {
    lines.push("", "## API keys to create", "", ...report.apiKeys.map((name) => `- ${name}`));
  }
  if (report.ids.length > 0) {
    lines.push(
      "",
      "## Id map",
      "",
      `| Resource | Name | ${report.sourceLabel} id | BillionSend id |`,
      "| --- | --- | --- | --- |",
      ...report.ids.map(
        (m) => `| ${m.resource} | ${m.name} | \`${m.sourceId}\` | \`${m.targetId}\` |`,
      ),
    );
  }
  if (report.manual.length > 0) {
    lines.push(
      "",
      "## Manual notes",
      "",
      ...report.manual.map(({ title, detail }) => `- ${title} — ${detail}`),
    );
  }
  if (report.failures.length > 0) {
    lines.push(
      "",
      "## Failed",
      "",
      ...report.failures.map((f) => `- ${f.resource}/${f.key} — ${f.message}`),
    );
  }
  lines.push("", SYNC_HINT(report.source));
  if (report.offer !== null) lines.push("", ...report.offer.text);
  lines.push("", "---", "", report.trademark, "");
  return lines.join("\n");
}

/** Both files at 0600, secrets stripped; the optional extra path gets the Markdown too. */
export function writeReport(paths: MigratePaths, report: Report, extraMd: string | null): void {
  const stored: Report = { ...report, freshWebhookSecrets: [] };
  writePrivateJson(paths.reportJson, stored);
  const md = renderReportMd(stored);
  writePrivate(paths.reportMd, md);
  if (extraMd !== null) writePrivate(extraMd, md);
}

/** The Markdown of `migrate plan --report`: what a run would do, nothing that has happened. */
export function renderPlanMd(raw: Plan, sourceLabel: string): string {
  const plan = stripControlDeep(raw);
  const rows = RESOURCES.flatMap((resource) => {
    const own = plan.items.filter((i) => i.resource === resource);
    if (own.length === 0) return [];
    const n = (action: PlanItem["action"]): number =>
      own.filter((i) => i.action === action).reduce((sum, i) => sum + (i.count ?? 1), 0);
    return [
      `| ${resource} | ${n("create")} | ${n("update")} | ${n("unchanged")} | ${n("manual")} | ${n("skip")} |`,
    ];
  });
  const lines = [
    `# Migration plan — ${sourceLabel} → BillionSend`,
    "",
    `Planned ${plan.createdAt} · target ${plan.target.baseUrl}${plan.target.plan === null ? "" : ` · plan ${capitalize(plan.target.plan)}`}`,
    "",
    "Nothing has been written: this is what `billionsend migrate apply` would do.",
    "",
    ...(plan.scope === null ? [] : [scopeLine(plan.scope), ""]),
    "## Plan",
    "",
    "| Resource | Create | Update | Unchanged | Manual | Skipped |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    `About ${formatNumber(plan.estimate.requests)} requests (${formatDuration(plan.estimate.seconds)} at ${plan.rps} req/s).`,
  ];
  const returnPaths = plan.items.filter(
    (i) => i.resource === "domains" && i.action === "create" && i.detail !== undefined,
  );
  if (returnPaths.length > 0) {
    lines.push(
      "",
      "## Return paths",
      "",
      ...returnPaths.map(({ key, detail }) => `- ${key} — ${detail}`),
    );
  }
  if (plan.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...plan.warnings.map((w) => `- ${w}`));
  }
  if (plan.manual.length > 0) {
    lines.push(
      "",
      "## Manual notes",
      "",
      ...plan.manual.map(({ title, detail }) => `- ${title} — ${detail}`),
    );
  }
  lines.push("", "---", "", TRADEMARK_NOTICE, "");
  return lines.join("\n");
}

export const writePlanReport = (path: string, plan: Plan, sourceLabel: string): void =>
  writePrivate(path, renderPlanMd(plan, sourceLabel));
