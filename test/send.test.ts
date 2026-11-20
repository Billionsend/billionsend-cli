import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import {
  type Clock,
  RECIPIENT_TYPES,
  recipientsCsv,
  runSend,
  splitAddresses,
  TEST_SEGMENT_NAME,
} from "../src/send.js";
import { type ContractApi, startContractApi } from "./helpers/contract-api.js";

/*
 * `broadcasts send`, `broadcasts get` and `emails send`, in-process against the contract API:
 * what each sends, what it refuses before sending anything, and what a test send leaves behind.
 */

let api: ContractApi;
let dir: string;

function collector() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return {
    stream,
    get text() {
      return text;
    },
  };
}

function ioFor(options: { env?: Record<string, string>; stdin?: string; tty?: boolean } = {}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: options.tty === true });
  if (options.stdin !== undefined) stdin.write(options.stdin);
  if (options.tty !== true) stdin.end();
  const stdout = collector();
  const stderr = collector();
  return {
    stdin,
    stdout,
    stderr,
    io: {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: { BILLIONSEND_API_KEY: api.apiKey, BILLIONSEND_BASE_URL: api.baseUrl, ...options.env },
      cwd: dir,
    },
  };
}

async function run(argv: string[], options: Parameters<typeof ioFor>[0] = {}) {
  const { io, stdout, stderr } = ioFor(options);
  const code = await main(argv, io);
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** Seeds through the API itself, so the rows are what the API would hold. */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(api.baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${api.apiKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

const members = (segmentId: string): string[] =>
  [...api.store.contacts.values()]
    .filter((c) => api.store.segmentMembers.has(`${segmentId}:${c.id}`))
    .map((c) => c.email)
    .sort();

/** A clock whose sleep runs `step` and moves time on by `advance` (default: the ms asked for). */
function fakeClock(step: () => void, advance?: number): Clock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += advance ?? ms;
      step();
    },
  };
}

const segmentNamed = (name: string) =>
  [...api.store.segments.values()].filter((s) => s.name === name);

let customers: { id: string };
let newsletter: { id: string };

const SEND = [
  "broadcasts",
  "send",
  "--from",
  "Leo <leo@mail.example.com>",
  "--subject",
  "Black Friday",
  "--html-file",
  "mail.html",
];

beforeEach(async () => {
  api = await startContractApi();
  dir = mkdtempSync(join(tmpdir(), "billionsend-cli-send-"));
  writeFileSync(
    join(dir, "mail.html"),
    "<p>Hi {{{FIRST_NAME|there}}}</p><a href='{{{RESEND_UNSUBSCRIBE_URL}}}'>unsubscribe</a>",
  );
  customers = await call("POST", "/segments", { name: "Customers" });
  newsletter = await call("POST", "/topics", {
    name: "Newsletter",
    default_subscription: "opt_in",
  });
  await call("POST", "/contacts/batch?on_conflict=error", [
    { email: "a@customer.test", segments: [{ id: customers.id }] },
    { email: "b@customer.test", segments: [{ id: customers.id }] },
  ]);
});

afterEach(async () => {
  await api.stop();
});

describe("broadcasts send", () => {
  it("sends to a segment and a topic named by name, with every field it was given", async () => {
    const result = await run([
      ...SEND,
      "--segment",
      "Customers",
      "--topic",
      "Newsletter",
      "--reply-to",
      "leo@example.com",
      "--preview-text",
      "20% off",
      "--yes",
    ]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Segment Customers");
    expect(result.stdout).toContain("2 contacts");
    const [broadcast] = [...api.store.broadcasts.values()];
    expect(api.store.broadcasts.size).toBe(1);
    expect(broadcast).toMatchObject({
      name: "Black Friday",
      subject: "Black Friday",
      from: "Leo <leo@mail.example.com>",
      segmentId: customers.id,
      topicId: newsletter.id,
      replyTo: ["leo@example.com"],
      previewText: "20% off",
      status: "queued",
    });
    // The merge tags reach the API untouched: the API fills them per recipient.
    expect(broadcast?.html).toContain("{{{FIRST_NAME|there}}}");
    expect(broadcast?.html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
    expect(result.stdout).toContain(`Broadcast ${broadcast?.id} queued`);
  });

  it("accepts ids for the segment and the topic, and uses --name as the internal name", async () => {
    const result = await run([
      ...SEND,
      "--segment",
      customers.id,
      "--topic",
      newsletter.id,
      "--name",
      "BF live",
      "--yes",
    ]);
    expect(result.code).toBe(0);
    expect([...api.store.broadcasts.values()][0]).toMatchObject({
      name: "BF live",
      segmentId: customers.id,
      topicId: newsletter.id,
    });
  });

  it("refuses to send without --yes when stdin is not a terminal, and creates nothing", async () => {
    const result = await run([...SEND, "--segment", "Customers"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pass --yes");
    expect(api.store.broadcasts.size).toBe(0);
  });

  it("asks on a terminal and sends nothing on anything but yes", async () => {
    const { io, stdin, stdout } = ioFor({ tty: true });
    const pending = main([...SEND, "--segment", "Customers"], io);
    stdin.end("n\n");
    expect(await pending).toBe(1);
    expect(stdout.text).toContain("Not sent.");
    expect(api.store.broadcasts.size).toBe(0);
  });

  it("sends after a yes on a terminal", async () => {
    const { io, stdin } = ioFor({ tty: true });
    const pending = main([...SEND, "--segment", "Customers"], io);
    stdin.end("y\n");
    expect(await pending).toBe(0);
    expect(api.store.broadcasts.size).toBe(1);
  });

  it("names the existing segments when the one asked for does not exist", async () => {
    const result = await run([...SEND, "--segment", "Custmers", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No segment "Custmers"');
    expect(result.stderr).toContain(`Customers  ${customers.id}`);
    expect(api.store.broadcasts.size).toBe(0);
  });

  it("asks for the id when two segments share the name", async () => {
    await call("POST", "/segments", { name: "Customers" });
    const result = await run([...SEND, "--segment", "Customers", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('2 segments are named "Customers"; pass the id');
    expect(api.store.broadcasts.size).toBe(0);
  });

  it("refuses an unknown topic before sending", async () => {
    const result = await run([...SEND, "--segment", "Customers", "--topic", "News", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No topic "News"');
    expect(api.store.broadcasts.size).toBe(0);
  });

  it.each([
    [
      ["--subject", "x", "--html-file", "mail.html", "--segment", "Customers"],
      "--from is required",
    ],
    [
      ["--from", "a@b.co", "--html-file", "mail.html", "--segment", "Customers"],
      "--subject is required",
    ],
    [
      ["--from", "a@b.co", "--subject", "x", "--segment", "Customers"],
      "--html-file or --text-file is required",
    ],
    [
      ["--from", "a@b.co", "--subject", "x", "--html-file", "nope.html", "--segment", "Customers"],
      "Cannot read --html-file nope.html",
    ],
    [["--from", "a@b.co", "--subject", "x", "--html-file", "mail.html"], "--segment is required"],
  ])("refuses %j before any request", async (args, message) => {
    const result = await run(["broadcasts", "send", ...args, "--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(api.store.broadcasts.size).toBe(0);
  });

  it("refuses an empty body", async () => {
    writeFileSync(join(dir, "empty.html"), "  \n");
    const result = await run([
      "broadcasts",
      "send",
      "--from",
      "a@b.co",
      "--subject",
      "x",
      "--html-file",
      "empty.html",
      "--segment",
      "Customers",
      "--yes",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("The message body is empty.");
  });

  it("sends a text-only broadcast", async () => {
    writeFileSync(join(dir, "mail.txt"), "Hi there");
    const result = await run([
      "broadcasts",
      "send",
      "--from",
      "a@b.co",
      "--subject",
      "x",
      "--text-file",
      "mail.txt",
      "--segment",
      "Customers",
      "--yes",
    ]);
    expect(result.code).toBe(0);
    expect([...api.store.broadcasts.values()][0]).toMatchObject({ text: "Hi there", html: null });
  });

  it("needs a key, from the environment or stdin", async () => {
    const missing = await run([...SEND, "--segment", "Customers", "--yes"], {
      env: { BILLIONSEND_API_KEY: "" },
    });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Set BILLIONSEND_API_KEY or pass --key-stdin.");

    const viaStdin = await run([...SEND, "--segment", "Customers", "--yes", "--key-stdin"], {
      env: { BILLIONSEND_API_KEY: "" },
      stdin: `${api.apiKey}\n`,
    });
    expect(viaStdin.code).toBe(0);
    expect(api.store.broadcasts.size).toBe(1);
  });

  it("stops on a rejected key without retrying and without printing the key", async () => {
    const result = await run([...SEND, "--segment", "Customers", "--yes"], {
      env: { BILLIONSEND_API_KEY: "bs_wrong_key_123" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("BillionSend rejected the API key (401)");
    expect(result.stderr).not.toContain("bs_wrong_key_123");
  });

  it("--json prints the broadcast as read back, and human lines go to stderr", async () => {
    const result = await run([...SEND, "--segment", "Customers", "--yes", "--json"]);
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout) as { id: string; status: string };
    expect(out.status).toBe("queued");
    expect(api.store.broadcasts.has(out.id)).toBe(true);
    expect(result.stderr).toContain("queued");
  });
});

describe("broadcasts send --test", () => {
  it("sends to a test segment holding exactly the test addresses, never to the real one", async () => {
    const result = await run([
      ...SEND,
      "--segment",
      "Customers",
      "--test",
      "Me@Example.com, you@example.com",
      "--test",
      "me@example.com",
      "--yes",
    ]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const [test] = segmentNamed(TEST_SEGMENT_NAME);
    expect(test).toBeDefined();
    expect(members(test?.id ?? "")).toEqual(["me@example.com", "you@example.com"]);
    expect(members(customers.id)).toEqual(["a@customer.test", "b@customer.test"]);
    const [broadcast] = [...api.store.broadcasts.values()];
    expect(broadcast).toMatchObject({
      segmentId: test?.id,
      subject: "[TEST] Black Friday",
      name: "[TEST] Black Friday",
      status: "queued",
    });
    expect(result.stdout).toContain("test to me@example.com, you@example.com");
  });

  it("reuses the test segment and replaces its members on the next test", async () => {
    await run([...SEND, "--test", "one@example.com,two@example.com", "--yes"]);
    await run([...SEND, "--test", "two@example.com,three@example.com", "--yes"]);
    const tests = segmentNamed(TEST_SEGMENT_NAME);
    expect(tests).toHaveLength(1);
    expect(members(tests[0]?.id ?? "")).toEqual(["three@example.com", "two@example.com"]);
    // A contact taken out of the test segment is not deleted.
    expect([...api.store.contacts.values()].some((c) => c.email === "one@example.com")).toBe(true);
  });

  it("leaves an existing contact's name and unsubscribe state as they are", async () => {
    await call("POST", "/contacts/batch?on_conflict=error", [
      { email: "known@example.com", first_name: "Ada", unsubscribed: true },
    ]);
    const result = await run([...SEND, "--test", "known@example.com", "--yes"]);
    expect(result.code).toBe(0);
    const known = [...api.store.contacts.values()].find((c) => c.email === "known@example.com");
    expect(known).toMatchObject({ firstName: "Ada", unsubscribed: true });
    expect(api.store.contacts.size).toBe(3);
  });

  it("still checks the named segment, so a typo fails the test too", async () => {
    const result = await run([
      ...SEND,
      "--segment",
      "Custmers",
      "--test",
      "me@example.com",
      "--yes",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No segment "Custmers"');
    expect(api.store.broadcasts.size).toBe(0);
    expect(segmentNamed(TEST_SEGMENT_NAME)).toHaveLength(0);
  });

  it("refuses an address that is not one before any request", async () => {
    const result = await run([...SEND, "--test", "me@example.com,not-an-address", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Not an email address: not-an-address");
    expect(segmentNamed(TEST_SEGMENT_NAME)).toHaveLength(0);
  });
});

describe("broadcasts send --wait and broadcasts get", () => {
  it("--wait follows the broadcast until it is sent, printing each change once", async () => {
    const { io, stdout } = ioFor();
    let polls = 0;
    const clock = fakeClock(() => {
      polls++;
      // Unchanged on the first poll, sent on the second.
      if (polls === 2)
        for (const b of api.store.broadcasts.values()) {
          b.status = "sent";
          b.sentCount = 2;
        }
    });
    const code = await runSend([...SEND, "--segment", "Customers", "--yes", "--wait"], io, clock);
    expect(code).toBe(0);
    expect(clock.slept).toEqual([5_000, 5_000]);
    expect(stdout.text.match(/status queued/g)).toHaveLength(1);
    expect(stdout.text).toContain("status sent · sent 2");
  });

  it("--wait gives up after 30 minutes with exit 1 and says how to follow it", async () => {
    const { io, stdout } = ioFor();
    // Ten minutes pass on every sleep: the fourth read is past the 30 minutes.
    const clock = fakeClock(() => {}, 10 * 60_000);
    const code = await runSend([...SEND, "--segment", "Customers", "--yes", "--wait"], io, clock);
    expect(code).toBe(1);
    expect(clock.slept).toHaveLength(3);
    const id = [...api.store.broadcasts.keys()][0];
    expect(stdout.text).toContain(
      `Still queued after 30 minutes; follow it with: billionsend broadcasts get ${id}`,
    );
  });

  it("--wait ends with exit 1 when the broadcast fails", async () => {
    const { io, stdout } = ioFor();
    const clock = fakeClock(() => {
      for (const b of api.store.broadcasts.values()) {
        b.status = "failed";
        b.failureReason = "domain_not_verified";
      }
    });
    const code = await runSend([...SEND, "--segment", "Customers", "--yes", "--wait"], io, clock);
    expect(code).toBe(1);
    expect(stdout.text).toContain("status failed · domain_not_verified");
  });

  it("get prints the status, or the JSON", async () => {
    await run([...SEND, "--segment", "Customers", "--yes"]);
    const id = [...api.store.broadcasts.keys()][0] ?? "";
    const text = await run(["broadcasts", "get", id]);
    expect(text.code).toBe(0);
    expect(text.stdout).toBe(`${id} · Black Friday · status queued\n`);
    const json = await run(["broadcasts", "get", id, "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ id, status: "queued" });
  });

  it("get without an id, or with an unknown one, exits 1", async () => {
    expect((await run(["broadcasts", "get"])).code).toBe(1);
    const unknown = await run(["broadcasts", "get", "00000000-0000-4000-8000-000000000000"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("not found");
  });
});

describe("emails send", () => {
  const EMAIL = [
    "emails",
    "send",
    "--from",
    "a@mail.example.com",
    "--subject",
    "Hi",
    "--html-file",
    "mail.html",
  ];

  it("sends to every --to with the idempotency key as a header", async () => {
    const result = await run([
      ...EMAIL,
      "--to",
      "x@example.com,y@example.com",
      "--reply-to",
      "r@example.com",
      "--idempotency-key",
      "bf-1",
      "--yes",
    ]);
    expect(result.code).toBe(0);
    expect(api.store.emails).toHaveLength(1);
    expect(api.store.emails[0]).toMatchObject({
      to: ["x@example.com", "y@example.com"],
      from: "a@mail.example.com",
      subject: "Hi",
      reply_to: ["r@example.com"],
      idempotencyKey: "bf-1",
    });
    expect(result.stdout).toBe(`Email ${api.store.emails[0]?.id} accepted.\n`);
  });

  it("needs --to and confirmation", async () => {
    expect((await run([...EMAIL, "--yes"])).stderr).toContain("--to is required.");
    const unconfirmed = await run([...EMAIL, "--to", "x@example.com"]);
    expect(unconfirmed.code).toBe(1);
    expect(api.store.emails).toHaveLength(0);
  });
});

describe("command line", () => {
  it("prints the sending help for a bare command and with --help", async () => {
    const bare = await run(["broadcasts"]);
    expect(bare.code).toBe(1);
    expect(bare.stdout).toContain("billionsend broadcasts send");
    const help = await run(["emails", "send", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--idempotency-key");
  });

  it("lists the sending commands in the main help", async () => {
    const help = await run(["--help"]);
    expect(help.stdout).toContain("billionsend broadcasts send");
    expect(help.stdout).toContain(TEST_SEGMENT_NAME);
  });

  it.each([
    [["broadcasts", "delete"], "Unknown command: broadcasts delete"],
    [["emails", "get"], "Unknown command: emails get"],
    [["broadcasts", "send", "extra", "--yes"], "Unexpected argument: extra"],
    [["broadcasts", "send", "--bogus"], "Unknown option '--bogus'"],
  ])("refuses %j", async (argv, message) => {
    const result = await run(argv);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("splits, trims, lowercases and de-duplicates addresses", () => {
    expect(splitAddresses([" A@x.io ,b@y.io", "a@x.io", ""])).toEqual(["a@x.io", "b@y.io"]);
    expect(splitAddresses(undefined)).toEqual([]);
    expect(() => splitAddresses(["a@x"])).toThrow("Not an email address: a@x");
  });
});

describe("edges", () => {
  it("finds a segment past the first page of the list", async () => {
    for (let i = 0; i < 105; i++) await call("POST", "/segments", { name: `Filler ${i}` });
    const last = await call<{ id: string }>("POST", "/segments", { name: "Late" });
    await call("POST", "/contacts/batch?on_conflict=error", [
      { email: "late@customer.test", segments: [{ id: last.id }] },
    ]);
    const result = await run([...SEND, "--segment", "Late", "--yes"]);
    expect(result.code).toBe(0);
    expect([...api.store.broadcasts.values()][0]?.segmentId).toBe(last.id);
  });

  it("says (none) when the account has no topic of that kind at all", async () => {
    await call("DELETE", `/topics/${newsletter.id}`);
    const result = await run([...SEND, "--segment", "Customers", "--topic", "Newsletter", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No topic "Newsletter". Existing topics:\n  (none)');
  });

  it("get shows a broadcast that has no name", async () => {
    const created = await call<{ id: string }>("POST", "/broadcasts", {
      from: "a@b.co",
      subject: "x",
      html: "<p>x</p>",
      segment_id: customers.id,
    });
    const result = await run(["broadcasts", "get", created.id]);
    expect(result.stdout).toBe(`${created.id} · status draft\n`);
  });

  it("emails send without --reply-to or a key sends neither, and --json prints the answer", async () => {
    const result = await run([
      "emails",
      "send",
      "--from",
      "a@mail.example.com",
      "--to",
      "x@example.com",
      "--subject",
      "Hi",
      "--html-file",
      "mail.html",
      "--yes",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(api.store.emails[0]).not.toHaveProperty("reply_to");
    expect(api.store.emails[0]?.idempotencyKey).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ id: api.store.emails[0]?.id });
  });

  it("emails send asks on a terminal and sends nothing on no", async () => {
    const { io, stdin, stderr } = ioFor({ tty: true });
    const pending = main(
      [
        "emails",
        "send",
        "--from",
        "a@mail.example.com",
        "--to",
        "x@example.com",
        "--subject",
        "Hi",
        "--html-file",
        "mail.html",
      ],
      io,
    );
    stdin.end("\n");
    expect(await pending).toBe(1);
    expect(stderr.text).toContain("Not sent.");
    expect(api.store.emails).toHaveLength(0);
  });

  it("refuses an empty line on stdin as the key", async () => {
    const result = await run([...SEND, "--segment", "Customers", "--yes", "--key-stdin"], {
      env: { BILLIONSEND_API_KEY: "" },
      stdin: "\n",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No BillionSend API key arrived on stdin (--key-stdin).");
  });

  it("runs on the process streams when given none", async () => {
    const write = process.stdout.write;
    let printed = "";
    process.stdout.write = ((chunk: string) => {
      printed += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await runSend(["broadcasts", "--help"])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(printed).toContain("billionsend broadcasts send");
  });
});

describe("broadcasts send --wait-timeout", () => {
  it("waits as many minutes as asked before giving up", async () => {
    const { io, stdout } = ioFor();
    const clock = fakeClock(() => {}, 30 * 60_000);
    const code = await runSend(
      [...SEND, "--segment", "Customers", "--yes", "--wait", "--wait-timeout", "90"],
      io,
      clock,
    );
    expect(code).toBe(1);
    // Reads at 0, 30, 60 and 90 minutes.
    expect(clock.slept).toHaveLength(3);
    expect(stdout.text).toContain("Still queued after 90 minutes");
  });

  it.each(["0", "-0.5", "abc", "1441"])("refuses --wait-timeout %s before sending", async (raw) => {
    const result = await run([...SEND, "--segment", "Customers", "--yes", `--wait-timeout=${raw}`]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--wait-timeout takes minutes");
    expect(api.store.broadcasts.size).toBe(0);
  });
});

describe("segments", () => {
  it("create makes a segment and prints its id", async () => {
    const result = await run(["segments", "create", "--name", "  BF last call  "]);
    expect(result.code).toBe(0);
    const [made] = segmentNamed("BF last call");
    expect(made).toBeDefined();
    expect(result.stdout).toBe(`Segment ${made?.id} created (BF last call).\n`);
    const json = await run(["segments", "create", "--name", "Other", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ object: "segment", name: "Other" });
  });

  it("create needs a name", async () => {
    const result = await run(["segments", "create", "--name", " "]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--name is required.");
  });

  it("get prints the contact count, by id or by name", async () => {
    const byId = await run(["segments", "get", customers.id]);
    expect(byId.stdout).toBe(`Customers · ${customers.id} · 2 contacts\n`);
    const byName = await run(["segments", "get", "Customers", "--json"]);
    expect(JSON.parse(byName.stdout)).toMatchObject({ id: customers.id, contact_count: 2 });
    expect((await run(["segments", "get"])).stderr).toContain("Usage: billionsend segments get");
  });
});

describe("contacts import", () => {
  const writeCsv = (name: string, text: string) => writeFileSync(join(dir, name), text);

  it("uploads the CSV into a segment, follows the import and prints the counts", async () => {
    writeCsv("list.csv", "Email,First name\nnew@buyer.test,Ann\na@customer.test,Bo\n");
    const { io, stdout } = ioFor();
    const clock = fakeClock(() => {});
    const code = await runSend(
      ["contacts", "import", "--file", "list.csv", "--segment", "Customers"],
      io,
      clock,
    );
    expect(code).toBe(0);
    expect(clock.slept).toEqual([2_000]);
    expect(members(customers.id)).toEqual(["a@customer.test", "b@customer.test", "new@buyer.test"]);
    expect(stdout.text).toContain("into segment Customers");
    expect(stdout.text).toContain(
      "status completed · 2 rows · 1 created · 1 updated · 0 skipped · 0 failed",
    );
    const sent = api.bodies.find((b) => b.operation === "POST /contacts/imports")?.body;
    expect(sent).toMatchObject({ segments: JSON.stringify([{ id: customers.id }]) });
    expect(sent).not.toHaveProperty("on_conflict");
  });

  it("passes --on-conflict skip and exits 3 when some rows failed", async () => {
    writeCsv("list.csv", "email\na@customer.test\nnot-an-address\n");
    const { io } = ioFor();
    const code = await runSend(
      ["contacts", "import", "--file", "list.csv", "--on-conflict", "skip", "--json"],
      io,
      fakeClock(() => {}),
    );
    expect(code).toBe(3);
    const sent = api.bodies.find((b) => b.operation === "POST /contacts/imports")?.body;
    expect(sent).toMatchObject({ on_conflict: "skip" });
    expect(sent).not.toHaveProperty("segments");
  });

  it("prints the import as JSON on stdout with --json", async () => {
    writeCsv("list.csv", "email\nz@buyer.test\n");
    const { io, stdout } = ioFor();
    expect(
      await runSend(
        ["contacts", "import", "--file", "list.csv", "--json"],
        io,
        fakeClock(() => {}),
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.text)).toMatchObject({
      object: "contact_import",
      status: "completed",
      counts: { total: 1, created: 1 },
    });
  });

  it("exits 1 when the import fails", async () => {
    writeCsv("bad.csv", "name\nAnn\n");
    const { io, stdout } = ioFor();
    expect(
      await runSend(
        ["contacts", "import", "--file", "bad.csv"],
        io,
        fakeClock(() => {}),
      ),
    ).toBe(1);
    expect(stdout.text).toContain("status failed");
  });

  it("gives up at --wait-timeout and says the import is still running", async () => {
    writeCsv("list.csv", "email\nz@buyer.test\n");
    const { io, stdout } = ioFor();
    const code = await runSend(
      ["contacts", "import", "--file", "list.csv", "--wait-timeout", "1"],
      io,
      // The import never settles; two minutes pass on each sleep.
      fakeClock(() => {
        for (const job of api.store.imports.values()) job.reads = -100;
      }, 120_000),
    );
    expect(code).toBe(1);
    expect(stdout.text).toContain("Still in_progress after 1 minutes.");
  });

  it.each([
    [["--on-conflict", "replace", "--file", "list.csv"], "--on-conflict takes upsert or skip."],
    [[], "--file is required."],
    [["--file", "missing.csv"], "Cannot read --file missing.csv"],
  ])("refuses %j before uploading", async (args, message) => {
    writeCsv("list.csv", "email\nz@buyer.test\n");
    const result = await run(["contacts", "import", ...args]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(api.store.imports.size).toBe(0);
  });

  it("refuses a file over 20 MiB before uploading", async () => {
    writeCsv("big.csv", "");
    truncateSync(join(dir, "big.csv"), 20 * 1024 * 1024 + 1);
    const result = await run(["contacts", "import", "--file", "big.csv"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("big.csv is larger than 20 MiB");
    expect(api.store.imports.size).toBe(0);
  });
});

describe("broadcasts recipients", () => {
  const seed = async (type: string, n: number) => {
    const b = await call<{ id: string }>("POST", "/broadcasts", {
      name: "BF",
      from: "a@b.co",
      subject: "x",
      html: "<p>x</p>",
      segment_id: customers.id,
    });
    const rows = Array.from({ length: n }, (_, i) => ({
      id: crypto.randomUUID(),
      contactId: crypto.randomUUID(),
      email: `r${String(i).padStart(3, "0")}@example.com`,
      count: 1,
      ...(type === "clicked"
        ? { clickedLinks: [{ url: "https://billionverify.com/black-friday", clicks: 2 }] }
        : {}),
      createdAt: new Date(Date.UTC(2026, 10, 20, 0, 0, i)).toISOString(),
    }));
    api.store.recipients.set(b.id, { [type]: rows });
    return b.id;
  };

  it("--all walks every page and prints CSV", async () => {
    const id = await seed("opened", 230);
    const result = await run(["broadcasts", "recipients", id, "--type", "opened", "--all"]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("email,contact_id,email_id,count,clicked_links,bounce_type");
    expect(lines).toHaveLength(231);
    expect(new Set(lines.slice(1).map((l) => l.split(",")[0])).size).toBe(230);
    expect(result.stderr).toBe("230 opened recipients.\n");
    const pages = api.bodies.filter((b) => b.operation === "GET /broadcasts/{id}/recipients");
    expect(pages).toHaveLength(3);
  });

  it("without --all reads one page and says more remain", async () => {
    const id = await seed("opened", 101);
    const result = await run(["broadcasts", "recipients", id, "--type", "opened"]);
    expect(result.stdout.trim().split("\n")).toHaveLength(101);
    expect(result.stderr).toBe("100 opened recipients; more remain, pass --all for every page.\n");
  });

  it("prints JSON with --format json or --json, clicked links included", async () => {
    const id = await seed("clicked", 1);
    const viaFormat = await run([
      "broadcasts",
      "recipients",
      id,
      "--type",
      "clicked",
      "--format",
      "json",
    ]);
    const viaJson = await run(["broadcasts", "recipients", id, "--type", "clicked", "--json"]);
    expect(viaFormat.stdout).toBe(viaJson.stdout);
    const [row] = JSON.parse(viaFormat.stdout) as { clicked_links: unknown }[];
    expect(row?.clicked_links).toEqual([
      { url: "https://billionverify.com/black-friday", clicks: 2 },
    ]);
    expect(viaFormat.stderr).toBe("1 clicked recipient.\n");
  });

  it.each([
    [["--type", "read"], "--type is one of: "],
    [[], "--type is one of: "],
    [["--type", "opened", "--format", "xml"], "--format takes csv or json."],
  ])("refuses %j", async (args, message) => {
    const id = await seed("opened", 1);
    const result = await run(["broadcasts", "recipients", id, ...args]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("needs a broadcast id", async () => {
    const result = await run(["broadcasts", "recipients", "--type", "opened"]);
    expect(result.stderr).toContain("Usage: billionsend broadcasts recipients <id>");
  });

  it("lists every type the API documents", () => {
    expect(RECIPIENT_TYPES).toEqual([
      "sent",
      "delivered",
      "opened",
      "clicked",
      "bounced",
      "complained",
      "unsubscribed",
      "suppressed",
    ]);
  });

  it("quotes CSV fields that hold commas, quotes or line breaks, and leaves the rest bare", () => {
    expect(
      recipientsCsv([
        {
          id: "e1",
          contact_id: null,
          email: "a@x.io",
          clicked_links: [
            { url: 'https://x.io/?a=1,b="2"', clicks: 1 },
            { url: "https://x.io/b", clicks: 3 },
          ],
          bounce_type: "permanent",
        },
      ]),
    ).toBe(
      'email,contact_id,email_id,count,clicked_links,bounce_type\na@x.io,,e1,,"https://x.io/?a=1,b=""2"" (1); https://x.io/b (3)",permanent\n',
    );
  });
});

describe("broadcasts list", () => {
  const make = (name: string) =>
    call<{ id: string }>("POST", "/broadcasts", {
      name,
      from: "a@b.co",
      subject: name,
      html: "<p>x</p>",
      segment_id: customers.id,
    });

  it("prints each broadcast's id, time, status and name, newest first", async () => {
    const first = await make("First");
    await new Promise((r) => setTimeout(r, 5));
    const second = await make("Second");
    const result = await run(["broadcasts", "list"]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      new RegExp(`^${second.id} · \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} · status draft · Second$`),
    );
    expect(lines[1]).toContain(first.id);
    expect(result.stderr).toBe("");
  });

  it("reads one page of --limit and says more remain, or every page with --all", async () => {
    for (let i = 0; i < 5; i++) await make(`B${i}`);
    const page = await run(["broadcasts", "list", "--limit", "2"]);
    expect(page.stdout.trim().split("\n")).toHaveLength(2);
    expect(page.stderr).toBe("More broadcasts remain; pass --all for every page.\n");
    const all = await run(["broadcasts", "list", "--limit", "2", "--all", "--json"]);
    expect((JSON.parse(all.stdout) as unknown[]).length).toBe(5);
    expect(all.stderr).toBe("");
  });

  it.each(["0", "101", "2.5", "x"])("refuses --limit %s", async (raw) => {
    const result = await run(["broadcasts", "list", `--limit=${raw}`]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--limit takes a whole number from 1 to 100.");
  });
});

describe("broadcasts send dormant options", () => {
  it("sends dormant_check and include_dormant only when asked", async () => {
    await run([...SEND, "--segment", "Customers", "--yes"]);
    await run([
      ...SEND,
      "--segment",
      "Customers",
      "--yes",
      "--no-dormant-check",
      "--include-dormant",
    ]);
    const bodies = api.bodies
      .filter((b) => b.operation === "POST /broadcasts")
      .map((b) => b.body as Record<string, unknown>);
    expect(bodies[0]).not.toHaveProperty("dormant_check");
    expect(bodies[0]).not.toHaveProperty("include_dormant");
    expect(bodies[1]).toMatchObject({ dormant_check: false, include_dormant: true });
  });
});
