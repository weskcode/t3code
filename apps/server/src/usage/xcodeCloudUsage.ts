import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import type { XcodeCloudUsage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Minutes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const AscSummary = Schema.Struct({
  plan: Schema.Struct({
    used: Minutes,
    available: Minutes,
    total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    reset_date_time: Schema.String,
  }),
});

const decodeAscSummary = Schema.decodeUnknownSync(AscSummary);

export function parseXcodeCloudUsage(stdout: string, checkedAt: string): XcodeCloudUsage {
  const { plan } = decodeAscSummary(JSON.parse(stdout));
  if (!Number.isFinite(Date.parse(plan.reset_date_time))) {
    throw new Error("Invalid Xcode Cloud reset date");
  }
  return {
    kind: "available",
    usedMinutes: plan.used,
    availableMinutes: plan.available,
    totalMinutes: plan.total,
    resetsAt: plan.reset_date_time,
    checkedAt,
  };
}

export async function readAscSummary({
  platform,
  environment,
}: {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<string> {
  let binary = "asc";
  if (platform === "darwin") {
    for (const candidate of ["/opt/homebrew/bin/asc", "/usr/local/bin/asc"]) {
      try {
        await NodeFSP.access(candidate);
        binary = candidate;
        break;
      } catch {
        // Desktop launches may not inherit Homebrew's PATH.
      }
    }
  }
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      binary,
      ["web", "xcode-cloud", "usage", "summary", "--output", "json"],
      { timeout: 15_000, maxBuffer: 256 * 1024, env: { ...environment, CI: "1" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end();
  });
}

export function createXcodeCloudUsageReader(
  read: () => Promise<string>,
  now: () => number = Date.now,
) {
  let pending: Promise<XcodeCloudUsage> | undefined;
  return (): Promise<XcodeCloudUsage> => {
    if (pending) return pending;
    pending = (async (): Promise<XcodeCloudUsage> => {
      let stdout: string;
      try {
        stdout = await read();
      } catch (error) {
        return {
          kind: "unavailable",
          reason:
            error instanceof Error && "code" in error && error.code === "ENOENT"
              ? "cliMissing"
              : "sessionUnavailable",
        };
      }
      try {
        return parseXcodeCloudUsage(stdout, new Date(now()).toISOString());
      } catch {
        return { kind: "unavailable", reason: "invalidResponse" };
      }
    })().then((value) => {
      pending = undefined;
      return value;
    });
    return pending;
  };
}
