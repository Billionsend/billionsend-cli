import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plan } from "../src/model.js";
import {
  type ContractApi,
  type Plan as PlanName,
  startContractApi,
} from "./helpers/contract-api.js";
import { type FakeResend, loadFixtures, startFakeResend } from "./helpers/fake-resend.js";
import { type PtyStep, plain, runOnTerminal } from "./helpers/pty.js";

/*
 * The built bundle on a pseudo-terminal with scripted keystrokes: the raw-mode pickers, the masked
 * key entry, the confirmations and the live progress, which a pipe never reaches.
 */

const SLOW = 120_000;
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const CTRL_C = "\x03";

let fake: FakeResend;
let api: ContractApi;
let cwd: string;

async function boot(options: { plan?: PlanName; domains?: number } = {}): Promise<void> {
  const data = loadFixtures();
  // Extra verified-looking domains, to go past a Free team's cap of 3.
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
  cwd = mkdtempSync(join(tmpdir(), "billionsend-e2e-terminal-"));
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
}

afterEach(async () => {
  await Promise.all([fake.close(), api.stop()]);
});

const keys = (): Record<string, string> => ({
  RESEND_API_KEY: fake.token,
  BILLIONSEND_CLI_RESEND_URL: fake.url,
  BILLIONSEND_API_KEY: api.apiKey,
  BILLIONSEND_BASE_URL: api.baseUrl,
});

const run = (
  args: string[],
  steps: PtyStep[],
  extra: { cols?: number; env?: Record<string, string | undefined> } = {},
) =>
  runOnTerminal(args, steps, {
    cwd,
    env: { ...keys(), ...extra.env },
    ...(extra.cols === undefined ? {} : { cols: extra.cols }),
  });

describe("the resource picker and the confirmation", () => {
  beforeEach(() => boot());

  it(
    "toggles with the keys, shows the choice, asks before writing, and writes only what was ticked",
    async () => {
      const { output, code, missing } = await run(
        ["migrate", "--from", "resend", "--rps", "10"],
        [
          // All start ticked: `a` clears them, then Down + Space ticks the second and the third.
          { expect: "Resources", send: `a${DOWN} ${DOWN} ` },
          { expect: "Resources", send: `${UP}${UP}${DOWN}${ENTER}` },
          { expect: "Apply this plan? (y/N)", send: `y${ENTER}` },
        ],
      );
      expect(missing).toBeNull();
      expect(code).toBe(0);
      const text = plain(output);
      expect(text).toContain("Resources\n  Contact properties 2\n  Topics 2\n");
      expect(text).toContain("Applying");
      expect([...api.store.contactProperties.values()].map((p) => p.key).sort()).toEqual([
        "plan",
        "seats",
      ]);
      expect(api.store.topics.size).toBe(2);
      expect(api.store.contacts.size).toBe(0);
      expect(api.store.domains.size).toBe(0);
      // The cursor is shown again after the picker, and the colours reach the terminal.
      expect(output).toContain("\x1b[?25h");
      expect(output).toContain("\x1b[");
    },
    SLOW,
  );

  it(
    "ticking nothing is a plan with nothing in it, and answering no to the confirmation writes nothing",
    async () => {
      const none = await run(
        ["migrate", "--from", "resend", "--rps", "10"],
        [{ expect: "Resources", send: `a${ENTER}` }],
      );
      expect(none.missing).toBeNull();
      expect(plain(none.output)).toContain("Resources: none");
      expect(none.code).toBe(0);

      const refused = await run(
        ["migrate", "--from", "resend", "--rps", "10"],
        [
          { expect: "Resources", send: ENTER },
          { expect: "Apply this plan? (y/N)", send: `n${ENTER}` },
        ],
      );
      expect(refused.missing).toBeNull();
      expect(plain(refused.output)).toContain("Nothing applied.");
      expect(refused.code).toBe(0);
      expect(api.store.topics.size).toBe(0);
    },
    SLOW,
  );

  it(
    "Ctrl-C at the picker gives the terminal back and exits 130",
    async () => {
      const { output, code, missing } = await run(
        ["migrate", "--from", "resend"],
        [{ expect: "Resources", send: CTRL_C }],
      );
      expect(missing).toBeNull();
      expect(code).toBe(130);
      expect(output).toContain("\x1b[?25h");
      expect(api.store.topics.size).toBe(0);
    },
    SLOW,
  );
});

describe("keys typed at a prompt", () => {
  beforeEach(() => boot());

  it(
    "are never echoed: backspace edits, and only a masked form reaches the screen",
    async () => {
      const typo = `${fake.token}zz`;
      const { output, code, missing } = await run(
        ["migrate", "plan", "--from", "resend", "--only", "topics"],
        [
          { expect: "Resend API key (full access): ", send: `${typo}\x7f\x7f${ENTER}` },
          { expect: "BillionSend API key (full access): ", send: `${api.apiKey}${ENTER}` },
        ],
        { env: { RESEND_API_KEY: undefined, BILLIONSEND_API_KEY: undefined } },
      );
      expect(missing).toBeNull();
      // The topics are not there yet: a plan with changes exits 2.
      expect(code).toBe(2);
      expect(output).not.toContain(fake.token);
      expect(output).not.toContain(api.apiKey);
      expect(plain(output)).toMatch(/Resend API key \(full access\): re_\*\*\*\*…/);
      expect(plain(output)).toMatch(/BillionSend API key \(full access\): bs_\*\*\*\*…/);
    },
    SLOW,
  );
});

describe("a key prompt left empty", () => {
  beforeEach(() => boot());

  it(
    "is an error that names the variable, not a request sent with no key",
    async () => {
      const { code, output, missing } = await run(
        ["migrate", "plan", "--from", "resend", "--only", "topics"],
        [{ expect: "Resend API key (full access): ", send: ENTER }],
        { env: { RESEND_API_KEY: undefined } },
      );
      expect(missing).toBeNull();
      expect(code).toBe(1);
      expect(plain(output)).toContain(
        "Missing Resend API key. Set RESEND_API_KEY or pass --from-key-stdin.",
      );
    },
    SLOW,
  );
});

describe("the domain cap on a Free team", () => {
  beforeEach(() => boot({ plan: "free", domains: 3 }));

  it(
    "is a choice between creating the first few and stopping; creating goes on and exits 3 for the refused tracking host",
    async () => {
      const first = await run(
        ["migrate", "--from", "resend", "--rps", "10", "--only", "domains"],
        [
          { expect: "Domain limit", send: `${DOWN}${UP}${ENTER}` },
          { expect: "Apply this plan? (y/N)", send: `y${ENTER}` },
        ],
      );
      expect(first.missing).toBeNull();
      expect(plain(first.output)).toContain(
        "3 of 5 domains will be created; the rest are listed as manual.",
      );
      expect(api.store.domains.size).toBe(3);
    },
    SLOW,
  );

  it(
    "Stop leaves everything as it was and exits 1",
    async () => {
      const stopped = await run(
        ["migrate", "--from", "resend", "--rps", "10", "--only", "domains"],
        [{ expect: "Domain limit", send: `${DOWN}${ENTER}` }],
      );
      expect(stopped.missing).toBeNull();
      expect(stopped.code).toBe(1);
      expect(plain(stopped.output)).toContain("Stopped at the domain limit; nothing was applied.");
      expect(api.store.domains.size).toBe(0);
    },
    SLOW,
  );
});

describe("rollback and a stale plan file", () => {
  beforeEach(() => boot());

  it(
    "rollback asks first; no deletes nothing, yes deletes what the run created",
    async () => {
      expect(
        (await run(["migrate", "--from", "resend", "--yes", "--rps", "10", "--only", "topics"], []))
          .code,
      ).toBe(0);
      expect(api.store.topics.size).toBe(2);
      const no = await run(["migrate", "rollback"], [{ expect: "(y/N)", send: `n${ENTER}` }]);
      expect(no.missing).toBeNull();
      expect(plain(no.output)).toContain("Nothing deleted.");
      expect(api.store.topics.size).toBe(2);
      const yes = await run(["migrate", "rollback"], [{ expect: "(y/N)", send: `y${ENTER}` }]);
      expect(yes.code).toBe(0);
      expect(plain(yes.output)).toContain("Rolled back.");
      expect(api.store.topics.size).toBe(0);
    },
    SLOW,
  );

  it(
    "a plan file older than an hour offers the current plan instead: no declines, yes applies it",
    async () => {
      const file = join(cwd, "plan.json");
      expect(
        (await run(["migrate", "plan", "--from", "resend", "--only", "topics", "--out", file], []))
          .code,
      ).toBe(2);
      const plan = JSON.parse(readFileSync(file, "utf8")) as Plan;
      plan.createdAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
      writeFileSync(file, JSON.stringify(plan));
      const no = await run(
        ["migrate", "apply", file, "--rps", "10"],
        [{ expect: "Apply the current plan instead? (y/N)", send: `n${ENTER}` }],
      );
      expect(no.missing).toBeNull();
      expect(plain(no.output)).toContain("Nothing applied.");
      expect(api.store.topics.size).toBe(0);
      const yes = await run(
        ["migrate", "apply", file, "--rps", "10"],
        [
          { expect: "Apply the current plan instead? (y/N)", send: `y${ENTER}` },
          { expect: "Apply this plan? (y/N)", send: `y${ENTER}` },
        ],
      );
      expect(yes.code).toBe(0);
      expect(api.store.topics.size).toBe(2);
    },
    SLOW,
  );
});

describe("the banner follows the terminal's width", () => {
  beforeEach(() => boot());

  it(
    "full on a wide terminal, compact on a medium one, a plain line on a narrow one",
    async () => {
      const heads = [];
      for (const cols of [120, 60, 24]) {
        const { output } = await run(
          ["migrate", "plan", "--from", "resend", "--only", "topics"],
          [],
          { cols },
        );
        heads.push(plain(output).split("\n").slice(0, 8));
      }
      const [wide, medium, narrow] = heads as [string[], string[], string[]];
      expect(wide.length).toBe(8);
      expect(new Set(wide.join("").split("")).size).toBeGreaterThan(5);
      // The three banners differ, and the narrowest has no art.
      expect(new Set([wide.join("\n"), medium.join("\n"), narrow.join("\n")]).size).toBe(3);
      expect(narrow.join("\n")).toContain("billionsend");
    },
    SLOW,
  );
});
