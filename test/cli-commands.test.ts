import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MigrateState, Plan } from "../src/model.js";
import { migratePaths, writePrivateJson } from "../src/paths.js";
import {
  type ContractApi,
  type Plan as PlanName,
  startContractApi,
} from "./helpers/contract-api.js";
import { type FakeResend, loadFixtures, startFakeResend } from "./helpers/fake-resend.js";
import { cliRunner, readReportIn } from "./helpers/run-cli.js";

/*
 * The commands around migrate, in-process against a fake source and the contract API: what status
 * shows, how rollback and apply refuse, and how a plan file and a state file are held to the run.
 */

const UUID = "00000000-0000-4000-8000-0000000000aa";

let fake: FakeResend;
let api: ContractApi;
let dir: string;
let run: ReturnType<typeof cliRunner>;

async function boot(options: { plan?: PlanName; domains?: number } = {}): Promise<void> {
  const data = loadFixtures();
  const base = data.domains[0] as (typeof data.domains)[number];
  for (let i = 0; i < (options.domains ?? 0); i++) {
    data.domains.push({
      ...base,
      id: `0000000${i}-0000-4000-8000-000000000000`,
      name: `extra${i}.example.org`,
    });
  }
  [fake, api] = await Promise.all([
    startFakeResend(data),
    startContractApi(options.plan === undefined ? {} : { plan: options.plan }),
  ]);
  dir = mkdtempSync(join(tmpdir(), "billionsend-cli-commands-"));
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  run = cliRunner(fake, api, dir);
}

afterEach(async () => {
  await Promise.all([fake.close(), api.stop()]);
});

const writeState = (patch: Partial<MigrateState> = {}): MigrateState => {
  const state: MigrateState = {
    version: 1,
    startedAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:01:00.000Z",
    planHash: "abcdef0123456789",
    target: { baseUrl: api.baseUrl },
    created: {},
    progress: {},
    failures: [],
    ...patch,
  };
  mkdirSync(migratePaths(dir).dir, { recursive: true });
  writePrivateJson(migratePaths(dir).state, state);
  return state;
};

describe("migrate status", () => {
  beforeEach(() => boot());

  it("says there is nothing when no run has been made here, and prints null as JSON", async () => {
    const text = await run(["migrate", "status"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(
      "No migration state in .billionsend/ — nothing has been applied from here.",
    );
    const json = await run(["migrate", "status", "--json"]);
    expect(json.stdout).toBe("null\n");
  });

  it("shows where a stopped run resumes, what it left for later, and each failure", async () => {
    const state = writeState({
      created: { topics: [UUID], mystery: [UUID, UUID] } as never,
      progress: { contactsCursor: "c-42", enrichmentDone: ["a", "b"] },
      failures: [{ resource: "contacts", key: "bad@example", message: "refused" }],
    });
    const { stdout, code } = await run(["migrate", "status"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Contacts\s+resumes after c-42/);
    expect(stdout).toMatch(/Enriched\s+resumes with 2 done/);
    // A resource this version does not know is named as it is.
    expect(stdout).toMatch(/mystery\s+2/);
    expect(stdout).toContain("1 failure in the last run");
    expect(stdout).toContain("✗ contacts/bad@example — refused");
    const json = await run(["migrate", "status", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual(state);
  });

  it("shows a state with nothing created", async () => {
    writeState();
    const { stdout } = await run(["migrate", "status"]);
    expect(stdout).toContain("Created\n  nothing\n");
  });
});

describe("migrate rollback", () => {
  beforeEach(() => boot());

  it("refuses a state file made on another instance", async () => {
    writeState({ target: { baseUrl: "https://other.example.test" }, created: { topics: [UUID] } });
    const { code, stderr } = await run(["migrate", "rollback", "--yes"]);
    expect(code).toBe(1);
    expect(stderr).toContain("belongs to https://other.example.test");
  });

  it("will not ask in a non-interactive run: it needs --yes", async () => {
    writeState({ created: { topics: [UUID] } });
    const { code, stderr } = await run(["migrate", "rollback"]);
    expect(code).toBe(1);
    expect(stderr).toContain("migrate/apply/rollback need --yes in non-interactive mode");
    expect(api.store.topics.size).toBe(0);
  });

  it("keeps the ids of what the API refused to delete, lists them, and exits 3", async () => {
    writeState({ created: { topics: [UUID] } });
    const refuse: typeof fetch = async (url, init) =>
      init?.method === "DELETE"
        ? new Response(JSON.stringify({ name: "validation_error", message: "in use" }), {
            status: 422,
            headers: { "content-type": "application/json" },
          })
        : fetch(url, init);
    const { code, stdout } = await run(["migrate", "rollback", "--yes"], { fetch: refuse });
    expect(code).toBe(3);
    expect(stdout).toContain("1 delete failed; the ids stay in");
    expect(stdout).toContain(`topics/${UUID} — in use`);
    const kept = JSON.parse(readFileSync(migratePaths(dir).state, "utf8")) as MigrateState;
    expect(kept.created.topics).toEqual([UUID]);
  });
});

describe("migrate apply with a plan file", () => {
  beforeEach(() => boot());

  it("a file that is not there says how to make it, and one that cannot be read is the read error", async () => {
    const missing = await run(["migrate", "apply", join(dir, "nope.json"), "--yes"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("not found; run `migrate plan --from resend --out");
    const asDir = await run(["migrate", "apply", dir, "--yes"]);
    expect(asDir.code).toBe(1);
    expect(asDir.stderr).toContain("EISDIR");
  });

  it("every flag that disagrees with the file is listed at once, naming both values", async () => {
    const file = join(dir, "plan.json");
    expect(
      (
        await run([
          "migrate",
          "plan",
          "--from",
          "resend",
          "--only",
          "topics,segments",
          "--out",
          file,
        ])
      ).code,
    ).toBe(2);
    const { code, stderr } = await run([
      "migrate",
      "apply",
      file,
      "--yes",
      "--only",
      "contacts",
      "--skip",
      "topics",
      "--segment",
      "Active Users",
      "--on-conflict",
      "error",
      "--include-sent",
      "--fresh-webhook-secrets",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--only: the command line has contacts, the file has topics,segments");
    expect(stderr).toContain("--skip: the command line has topics, the file has (none)");
    expect(stderr).toContain("--segment: the command line has Active Users, the file has (none)");
    expect(stderr).toContain("--on-conflict: the command line has error, the file has upsert");
    expect(stderr).toContain("--include-sent: the command line has true, the file has false");
    expect(stderr).toContain(
      "--fresh-webhook-secrets: the command line has true, the file has false",
    );
    expect(api.store.topics.size).toBe(0);
  });

  it("a file made for another instance is refused", async () => {
    const file = join(dir, "plan.json");
    await run(["migrate", "plan", "--from", "resend", "--only", "topics", "--out", file]);
    const plan = JSON.parse(readFileSync(file, "utf8")) as Plan;
    plan.target.baseUrl = "https://other.example.test";
    writeFileSync(file, JSON.stringify(plan));
    const { code, stderr } = await run(["migrate", "apply", file, "--yes"]);
    expect(code).toBe(1);
    expect(stderr).toContain(
      `was made for https://other.example.test; connected to ${api.baseUrl}.`,
    );
  });

  it("names the first five items that changed since the file was made and counts the rest", async () => {
    const file = join(dir, "plan.json");
    await run(["migrate", "plan", "--from", "resend", "--only", "topics", "--out", file]);
    for (let i = 0; i < 8; i++) {
      fake.data.topics.push({
        id: `0000000${i}-0000-4000-8000-0000000000b0`,
        name: `New topic ${i}`,
        default_subscription: "opt_in",
        visibility: "public",
        created_at: "2026-11-19 00:00:00.000+00",
      });
    }
    const { code, stderr } = await run(["migrate", "apply", file, "--yes"]);
    expect(code).toBe(1);
    expect(stderr).toContain("topics/New topic 0: not in the file, in the current plan");
    expect(stderr).toContain("; … and 3 more.");
  });

  it("with no file it is the whole migration, planned and applied in one go", async () => {
    const { code } = await run([
      "migrate",
      "apply",
      "--from",
      "resend",
      "--yes",
      "--only",
      "topics",
      "--rps",
      "10",
    ]);
    expect(code).toBe(0);
    expect(api.store.topics.size).toBe(2);
  });
});

describe("migrate and the state file", () => {
  beforeEach(() => boot());

  it("a state made on another instance stops the run, unless --fresh starts over for this one", async () => {
    writeState({ target: { baseUrl: "https://other.example.test" } });
    const stopped = await run(["migrate", "--from", "resend", "--yes", "--only", "topics"]);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain(
      "belongs to https://other.example.test; run from another directory or pass --fresh.",
    );
    expect(api.store.topics.size).toBe(0);
    const fresh = await run([
      "migrate",
      "--from",
      "resend",
      "--yes",
      "--only",
      "topics",
      "--fresh",
      "--rps",
      "10",
    ]);
    expect(fresh.code).toBe(0);
    expect(api.store.topics.size).toBe(2);
  });

  it("a run with nothing to write says so, and its --json report counts the rows it left alone", async () => {
    expect(
      (
        await run([
          "migrate",
          "--from",
          "resend",
          "--yes",
          "--only",
          "topics,contacts",
          "--rps",
          "10",
        ])
      ).code,
    ).toBe(0);
    // Topics are now unchanged; the contacts are there, so --on-conflict skip leaves them all.
    const idle = await run([
      "migrate",
      "--from",
      "resend",
      "--yes",
      "--only",
      "topics,contacts",
      "--on-conflict",
      "skip",
      "--json",
      "--rps",
      "10",
    ]);
    expect(idle.code).toBe(0);
    expect(idle.stderr).toContain("Nothing to do.");
    const report = JSON.parse(idle.stdout) as {
      counts: Record<string, { unchanged: number; skipped: number }>;
    };
    expect(report.counts.topics?.unchanged).toBe(2);
    expect(report.counts.contacts?.skipped).toBe(3);
  });
});

describe("the domain cap without anybody to ask", () => {
  beforeEach(() => boot({ plan: "free", domains: 3 }));

  it("a plan and a --yes run both take the first domains and list the rest", async () => {
    const planned = await run(["migrate", "plan", "--from", "resend", "--only", "domains"]);
    expect(planned.code).toBe(2);
    expect(planned.stdout).toContain(
      "3 of 5 domains will be created; the rest are listed as manual.",
    );
    const applied = await run([
      "migrate",
      "--from",
      "resend",
      "--yes",
      "--only",
      "domains",
      "--rps",
      "10",
    ]);
    expect(applied.stdout).toContain("3 of 5 domains will be created");
    expect(api.store.domains.size).toBe(3);
    expect(readReportIn(dir).counts.domains).toMatchObject({ created: 3 });
  });
});

describe("arguments", () => {
  beforeEach(() => boot());

  it("a URL that is not http(s), a stray argument and a missing provider are each named", async () => {
    const url = await run([
      "migrate",
      "plan",
      "--from",
      "resend",
      "--to-url",
      "ftp://example.test",
    ]);
    expect(url.code).toBe(1);
    expect(url.stderr).toContain("The BillionSend API URL must be http(s): ftp://example.test");
    const extra = await run(["migrate", "plan", "extra", "--from", "resend"]);
    expect(extra.stderr).toContain("Unexpected argument `extra`.");
    const more = await run(["migrate", "apply", "plan.json", "second", "--from", "resend"]);
    expect(more.stderr).toContain("Unexpected argument `second`.");
    const noProvider = await run(["migrate", "plan"]);
    expect(noProvider.stderr).toContain(
      "Missing --from <provider>. Only `resend` is supported: billionsend migrate plan --from resend",
    );
    const bare = await run(["migrate"]);
    expect(bare.stderr).toContain("billionsend migrate --from resend");
  });

  it("a key given on the command line is warned about, as every other line of a run is, before anything else", async () => {
    const { stderr } = await run(
      ["migrate", "plan", "--from", "resend", "--only", "topics", "--from-key", fake.token],
      {
        env: { RESEND_API_KEY: "" },
      },
    );
    expect(stderr).toContain("--from-key is visible to other users in process lists");
  });
});
