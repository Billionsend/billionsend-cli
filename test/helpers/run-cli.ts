import { existsSync, readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { main } from "../../src/index.js";
import type { MigrateState } from "../../src/model.js";
import { migratePaths } from "../../src/paths.js";
import type { Report } from "../../src/report.js";
import type { ContractApi } from "./contract-api.js";
import type { FakeResend } from "./fake-resend.js";

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

/** Runs the CLI in-process against a fake source and a contract API, in `dir`. */
export function cliRunner(fake: FakeResend, api: ContractApi, dir: string) {
  return async function run(
    argv: string[],
    options: { env?: Record<string, string>; stdin?: string; fetch?: typeof fetch } = {},
  ) {
    const input = new PassThrough();
    input.end(options.stdin ?? "");
    const stdout = collector();
    const stderr = collector();
    const code = await main(argv, {
      stdin: input,
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: {
        RESEND_API_KEY: fake.token,
        BILLIONSEND_CLI_RESEND_URL: fake.url,
        BILLIONSEND_API_KEY: api.apiKey,
        BILLIONSEND_BASE_URL: api.baseUrl,
        ...options.env,
      },
      cwd: dir,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    return { code, stdout: stdout.text, stderr: stderr.text };
  };
}

export const readStateIn = (dir: string): MigrateState | null => {
  const path = migratePaths(dir).state;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as MigrateState) : null;
};

export const readReportIn = (dir: string): Report =>
  JSON.parse(readFileSync(migratePaths(dir).reportJson, "utf8")) as Report;
