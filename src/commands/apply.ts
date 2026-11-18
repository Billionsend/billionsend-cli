import { readFileSync } from "node:fs";
import type { Config } from "../config.js";
import type { Context } from "../context.js";
import type { Plan } from "../model.js";
import { describePlanDiff, parsePlan, planHash } from "../plan.js";
import { confirmPrompt } from "../tty-ui.js";
import { canonicalJson, formatDuration } from "../utils.js";
import { execute, migrate, prepare } from "./migrate.js";

const MAX_PLAN_AGE_MS = 3_600_000;
/** Item differences named in a message; the rest is a count. */
const DIFF_SHOWN = 5;

const sorted = <T extends string>(list: readonly T[]): T[] => [...list].sort();
const show = (list: readonly string[] | null): string =>
  list === null ? "(not set)" : list.length === 0 ? "(none)" : list.join(",");

/**
 * A plan file records the options its content depends on. Applying it follows
 * them: an option the command line did not set is taken from the file, one it
 * set to something else is a conflict and stops the run, because the plan
 * built from the other value would never match the file.
 */
function followPlanOptions(config: Config, file: string, recorded: Plan["options"]): void {
  const conflicts: string[] = [];
  const conflict = (flag: string, given: string, wanted: string): void => {
    conflicts.push(`${flag}: the command line has ${given}, the file has ${wanted}`);
  };
  const g = config.given;
  if (
    g.has("only") &&
    canonicalJson(config.only && sorted(config.only)) !==
      canonicalJson(recorded.only && sorted(recorded.only))
  ) {
    conflict("--only", show(config.only), show(recorded.only));
  }
  if (
    g.has("skip") &&
    canonicalJson(sorted(config.skip)) !== canonicalJson(sorted(recorded.skip))
  ) {
    conflict("--skip", show(config.skip), show(recorded.skip));
  }
  if (
    g.has("segment") &&
    canonicalJson(sorted(config.segment)) !== canonicalJson(sorted(recorded.segment))
  ) {
    conflict("--segment", show(config.segment), show(recorded.segment));
  }
  if (g.has("on-conflict") && config.onConflict !== recorded.onConflict) {
    conflict("--on-conflict", config.onConflict, recorded.onConflict);
  }
  if (g.has("include-sent") && config.includeSent !== recorded.includeSent) {
    conflict("--include-sent", String(config.includeSent), String(recorded.includeSent));
  }
  if (
    g.has("fresh-webhook-secrets") &&
    config.freshWebhookSecrets !== recorded.freshWebhookSecrets
  ) {
    conflict(
      "--fresh-webhook-secrets",
      String(config.freshWebhookSecrets),
      String(recorded.freshWebhookSecrets),
    );
  }
  if (conflicts.length > 0) {
    throw new Error(
      `${file} was made with other options than this command line asks for:\n  ${conflicts.join("\n  ")}\n` +
        `Applying a file follows the options it was made with: leave these flags out, or run \`migrate plan --out ${file}\` again with the new ones.`,
    );
  }
  config.only = recorded.only;
  config.skip = [...recorded.skip];
  config.segment = [...recorded.segment];
  config.onConflict = recorded.onConflict;
  config.includeSent = recorded.includeSent;
  config.freshWebhookSecrets = recorded.freshWebhookSecrets;
}

/**
 * Applies a saved plan (or plans and applies); exit 3 when some items failed.
 * A plan file holds no contacts, so the source is always read again; the
 * fresh plan is what gets applied, and the file is a checkpoint it must match.
 */
export async function apply(ctx: Context): Promise<number> {
  const { config, out } = ctx;
  if (config.planFile === null) return migrate(ctx);
  let text: string;
  try {
    text = readFileSync(config.planFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `plan file ${config.planFile} not found; run \`migrate plan --from ${config.from ?? "resend"} --out ${config.planFile}\` first`,
    );
  }
  const saved = parsePlan(text);
  followPlanOptions(config, config.planFile, saved.options);
  // Age needs no network: a stale file is refused before the source is read again.
  const ageMs = Date.now() - Date.parse(saved.createdAt);
  const stale = !(ageMs < MAX_PLAN_AGE_MS);
  if (stale && config.nonInteractive) {
    throw new Error(
      `${config.planFile} is ${formatDuration(ageMs / 1000)} old. Re-run \`migrate plan --out\`, or apply without a file.`,
    );
  }
  if (stale) {
    out.write(
      `${config.planFile} is ${formatDuration(ageMs / 1000)} old; reading the source again to build a current plan.\n`,
    );
  }
  // The file's options already decide the resources: no picker.
  const prepared = await prepare(ctx, config.from ?? saved.source, { pick: false });
  if (saved.target.baseUrl !== prepared.baseUrl) {
    throw new Error(
      `${config.planFile} was made for ${saved.target.baseUrl}; connected to ${prepared.baseUrl}.`,
    );
  }
  const reasons: string[] = [];
  if (stale) reasons.push(`is ${formatDuration(ageMs / 1000)} old`);
  const same = planHash(saved) === planHash(prepared.plan);
  const differing = same ? [] : describePlanDiff(saved, prepared.plan);
  if (!same) reasons.push("differs from the plan just built");
  if (reasons.length > 0) {
    const cause =
      differing.length === 0
        ? ""
        : ` The options are the file's own, so the source or your BillionSend account changed since the file was made: ${differing
            .slice(0, DIFF_SHOWN)
            .join(
              "; ",
            )}${differing.length > DIFF_SHOWN ? `; … and ${differing.length - DIFF_SHOWN} more` : ""}.`;
    const notice = `${config.planFile} ${reasons.join(" and ")}; the plan above is current.${cause}`;
    if (config.nonInteractive) {
      throw new Error(
        `${notice} Run \`migrate plan --out ${config.planFile}\` again to refresh the file, or apply without a file.`,
      );
    }
    out.write(`${notice}\n`);
    if (!(await confirmPrompt(ctx.rl, { label: "Apply the current plan instead?" }))) {
      out.write("Nothing applied.\n");
      return 0;
    }
  }
  return execute(ctx, prepared);
}
