import { describe, expect, it } from "vite-plus/test";

import { createXcodeCloudUsageReader, parseXcodeCloudUsage } from "./xcodeCloudUsage.ts";

const summary = JSON.stringify({
  plan: {
    used: 516,
    available: 984,
    total: 1500,
    reset_date_time: "2026-11-11T16:38:09Z",
  },
  links: { manage: "https://developer.apple.com/xcode-cloud/" },
});
const checkedAt = "2026-11-05T00:00:00.000Z";

describe("Xcode Cloud usage", () => {
  it("reads the team's remaining allowance and actual billing reset from ASC JSON", () => {
    expect(parseXcodeCloudUsage(summary, checkedAt)).toEqual({
      kind: "available",
      usedMinutes: 516,
      availableMinutes: 984,
      totalMinutes: 1500,
      resetsAt: "2026-11-11T16:38:09Z",
      checkedAt,
    });
  });

  it.each([
    "not json",
    "{}",
    summary.replace('"total":1500', '"total":0'),
    summary.replace('"available":984', '"available":-1'),
    summary.replace("2026-11-11T16:38:09Z", "invalid-date"),
  ])("reports malformed CLI output without exposing it", async (output) => {
    const read = createXcodeCloudUsageReader(async () => output);
    expect(await read()).toEqual({ kind: "unavailable", reason: "invalidResponse" });
  });

  it("distinguishes a missing CLI from a session or command failure", async () => {
    const missing = createXcodeCloudUsageReader(async () => {
      throw Object.assign(new Error("private command details"), { code: "ENOENT" });
    });
    const session = createXcodeCloudUsageReader(async () => {
      throw new Error("private account details");
    });
    expect(await missing()).toEqual({ kind: "unavailable", reason: "cliMissing" });
    expect(await session()).toEqual({ kind: "unavailable", reason: "sessionUnavailable" });
  });

  it("coalesces concurrent requests and fetches fresh allowance on the next read", async () => {
    let calls = 0;
    const time = Date.parse(checkedAt);
    const read = createXcodeCloudUsageReader(
      async () => {
        calls += 1;
        return calls === 1 ? summary : summary.replace('"available":984', '"available":900');
      },
      () => time,
    );
    const [first, concurrent] = await Promise.all([read(), read()]);
    expect(concurrent).toEqual(first);
    expect(calls).toBe(1);
    expect(await read()).toMatchObject({ kind: "available", availableMinutes: 900 });
    expect(calls).toBe(2);
  });

  it("recovers immediately after a failed read", async () => {
    let sessionReady = false;
    const read = createXcodeCloudUsageReader(
      async () => {
        if (!sessionReady) throw new Error("expired session");
        return summary;
      },
      () => Date.parse(checkedAt),
    );
    expect(await read()).toEqual({ kind: "unavailable", reason: "sessionUnavailable" });
    sessionReady = true;
    expect(await read()).toMatchObject({ kind: "available", availableMinutes: 984 });
  });
});
