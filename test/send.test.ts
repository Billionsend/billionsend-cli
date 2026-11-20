import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { type Clock, runSend, splitAddresses, TEST_SEGMENT_NAME } from "../src/send.js";
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
