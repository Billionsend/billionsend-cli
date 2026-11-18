import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { type ContractApi, startContractApi } from "./helpers/contract-api.js";
import { type FakeResend, startFakeResend } from "./helpers/fake-resend.js";

/*
 * Connecting to either side, in-process: a key that is missing, wrong or piped in, and the team
 * limit the source announces against the rate asked for.
 */

let fake: FakeResend;
let api: ContractApi;

beforeAll(async () => {
  [fake, api] = await Promise.all([startFakeResend(), startContractApi()]);
});
afterAll(() => Promise.all([fake.close(), api.stop()]));

const sink = () => {
  let text = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    }),
    get text() {
      return text;
    },
  };
};

async function plan(
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    stdin?: string;
    fetch?: typeof fetch;
  } = {},
) {
  const input = new PassThrough();
  input.end(options.stdin ?? "");
  const stdout = sink();
  const stderr = sink();
  const env: Record<string, string | undefined> = {
    RESEND_API_KEY: fake.token,
    BILLIONSEND_CLI_RESEND_URL: fake.url,
    BILLIONSEND_API_KEY: api.apiKey,
    BILLIONSEND_BASE_URL: api.baseUrl,
    ...options.env,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const code = await main(["migrate", "plan", "--from", "resend", "--only", "topics", ...args], {
    stdin: input,
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: env as NodeJS.ProcessEnv,
    cwd: mkdtempSync(join(tmpdir(), "billionsend-cli-connect-")),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** The same Resend answers with the team limit header set to `limit` (or taken out for null). */
const withLimit =
  (limit: number | null): typeof fetch =>
  async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).startsWith(fake.url)) return response;
    const headers = new Headers(response.headers);
    if (limit === null) headers.delete("ratelimit-limit");
    else headers.set("ratelimit-limit", String(limit));
    return new Response(await response.text(), { status: response.status, headers });
  };

describe("a key that is missing", () => {
  it("is asked for by name when nothing can be prompted", async () => {
    const { code, stderr } = await plan(["--non-interactive"], {
      env: { RESEND_API_KEY: undefined },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("Missing Resend API key. Set RESEND_API_KEY or pass --from-key-stdin");
    const target = await plan(["--non-interactive"], { env: { BILLIONSEND_API_KEY: undefined } });
    expect(target.code).toBe(1);
    expect(target.stderr).toContain(
      "Missing BillionSend API key. Set BILLIONSEND_API_KEY or pass --to-key-stdin",
    );
  });

  it("can arrive on stdin, one line, without its line break", async () => {
    const { code, stdout } = await plan(["--from-key-stdin"], {
      env: { RESEND_API_KEY: undefined },
      stdin: `${fake.token}\r\n`,
    });
    expect(code).toBe(2);
    expect(stdout).toContain("✓ Resend · connected");
  });

  it("an empty stdin is an error that names the flag", async () => {
    const { code, stderr } = await plan(["--from-key-stdin"], {
      env: { RESEND_API_KEY: undefined },
      stdin: "\n",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("No Resend API key arrived on stdin (--from-key-stdin).");
  });
});

describe("a key that is wrong", () => {
  it("is a 401 on the source and says which variable to check", async () => {
    const { code, stderr } = await plan([], { env: { RESEND_API_KEY: "re_wrong_key_123456" } });
    expect(code).toBe(1);
    expect(stderr).toContain("Resend rejected the API key (401). Check RESEND_API_KEY");
  });

  it("is a 401 on BillionSend too", async () => {
    const { code, stderr } = await plan([], {
      env: { BILLIONSEND_API_KEY: "bs_wrong_key_123456" },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("BillionSend rejected the API key (401)");
  });

  it("an error of the source that is not about the key is shown as it is", async () => {
    const refuse: typeof fetch = async (url, init) =>
      String(url).startsWith(fake.url)
        ? new Response(JSON.stringify({ name: "validation_error", message: "not today" }), {
            status: 422,
            headers: { "content-type": "application/json" },
          })
        : fetch(url, init);
    const { code, stderr } = await plan([], { fetch: refuse });
    expect(code).toBe(1);
    expect(stderr).toContain("not today");
  });

  it("a key with a stray line break in it is refused before anything is sent, without printing it", async () => {
    const { code, stderr } = await plan([], { env: { RESEND_API_KEY: `${fake.token}x\u0007y` } });
    expect(code).toBe(1);
    expect(stderr).toContain("the authorization header holds a character a header cannot carry");
    expect(stderr).not.toContain(fake.token);
  });
});

describe("the team limit against the rate asked for", () => {
  it("a raised limit is used with headroom unless --rps chose the rate", async () => {
    const { stdout } = await plan([], { fetch: withLimit(30) });
    expect(stdout).toContain("limit 30 req/s, using 28");
  });

  it("a rate above the announced limit is allowed and warned about", async () => {
    const { stdout, stderr } = await plan(["--rps", "12"], { fetch: withLimit(10) });
    expect(stdout).toContain("limit 10 req/s, using 12");
    expect(stderr).toContain("--rps 12 is above the Resend team limit of 10 req/s");
  });

  it("a rate above the default limit with no header seen is warned about too", async () => {
    const { stdout, stderr } = await plan(["--rps", "12"], { fetch: withLimit(null) });
    expect(stdout).toContain("connected");
    expect(stdout).toContain("12 req/s");
    expect(stderr).toContain("no limit header was seen");
  });
});
