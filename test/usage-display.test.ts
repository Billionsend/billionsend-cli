import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { type ContractApi, startContractApi } from "./helpers/contract-api.js";
import { type FakeResend, startFakeResend } from "./helpers/fake-resend.js";

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

/** Runs `migrate plan` with GET /usage answered as `plan` (the contract API checks the real answer first). */
async function planWithUsagePlan(plan: string | null) {
  const input = new PassThrough();
  input.end("");
  const stdout = sink();
  const stderr = sink();
  const answerUsage: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).endsWith("/usage")) return response;
    const body = (await response.json()) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...body, plan }), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  const code = await main(["migrate", "plan", "--from", "resend", "--only", "topics"], {
    stdin: input,
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      RESEND_API_KEY: fake.token,
      BILLIONSEND_CLI_RESEND_URL: fake.url,
      BILLIONSEND_API_KEY: api.apiKey,
      BILLIONSEND_BASE_URL: api.baseUrl,
    },
    cwd: mkdtempSync(join(tmpdir(), "billionsend-cli-usage-")),
    fetch: answerUsage,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe("the connect line", () => {
  it("names a team no plan limits by what it is, never as `plan Unknown`", async () => {
    const { stdout } = await planWithUsagePlan(null);
    expect(stdout).toContain(`✓ BillionSend (${api.baseUrl}) · no plan limits\n`);
    expect(stdout).not.toContain("Unknown");
  });

  it("names the plan when there is one", async () => {
    const { stdout } = await planWithUsagePlan("scale");
    expect(stdout).toContain(`✓ BillionSend (${api.baseUrl}) · plan Scale\n`);
  });
});
