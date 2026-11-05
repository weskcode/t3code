import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "@effect/vitest";

import { make, parseXcodeCloudUsage } from "./xcodeCloudUsage.ts";

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

function testReader(output: () => { readonly stdout: string; readonly code: number }) {
  const spawner = ChildProcessSpawner.make(() =>
    Effect.promise(async () => {
      const value = output();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_099),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(value.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.succeed(new TextEncoder().encode(value.stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return make.pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provide(NodeServices.layer),
  );
}

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

  it.effect.each([
    "not json",
    "{}",
    summary.replace('"total":1500', '"total":0'),
    summary.replace('"available":984', '"available":-1'),
    summary.replace("2026-11-11T16:38:09Z", "invalid-date"),
    "x".repeat(256 * 1024 + 1),
  ])("reports malformed CLI output without exposing it", (stdout) =>
    Effect.gen(function* () {
      const read = yield* testReader(() => ({ stdout, code: 0 }));
      expect(yield* read).toEqual({
        kind: "unavailable",
        reason: "invalidResponse",
      });
    }),
  );

  it.effect("distinguishes a missing CLI from a failed command", () =>
    Effect.gen(function* () {
      const missing = yield* make.pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
              }),
            ),
          ),
        ),
        Effect.provide(NodeServices.layer),
      );
      const failed = yield* testReader(() => ({ stdout: "private details", code: 1 }));
      expect(yield* missing).toEqual({ kind: "unavailable", reason: "cliMissing" });
      expect(yield* failed).toEqual({
        kind: "unavailable",
        reason: "sessionUnavailable",
      });
    }),
  );

  it.effect("coalesces concurrent reads and fetches fresh allowance on the next read", () =>
    Effect.gen(function* () {
      let calls = 0;
      const read = yield* testReader(() => {
        calls += 1;
        return {
          stdout: calls === 1 ? summary : summary.replace('"available":984', '"available":900'),
          code: 0,
        };
      });
      const [first, second] = yield* Effect.all([read, read], { concurrency: "unbounded" });
      expect(first).toEqual(second);
      expect(calls).toBe(1);
      expect(yield* read).toMatchObject({
        kind: "available",
        availableMinutes: 900,
      });
      expect(calls).toBe(2);
    }),
  );

  it.effect("recovers immediately after a failed read", () =>
    Effect.gen(function* () {
      let ready = false;
      const read = yield* testReader(() => ({ stdout: summary, code: ready ? 0 : 1 }));
      expect(yield* read).toEqual({
        kind: "unavailable",
        reason: "sessionUnavailable",
      });
      ready = true;
      expect(yield* read).toMatchObject({
        kind: "available",
        availableMinutes: 984,
      });
    }),
  );
});
