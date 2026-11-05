import type { XcodeCloudUsage } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const probe = Effect.fn("XcodeCloudUsage.read")(
    function* () {
      let binary = "asc";
      if (platform === "darwin") {
        for (const candidate of ["/opt/homebrew/bin/asc", "/usr/local/bin/asc"]) {
          if (yield* fs.exists(candidate)) {
            binary = candidate;
            break;
          }
        }
      }
      const child = yield* spawner.spawn(
        ChildProcess.make(binary, ["web", "xcode-cloud", "usage", "summary", "--output", "json"], {
          env: { ...environment, CI: "1" },
          extendEnv: false,
          shell: false,
          stdin: "ignore",
        }),
      );
      const [stdout, , code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: 256 * 1024 }),
          Stream.runDrain(child.stderr),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return { kind: "unavailable", reason: "sessionUnavailable" } satisfies XcodeCloudUsage;
      if (stdout.truncated || stdout.invalidUtf8) {
        return { kind: "unavailable", reason: "invalidResponse" } satisfies XcodeCloudUsage;
      }
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* Effect.try({
        try: () => parseXcodeCloudUsage(stdout.text, checkedAt),
        catch: (): "invalidResponse" => "invalidResponse",
      }).pipe(
        Effect.orElseSucceed((): XcodeCloudUsage => ({
          kind: "unavailable",
          reason: "invalidResponse",
        })),
      );
    },
    Effect.scoped,
    Effect.timeout("15 seconds"),
    Effect.catch((error) =>
      Effect.succeed({
        kind: "unavailable",
        reason:
          PlatformError.isPlatformError(error) && error.reason._tag === "NotFound"
            ? "cliMissing"
            : "sessionUnavailable",
      } satisfies XcodeCloudUsage),
    ),
  );
  // Share concurrent reads; an explicit refresh must never reuse a completed result.
  return yield* Effect.cachedWithTTL(probe(), 0);
});
