import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Io, OutStream } from "./context.js";
import {
  ApiError,
  AuthError,
  createHttp,
  cursorGuard,
  type Http,
  nextCursor,
  pageItems,
  route,
} from "./http.js";
import { createLogger } from "./log.js";
import { CLOUD_API_URL, USER_AGENT } from "./meta.js";
import { lineReader } from "./tty-ui.js";
import { stripTrailingSlashes } from "./utils.js";

/**
 * Sending from the command line: `broadcasts send`, `broadcasts get` and
 * `emails send`, against the BillionSend API with BILLIONSEND_API_KEY. Kept
 * apart from `migrate`: no source provider, no state file, no plan.
 */

export const SEND_COMMANDS = ["broadcasts", "emails"] as const;
export type SendCommand = (typeof SEND_COMMANDS)[number];

/** The segment `--test` sends to; it holds exactly the --test addresses of the last test. */
export const TEST_SEGMENT_NAME = "CLI test recipients";
const SEND_RPS = 5;
/** `--wait`: how often and how long to read the broadcast back. */
const WAIT_POLL_MS = 5_000;
const WAIT_LIMIT_MS = 30 * 60_000;

/** Time, as `--wait` sees it; the tests pass their own. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
const TERMINAL_STATUSES = new Set(["sent", "failed", "canceled", "cancelled"]);

export const sendHelpText = (): string => `Sending
  billionsend broadcasts send --from <addr> --subject <s> --html-file <f> --segment <name|id> [options]
  billionsend broadcasts send ... --test <email> [--test <email>]   the same broadcast, to these addresses only
  billionsend broadcasts get <id>
  billionsend emails send --from <addr> --to <email> --subject <s> (--html-file <f> | --text-file <f>) [options]

Sending options
  --from <address>           sender, "Name <user@your-domain>"; the domain must be verified on BillionSend
  --subject <text>           subject line
  --html-file <path>         HTML body; broadcast merge tags ({{{FIRST_NAME|there}}}, {{{RESEND_UNSUBSCRIBE_URL}}}) are filled per recipient
  --text-file <path>         plain-text body (with or instead of --html-file)
  --segment <name|id>        broadcasts: who it goes to
  --topic <name|id>          broadcasts: only contacts subscribed to this topic
  --name <text>              broadcasts: internal name (default: the subject)
  --preview-text <text>      broadcasts: inbox preview line
  --reply-to <address>       repeatable
  --to <email>               emails: repeatable
  --test <email>             broadcasts: send to these addresses instead of the segment (repeatable or comma-separated).
                             They are put in a segment named "${TEST_SEGMENT_NAME}" holding exactly them, so the test
                             goes through the real broadcast path: names and unsubscribe links are each recipient's own
  --wait                     broadcasts: follow the broadcast until it is sent, failed or canceled (30 min at most)
  --idempotency-key <key>    emails: a retry with the same key sends once
  --key-stdin                read the BillionSend API key from stdin instead of BILLIONSEND_API_KEY
  -y, --yes                  send without asking; required when stdin is not a terminal
  --json                     JSON on stdout
`;

interface SendIo {
  stdout: OutStream;
  stderr: OutStream;
  env: NodeJS.ProcessEnv;
  stdin: NonNullable<Io["stdin"]>;
  fetch: typeof fetch;
  cwd: string;
}

class UsageError extends Error {}

interface Segment {
  id: string;
  name: string;
}
interface Topic {
  id: string;
  name: string;
}
interface Broadcast {
  id: string;
  name: string | null;
  status: string;
  sent_count: number | null;
  failure_reason: string | null;
}

const OPTIONS = {
  from: { type: "string" },
  subject: { type: "string" },
  "html-file": { type: "string" },
  "text-file": { type: "string" },
  segment: { type: "string" },
  topic: { type: "string" },
  name: { type: "string" },
  "preview-text": { type: "string" },
  "reply-to": { type: "string", multiple: true },
  to: { type: "string", multiple: true },
  test: { type: "string", multiple: true },
  wait: { type: "boolean" },
  "idempotency-key": { type: "string" },
  "key-stdin": { type: "boolean" },
  "to-url": { type: "string" },
  yes: { type: "boolean", short: "y" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** `--test a@x.com,b@y.com --test c@z.com` → three lowercased, de-duplicated addresses. */
export function splitAddresses(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    for (const part of value.split(",")) {
      const email = part.trim().toLowerCase();
      if (email === "") continue;
      if (!EMAIL.test(email)) throw new UsageError(`Not an email address: ${part.trim()}`);
      if (!out.includes(email)) out.push(email);
    }
  }
  return out;
}

function required(values: Values, name: "from" | "subject"): string {
  const value = values[name]?.trim();
  if (!value) throw new UsageError(`--${name} is required.`);
  return value;
}

function readBody(io: SendIo, values: Values): { html?: string; text?: string } {
  const read = (flag: "html-file" | "text-file"): string | undefined => {
    const path = values[flag];
    if (path === undefined) return undefined;
    try {
      return readFileSync(resolve(io.cwd, path), "utf8");
    } catch {
      throw new UsageError(`Cannot read --${flag} ${path}`);
    }
  };
  const html = read("html-file");
  const text = read("text-file");
  if (html === undefined && text === undefined)
    throw new UsageError("--html-file or --text-file is required.");
  if (`${html ?? ""}${text ?? ""}`.trim() === "")
    throw new UsageError("The message body is empty.");
  return { ...(html === undefined ? {} : { html }), ...(text === undefined ? {} : { text }) };
}

async function listAll<T extends { id: string }>(http: Http, path: string): Promise<T[]> {
  const rows: T[] = [];
  const guard = cursorGuard(path);
  let after: string | undefined;
  for (;;) {
    const { body } = await http.get<{ has_more?: boolean }>(path, { query: { limit: 100, after } });
    const page = pageItems<T>(path, body, after);
    guard(page, after);
    rows.push(...page);
    if (body.has_more !== true) return rows;
    after = nextCursor(path, page, after);
  }
}

/** A segment or topic named by id or by exact name; an unknown or ambiguous one is a usage error listing the choices. */
async function resolveNamed<T extends { id: string; name: string }>(
  http: Http,
  path: string,
  kind: string,
  ref: string,
): Promise<T> {
  const rows = await listAll<T>(http, path);
  const byId = rows.find((r) => r.id === ref);
  if (byId) return byId;
  const byName = rows.filter((r) => r.name === ref);
  if (byName.length === 1 && byName[0]) return byName[0];
  const choices = rows.map((r) => `  ${r.name}  ${r.id}`).join("\n") || "  (none)";
  if (byName.length > 1)
    throw new UsageError(`${byName.length} ${kind}s are named "${ref}"; pass the id:\n${choices}`);
  throw new UsageError(`No ${kind} "${ref}". Existing ${kind}s:\n${choices}`);
}

/** The test segment, made to hold exactly `emails` (contacts created when missing, others taken out). */
async function prepareTestSegment(http: Http, emails: string[]): Promise<Segment> {
  const segments = await listAll<Segment>(http, "/segments");
  const existing = segments.find((s) => s.name === TEST_SEGMENT_NAME);
  const segment =
    existing ??
    (await http.post<Segment>("/segments", { name: TEST_SEGMENT_NAME }, { idempotent: false }))
      .body;
  const members = await listAll<{ id: string; email: string }>(
    http,
    route`/segments/${segment.id}/contacts`,
  );
  for (const member of members) {
    if (!emails.includes(member.email.toLowerCase()))
      await http.delete(route`/contacts/${member.id}/segments/${segment.id}`);
  }
  const found = await http.post<{ data: { id: string; email: string }[] }>(
    "/contacts/batch/get",
    { contacts: emails.map((email) => ({ email })) },
    { idempotent: true },
  );
  const idByEmail = new Map(found.body.data.map((c) => [c.email.toLowerCase(), c.id]));
  const missing = emails.filter((e) => !idByEmail.has(e));
  if (missing.length > 0) {
    // Only absent contacts are created, so an existing contact's name, topics and
    // unsubscribe state are never touched by a test.
    const created = await http.post<{ data: { index: number; id: string }[] }>(
      "/contacts/batch",
      missing.map((email) => ({ email })),
      { query: { on_conflict: "skip" }, idempotent: true },
    );
    // Strict batch validation (the default): it creates every row or fails as a whole.
    for (const row of created.body.data) idByEmail.set(missing[row.index] as string, row.id);
  }
  for (const email of emails) {
    const id = idByEmail.get(email) as string;
    if (!members.some((m) => m.id === id))
      await http.post(route`/contacts/${id}/segments/${segment.id}`, undefined, {
        idempotent: true,
      });
  }
  return segment;
}

async function confirm(io: SendIo, values: Values, question: string): Promise<boolean> {
  if (values.yes) return true;
  if (io.stdin.isTTY !== true)
    throw new UsageError(
      "Refusing to send without confirmation: pass --yes (stdin is not a terminal).",
    );
  const rl = lineReader(io.stdin, io.stderr);
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

const describe = (b: Broadcast): string =>
  `status ${b.status}${b.sent_count === null ? "" : ` · sent ${b.sent_count}`}${
    b.failure_reason ? ` · ${b.failure_reason}` : ""
  }`;

/** Reads the broadcast back until it ends (sent, failed, canceled) or WAIT_LIMIT_MS has passed. */
async function waitFor(
  http: Http,
  id: string,
  say: (line: string) => void,
  clock: Clock,
): Promise<{ broadcast: Broadcast; ended: boolean }> {
  const deadline = clock.now() + WAIT_LIMIT_MS;
  let last = "";
  for (;;) {
    const { body } = await http.get<Broadcast>(route`/broadcasts/${id}`);
    const line = describe(body);
    if (line !== last) say(`  ${line}`);
    last = line;
    const ended = TERMINAL_STATUSES.has(body.status);
    if (ended || clock.now() >= deadline) return { broadcast: body, ended };
    await clock.sleep(WAIT_POLL_MS);
  }
}

async function broadcastsSend(
  io: SendIo,
  http: Http,
  values: Values,
  clock: Clock,
): Promise<number> {
  const from = required(values, "from");
  const subject = required(values, "subject");
  const body = readBody(io, values);
  const test = splitAddresses(values.test);
  const segmentRef = values.segment;
  if (test.length === 0 && !segmentRef)
    throw new UsageError("--segment is required (or --test <email> for a test send).");
  const say = (line: string) => (values.json ? io.stderr : io.stdout).write(`${line}\n`);

  const topic = values.topic
    ? await resolveNamed<Topic>(http, "/topics", "topic", values.topic)
    : null;
  // Resolved for a test too, so a typo in the segment fails the test as it would the send.
  const named = segmentRef
    ? await resolveNamed<Segment>(http, "/segments", "segment", segmentRef)
    : null;
  let segment: Segment;
  let question: string;
  if (test.length > 0) {
    segment = await prepareTestSegment(http, test);
    question = `Send a test to ${test.join(", ")}?`;
  } else {
    // No --test means --segment was given (checked above).
    segment = named as Segment;
    const { body: detail } = await http.get<{ contact_count: number }>(
      route`/segments/${segment.id}`,
    );
    say(
      `Segment ${segment.name} (${segment.id}) · ${detail.contact_count} contacts${
        topic ? ` · topic ${topic.name}: only its subscribers receive it` : ""
      }`,
    );
    question = `Send "${subject}" to segment ${segment.name} (${detail.contact_count} contacts)?`;
  }
  if (!(await confirm(io, values, question))) {
    say("Not sent.");
    return 1;
  }
  const prefix = test.length > 0 ? "[TEST] " : "";
  const created = await http.post<{ id: string }>(
    "/broadcasts",
    {
      name: `${prefix}${values.name?.trim() || subject}`,
      from,
      subject: `${prefix}${subject}`,
      segment_id: segment.id,
      ...(topic ? { topic_id: topic.id } : {}),
      ...(values["reply-to"]?.length ? { reply_to: values["reply-to"] } : {}),
      ...(values["preview-text"] ? { preview_text: values["preview-text"] } : {}),
      ...body,
      send: true,
    },
    { idempotent: false },
  );
  const id = created.body.id;
  say(`Broadcast ${id} queued${test.length > 0 ? ` (test to ${test.join(", ")})` : ""}.`);
  let result: Broadcast;
  let gaveUp = false;
  if (values.wait) {
    const waited = await waitFor(http, id, say, clock);
    result = waited.broadcast;
    gaveUp = !waited.ended;
    if (gaveUp)
      say(
        `Still ${result.status} after 30 minutes; follow it with: billionsend broadcasts get ${id}`,
      );
  } else {
    result = (await http.get<Broadcast>(route`/broadcasts/${id}`)).body;
    say(`  ${describe(result)}`);
  }
  if (values.json)
    io.stdout.write(`${JSON.stringify(result)}
`);
  return result.status === "failed" || gaveUp ? 1 : 0;
}

async function broadcastsGet(io: SendIo, http: Http, values: Values, id: string | undefined) {
  if (!id) throw new UsageError("Usage: billionsend broadcasts get <id>");
  const { body } = await http.get<Broadcast>(route`/broadcasts/${id}`);
  if (values.json) io.stdout.write(`${JSON.stringify(body)}\n`);
  else io.stdout.write(`${body.id}${body.name ? ` · ${body.name}` : ""} · ${describe(body)}\n`);
  return 0;
}

async function emailsSend(io: SendIo, http: Http, values: Values): Promise<number> {
  const from = required(values, "from");
  const subject = required(values, "subject");
  const to = splitAddresses(values.to);
  if (to.length === 0) throw new UsageError("--to is required.");
  const body = readBody(io, values);
  if (!(await confirm(io, values, `Send "${subject}" to ${to.join(", ")}?`))) {
    io.stderr.write("Not sent.\n");
    return 1;
  }
  const key = values["idempotency-key"];
  const { body: sent } = await http.post<{ id: string }>(
    "/emails",
    {
      from,
      to,
      subject,
      ...(values["reply-to"]?.length ? { reply_to: values["reply-to"] } : {}),
      ...body,
    },
    // With a key the API answers a repeat with the first email, so a retry is safe.
    key ? { headers: { "Idempotency-Key": key }, idempotent: true } : { idempotent: false },
  );
  if (values.json) io.stdout.write(`${JSON.stringify(sent)}\n`);
  else io.stdout.write(`Email ${sent.id} accepted.\n`);
  return 0;
}

async function readKey(io: SendIo, values: Values): Promise<string> {
  if (values["key-stdin"]) {
    const rl = lineReader(io.stdin, io.stderr);
    try {
      const line = (await rl.question("")).trim();
      if (line === "")
        throw new UsageError("No BillionSend API key arrived on stdin (--key-stdin).");
      return line;
    } finally {
      rl.close();
    }
  }
  const key = io.env.BILLIONSEND_API_KEY?.trim();
  if (!key) throw new UsageError("Set BILLIONSEND_API_KEY or pass --key-stdin.");
  return key;
}

/** `billionsend broadcasts …` / `billionsend emails …`. Exit 0 sent, 1 refused or failed. */
export async function runSend(
  argv: readonly string[],
  ioIn: Io = {},
  clock: Clock = SYSTEM_CLOCK,
): Promise<number> {
  const io: SendIo = {
    stdout: ioIn.stdout ?? process.stdout,
    stderr: ioIn.stderr ?? process.stderr,
    env: ioIn.env ?? process.env,
    stdin: ioIn.stdin ?? process.stdin,
    fetch: ioIn.fetch ?? globalThis.fetch,
    cwd: ioIn.cwd ?? process.cwd(),
  };
  const log = createLogger({ level: "info", stream: io.stderr });
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    const [command, sub, id, ...rest] = positionals;
    if (values.help || sub === undefined) {
      io.stdout.write(sendHelpText());
      return values.help ? 0 : 1;
    }
    const known =
      (command === "broadcasts" && (sub === "send" || sub === "get")) ||
      (command === "emails" && sub === "send");
    if (!known) throw new UsageError(`Unknown command: ${command} ${sub}`);
    if (rest.length > 0 || (id !== undefined && sub !== "get"))
      throw new UsageError(`Unexpected argument: ${[id, ...rest].filter(Boolean).join(" ")}`);
    const token = await readKey(io, values);
    const baseUrl = stripTrailingSlashes(
      values["to-url"] ?? io.env.BILLIONSEND_BASE_URL ?? CLOUD_API_URL,
    );
    const http = createHttp({
      baseUrl,
      token,
      userAgent: USER_AGENT,
      rps: SEND_RPS,
      log,
      name: "BillionSend",
      fetch: io.fetch,
    });
    if (command === "emails") return await emailsSend(io, http, values);
    if (sub === "get") return await broadcastsGet(io, http, values, id);
    return await broadcastsSend(io, http, values, clock);
  } catch (error) {
    if (error instanceof UsageError || error instanceof AuthError || error instanceof ApiError) {
      log.error(error.message);
      return 1;
    }
    if (
      error instanceof TypeError &&
      "code" in error &&
      String(error.code).startsWith("ERR_PARSE_ARGS")
    ) {
      log.error(error.message);
      return 1;
    }
    throw error;
  }
}
