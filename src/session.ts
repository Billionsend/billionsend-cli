import { type BillionSendTarget, createBillionSendTarget } from "./billionsend.js";
import {
  type KeyInput,
  MAX_RPS,
  RPS_HEADROOM,
  sourceKeyEnv,
  TARGET_KEY_ENV,
  TARGET_URL_ENV,
} from "./config.js";
import type { Context } from "./context.js";
import { AuthError, createHttp } from "./http.js";
import { CLOUD_API_URL, USER_AGENT, VERSION } from "./meta.js";
import { type ProviderId, RESOURCES, type Resource, type TargetUsage } from "./model.js";
import type { Progress, StepHandle } from "./progress.js";
import { type OnProgress, type Provider, providers, type Source } from "./providers/index.js";
import { RESEND_BASE_URL_ENV } from "./providers/resend.js";
import { dim, ok, SYM, wrapIndent } from "./theme.js";
import { banner, pickBannerTier, secretPrompt } from "./tty-ui.js";
import { capitalize, formatNumber } from "./utils.js";

/** BillionSend allows 600 requests per minute per key; batch endpoints keep the real rate far below. */
export const TARGET_RPS = 10;

export interface SourceSession {
  provider: Provider;
  source: Source;
}

export interface TargetSession {
  target: BillionSendTarget;
  usage: TargetUsage;
  baseUrl: string;
}

/** Banner (tier by columns) and the two-line description; plain one-liner on pipes. */
export function printHeader(ctx: Context, text: string): void {
  const { out } = ctx;
  const tier = pickBannerTier(out.columns ?? 0, out.isTTY === true);
  if (tier === "plain") {
    out.write(`${wrapIndent(`billionsend ${VERSION} — ${text}`, { hanging: "  " })}\n\n`);
    return;
  }
  for (const line of banner(tier)) out.write(`${line}\n`);
  out.write(`\n${dim(wrapIndent(text))}\n\n`);
}

async function resolveKey(
  ctx: Context,
  input: KeyInput,
  { label, envName, flag }: { label: string; envName: string; flag: string },
): Promise<string> {
  if (input.value !== null) return input.value;
  if (input.source === "stdin") {
    const line = (await ctx.rl.question("")).trim();
    if (line === "") throw new Error(`No ${label} arrived on stdin (${flag}-stdin).`);
    return line;
  }
  if (ctx.config.nonInteractive) {
    throw new Error(`Missing ${label}. Set ${envName} or pass ${flag}-stdin.`);
  }
  const key = await secretPrompt(ctx.rl, { label: `${label} (full access)` });
  if (key === "") throw new Error(`Missing ${label}. Set ${envName} or pass ${flag}-stdin.`);
  return key;
}

export async function connectSource(ctx: Context, id: ProviderId): Promise<SourceSession> {
  const provider = providers[id];
  const envName = sourceKeyEnv(id);
  const baseUrl = provider.baseUrl(ctx.env);
  if (new URL(baseUrl).host === new URL(ctx.config.toUrl).host) {
    throw new Error(
      `${provider.label} API URL ${baseUrl} is the BillionSend host; the ${provider.label} key would be sent there. Unset ${RESEND_BASE_URL_ENV}, or point ${TARGET_URL_ENV} / --to-url at your BillionSend instance.`,
    );
  }
  const token = await resolveKey(ctx, ctx.config.fromKey, {
    label: `${provider.label} API key`,
    envName,
    flag: "--from-key",
  });
  const http = createHttp({
    baseUrl,
    token,
    userAgent: USER_AGENT,
    rps: ctx.config.rps,
    log: ctx.log,
    name: provider.label,
    readOnly: true,
    fetch: ctx.fetch,
  });
  const source = provider.create(http, ctx.log);
  try {
    await source.probe();
  } catch (error) {
    if (error instanceof AuthError) {
      throw new Error(
        `${provider.label} rejected the API key (${error.status}). Check ${envName}: it must be a full-access key of the account to migrate.`,
      );
    }
    throw error;
  }
  // The limit header arrives with the probe. A raised limit is used with headroom
  // unless --rps chose the rate; a rate above the limit is allowed but announced,
  // since the 429s land on the account's production sending too.
  const limit = http.rateLimit;
  let rps = ctx.config.rps;
  if (!ctx.config.rpsGiven && limit !== null && limit > MAX_RPS) rps = limit - RPS_HEADROOM;
  if (rps !== ctx.config.rps) {
    http.setRps(rps);
    ctx.config.rps = rps;
  }
  if (limit !== null && rps > limit) {
    ctx.log.warn(
      `--rps ${rps} is above the ${provider.label} team limit of ${limit} req/s. The limit is shared with your production sending, so both sides will see 429s.`,
    );
  } else if (limit === null && rps > MAX_RPS) {
    ctx.log.warn(
      `--rps ${rps} is above ${provider.label}'s default team limit of ${MAX_RPS} req/s and no limit header was seen. Go past ${MAX_RPS} only after ${provider.label} raised your limit.`,
    );
  }
  const host = baseUrl === provider.baseUrl({}) ? "" : ` (${baseUrl})`;
  const rate = limit === null ? `${rps} req/s` : `limit ${limit} req/s, using ${rps}`;
  ctx.out.write(
    `${ok(SYM.ok)} ${provider.label} ${dim("·")} connected${host} ${dim("·")} ${rate}\n`,
  );
  return { provider, source };
}

export async function connectTarget(ctx: Context): Promise<TargetSession> {
  const baseUrl = ctx.config.toUrl;
  const token = await resolveKey(ctx, ctx.config.toKey, {
    label: "BillionSend API key",
    envName: TARGET_KEY_ENV,
    flag: "--to-key",
  });
  const http = createHttp({
    baseUrl,
    token,
    userAgent: USER_AGENT,
    rps: TARGET_RPS,
    log: ctx.log,
    name: "BillionSend",
    fetch: ctx.fetch,
  });
  const target = createBillionSendTarget(http, ctx.log, baseUrl);
  const usage = await target.probe();
  // A null plan is the instance's own team, which no plan limits.
  const where = baseUrl === CLOUD_API_URL ? "" : ` (${baseUrl})`;
  const plan = usage.plan === null ? "no plan limits" : `plan ${capitalize(usage.plan)}`;
  ctx.out.write(`${ok(SYM.ok)} BillionSend${where} ${dim("·")} ${plan}\n`);
  return { target, usage, baseUrl };
}

/** Source read events → one progress step per label, closed on `done`. */
export function bridgeProgress(progress: Progress): OnProgress {
  let current: { label: string; step: StepHandle } | null = null;
  return (event) => {
    if (current === null || current.label !== event.label) {
      current = { label: event.label, step: progress.step(event.label) };
    }
    current.step.update(event.n, event.total);
    if (event.done) {
      current.step.done(formatNumber(event.n));
      current = null;
    }
  };
}

/** --only / --skip → the resources to read and plan. */
export function includeSet(config: Context["config"]): Set<Resource> {
  const set = new Set<Resource>(config.only ?? RESOURCES);
  for (const resource of config.skip) set.delete(resource);
  return set;
}
