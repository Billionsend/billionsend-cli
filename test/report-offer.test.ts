import { describe, expect, it } from "vitest";
import type { ApplyOutcome } from "../src/apply.js";
import type { Plan, Snapshot, TargetState, TargetUsage } from "../src/model.js";
import { buildReport, renderPlanMd, renderReportMd } from "../src/report.js";

/*
 * The closing paragraph of a run: how the source's volume sits against the plan the account is on,
 * and what would fit. Every plan shape and every missing number reads as a sentence, not a crash.
 */

const usage = (
  plan: string | null,
  limits: Partial<TargetUsage["limits"]> = {},
  overageEnabled = false,
): TargetUsage => ({
  plan,
  limits: {
    emailsPerDay: null,
    emailsPerMonth: null,
    domains: null,
    contacts: null,
    ...limits,
  },
  overageEnabled,
});

const offer = (
  u: TargetUsage,
  options: { sent: number | null; contacts?: number; domains?: number } = { sent: null },
) =>
  buildReport({
    plan: { source: "resend", items: [], manual: [], scope: null, warnings: [] } as unknown as Plan,
    snapshot: {
      metrics: { emailsLast30Days: options.sent },
      contacts: Array.from({ length: options.contacts ?? 0 }),
      domains: [],
    } as unknown as Snapshot,
    outcome: {
      state: { failures: [] },
      counts: { domains: { created: options.domains ?? 0 } },
      domainRecords: {},
      ids: [],
      enrichment: { withProperties: 0, withTopics: 0, droppedProperties: [] },
    } as unknown as ApplyOutcome,
    usage: u,
    targetState: { domains: [] } as unknown as TargetState,
    baseUrl: "https://api.billionsend.com",
    sourceLabel: "Resend",
  }).offer;

describe("the plan offer", () => {
  it("is none for a team no plan limits, and for a plan that covers an unknown volume", () => {
    expect(offer(usage(null), { sent: 5_000 })).toBeNull();
    expect(offer(usage("pro", { emailsPerMonth: 60_000 }), { sent: null })).toBeNull();
  });

  it("says a plan covers the volume, or that the rest bills as overage when overage is on", () => {
    const covers = offer(usage("pro", { emailsPerMonth: 60_000 }), { sent: 41_208 });
    expect(covers?.text.join(" ")).toContain("Pro 60K allows 60,000/month; that covers it.");
    expect(covers).toMatchObject({ perDay: 1374, fits: "pro", plan: "pro" });
    const overage = offer(usage("pro", { emailsPerMonth: 60_000 }, true), { sent: 90_000 });
    expect(overage?.text.join(" ")).toContain(
      "Pro 60K includes 60,000/month; the rest bills as overage.",
    );
  });

  it("names a plan that is not on the ladder by what the account's limits say", () => {
    const perDay = offer(usage("legacy", { emailsPerDay: 100 }), { sent: 50 });
    expect(perDay?.text.join(" ")).toContain("Legacy allows 3,000/month; that covers it.");
    const unlimited = offer(usage("custom"), { sent: 10 });
    expect(unlimited?.text.join(" ")).toContain("Custom allows unlimited; that covers it.");
  });

  it("points at the plan that fits when the volume, the domains or the contacts are over", () => {
    const volume = offer(usage("free", { emailsPerMonth: 3_000, domains: 3, contacts: 1_000 }), {
      sent: 41_208,
    });
    expect(volume?.text.join(" ")).toContain(
      "Free allows 3,000/month; Pro 60K (60,000/month, unlimited domains) fits.",
    );
    expect(volume).toMatchObject({ fits: "pro" });
    const domains = offer(usage("free", { emailsPerMonth: 3_000, domains: 3, contacts: 1_000 }), {
      sent: 100,
      domains: 5,
    });
    expect(domains?.text.join(" ")).toContain("Free allows 3 domains, you have 5; Starter");
    const contacts = offer(usage("free", { emailsPerMonth: 3_000, domains: 3, contacts: 1_000 }), {
      sent: null,
      contacts: 2_000,
    });
    // No sent figure: the sentence leaves the volume out and still names what fits.
    expect(contacts?.text.join(" ")).toContain("Free allows 1,000 contacts, you have 2,000");
    expect(contacts?.perDay).toBeNull();
  });

  it("calls the top rung the top when nothing on the ladder fits", () => {
    const huge = offer(usage("scale", { emailsPerMonth: 1_800_000 }), { sent: 50_000_000 });
    expect(huge?.text.join(" ")).toContain("is the top rung; emails past it bill as overage.");
    expect(huge?.fits).toBe("scale");
  });
});

describe("the Markdown files", () => {
  const report = (plan: string | null) =>
    buildReport({
      plan: {
        source: "resend",
        items: [],
        manual: [],
        scope: null,
        warnings: [],
      } as unknown as Plan,
      snapshot: {
        metrics: { emailsLast30Days: null },
        contacts: [],
        domains: [],
      } as unknown as Snapshot,
      outcome: {
        state: { failures: [] },
        counts: {},
        domainRecords: {},
        ids: [],
        enrichment: { withProperties: 0, withTopics: 0, droppedProperties: [] },
      } as unknown as ApplyOutcome,
      usage: usage(plan),
      targetState: { domains: [] } as unknown as TargetState,
      baseUrl: "https://api.billionsend.com",
      sourceLabel: "Resend",
    });

  it("a report names the plan only when there is one", () => {
    expect(renderReportMd(report(null))).toContain(" · target https://api.billionsend.com\n");
    expect(renderReportMd(report("pro"))).toContain(" · plan Pro\n");
  });

  it("a plan report lists warnings and manual notes only when there are some, and names the plan only when there is one", () => {
    const base = {
      createdAt: "2026-11-19T00:00:00.000Z",
      source: "resend",
      target: { baseUrl: "https://api.billionsend.com", plan: null },
      scope: null,
      rps: 8,
      items: [{ resource: "topics", action: "create", key: "News" }],
      estimate: { requests: 10, seconds: 3 },
      warnings: [],
      manual: [],
    } as unknown as Plan;
    const bare = renderPlanMd(base, "Resend");
    expect(bare).not.toContain("## Warnings");
    expect(bare).not.toContain("## Manual notes");
    expect(bare).not.toContain(" · plan ");
    const full = renderPlanMd(
      {
        ...base,
        target: { baseUrl: "https://api.billionsend.com", plan: "free" },
        warnings: ["2 domains to create"],
        manual: [{ title: "api-keys/Prod", detail: "create by hand" }],
      },
      "Resend",
    );
    expect(full).toContain("## Warnings\n\n- 2 domains to create");
    expect(full).toContain("## Manual notes\n\n- api-keys/Prod — create by hand");
    expect(full).toContain(" · plan Free");
  });
});
