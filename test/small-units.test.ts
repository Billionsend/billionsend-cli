import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttp, networkReason, retryAfterMs } from "../src/http.js";
import { createLogger } from "../src/log.js";
import type { PlanItem, SourceBroadcast } from "../src/model.js";
import { writePrivate } from "../src/paths.js";
import { describePlanDiff } from "../src/plan.js";
import { createProgress } from "../src/progress.js";
import { broadcastCreateInput, translateSegmentFilter } from "../src/translate.js";
import { cursorTracker } from "../src/tty-ui.js";
import { capitalize, senderDomain } from "../src/utils.js";

describe("networkReason", () => {
  it("names the cause by its code and address, by its message, or the error alone", () => {
    const withCode = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND", address: "10.0.0.5" },
    });
    expect(networkReason(withCode)).toBe("fetch failed (ENOTFOUND 10.0.0.5)");
    const bare = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    expect(networkReason(bare)).toBe("fetch failed (ETIMEDOUT)");
    const withMessage = Object.assign(new TypeError("fetch failed"), {
      cause: { message: "self-signed certificate" },
    });
    expect(networkReason(withMessage)).toBe("fetch failed (self-signed certificate)");
    const empty = Object.assign(new TypeError("fetch failed"), { cause: {} });
    expect(networkReason(empty)).toBe("fetch failed");
    expect(networkReason("a string was thrown")).toBe("a string was thrown");
  });
});

describe("retryAfterMs", () => {
  it("is null for a header that is neither seconds nor a date, and for a ratelimit-reset that is not a number", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "soon" }))).toBeNull();
    expect(retryAfterMs(new Headers({ "ratelimit-reset": "later" }))).toBeNull();
    expect(retryAfterMs(new Headers())).toBeNull();
  });
});

describe("the client's answers to what the API says", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const client = (fetchMock: ReturnType<typeof vi.fn>) =>
    createHttp({
      baseUrl: "https://api.example.test",
      token: "bs_test",
      userAgent: "billionsend-cli/test",
      rps: 1000,
      name: "BillionSend",
      log: createLogger({ level: "error" }),
      fetch: fetchMock as unknown as typeof fetch,
    });

  it("an error with no body, or a body that is not an object, still says what happened", async () => {
    const empty = vi.fn().mockResolvedValue(new Response(null, { status: 418 }));
    await expect(client(empty).get("x")).rejects.toMatchObject({
      status: 418,
      name: "http_error",
      message: "BillionSend answered 418 to GET /x",
    });
    const text = vi.fn().mockResolvedValue(new Response("nope", { status: 400 }));
    await expect(client(text).get("/x")).rejects.toMatchObject({ status: 400, name: "http_error" });
  });

  it("a 429 without Retry-After waits two seconds; a re-pace while recovering keeps the lower rate", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const http = client(fetchMock);
    const pending = http.get("/x");
    await vi.advanceTimersByTimeAsync(1900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await pending;
    // The 429 halved the pace; asking for a different one now keeps the lower of the two until it recovers.
    http.setRps(5);
    expect(http.rateLimit).toBeNull();
  });
});

describe("cursorTracker", () => {
  it("follows cursor moves down, right and left, clamped to the row", () => {
    const cursor = cursorTracker(() => 10);
    cursor.feed("ab\n\x1b[2B");
    expect(cursor.row()).toBe(3);
    cursor.feed("\x1b[3C\x1b[20C");
    cursor.feed("x");
    // The row is full: the next character wraps.
    cursor.feed("y");
    expect(cursor.row()).toBe(4);
    cursor.feed("\x1b[5D\x1b[9D\x1b[1A");
    expect(cursor.row()).toBe(3);
  });
});

describe("senderDomain and capitalize", () => {
  it("find no domain in a string with no address, or an address that ends at the @", () => {
    expect(senderDomain("not an address")).toBeNull();
    expect(senderDomain("Acme <hello@>")).toBeNull();
    expect(senderDomain("Acme <Hello@Example.COM>")).toBe("example.com");
    expect(capitalize("")).toBe("");
  });
});

describe("a stale temporary file", () => {
  it("is replaced, not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "billionsend-cli-paths-"));
    const path = join(dir, "state.json");
    writeFileSync(`${path}.tmp`, "left behind by a run that was killed");
    writePrivate(path, "{}\n");
    expect(readText(path)).toBe("{}\n");
  });
});

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

describe("progress on a terminal", () => {
  it("shows a pace once enough has been done, in whole numbers from ten a second, and ignores updates after the end", () => {
    vi.useFakeTimers();
    try {
      const chunks: string[] = [];
      const stream = {
        write: (c: string) => {
          chunks.push(String(c));
          return true;
        },
      } as never;
      const progress = createProgress({ stream, tty: true });
      progress.section(["Contacts"]);
      const step = progress.step("Contacts");
      step.update(0, 1000);
      vi.setSystemTime(Date.now() + 1500);
      step.update(300, 1000);
      vi.setSystemTime(Date.now() + 1500);
      step.update(320, 1000);
      // Old samples fall out of the window, and the slow second stretch shows its own pace.
      vi.setSystemTime(Date.now() + 60_000);
      step.update(330, 1000);
      step.done();
      step.update(999, 1000);
      const text = chunks.join("");
      expect(text).toMatch(/200\/s/);
      expect(text).toMatch(/\d\.\d\/s/);
      expect(text.endsWith("✓ Contacts 330/1,000\n")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("segment filters and broadcasts the source words differently", () => {
  it("a created_at operator with no counterpart is named", () => {
    expect(
      translateSegmentFilter({
        match: "all",
        conditions: [{ field: "created_at", operator: "contains", value: "2026" }],
      }),
    ).toEqual({
      filter: null,
      reason: expect.stringContaining('operator "contains" on "created_at"'),
    });
  });

  it("a match mode that is not a string is unknown", () => {
    expect(translateSegmentFilter({ match: 5, conditions: [] }).reason).toBe(
      'unknown match mode "5"',
    );
  });

  it("a broadcast scheduled with no date still says it was scheduled", () => {
    const broadcast = {
      id: "b",
      name: "B",
      from: "a@example.com",
      subject: "s",
      replyTo: null,
      previewText: null,
      html: "<p>x</p>",
      text: null,
      status: "scheduled",
      segmentId: null,
      topicId: null,
      scheduledAt: null,
    } as SourceBroadcast;
    expect(broadcastCreateInput(broadcast, { segmentId: null, topicId: null }).notes).toEqual([
      "scheduled on Resend; imported as a draft — schedule it again",
    ]);
  });
});

describe("describePlanDiff", () => {
  const item = (over: Partial<PlanItem>): PlanItem =>
    ({ resource: "topics", action: "create", key: "T", ...over }) as PlanItem;
  const plan = (items: PlanItem[]) => ({ items }) as never;

  it("says the details differ when only a detail does, and shows the counts when they differ", () => {
    expect(describePlanDiff(plan([item({ detail: "a" })]), plan([item({ detail: "b" })]))).toEqual([
      "topics/T: create → create (details differ)",
    ]);
    expect(describePlanDiff(plan([item({ count: 2 })]), plan([item({ count: 5 })]))).toEqual([
      "topics/T: create → create, 2 → 5",
    ]);
    expect(
      describePlanDiff(plan([item({ action: "create" })]), plan([item({ action: "unchanged" })])),
    ).toEqual(["topics/T: create → unchanged"]);
  });
});
