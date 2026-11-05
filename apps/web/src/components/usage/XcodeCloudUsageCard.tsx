import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { CloudIcon } from "lucide-react";
import { formatDuration } from "@t3tools/shared/usageLimits";

const unavailableMessages = {
  cliMissing: "Install ASC CLI on this device to read Xcode Cloud usage.",
  sessionUnavailable:
    "Could not read usage. Check the Apple web session with ASC CLI on this device, then refresh.",
  invalidResponse: "ASC CLI returned an unrecognized usage response. Check for an ASC CLI update.",
};

function hoursAndMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function XcodeCloudUsageCard({
  environmentId,
  environmentLabel,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly now: number;
}) {
  const query = serverEnvironment.xcodeCloudUsage({ environmentId, input: {} });
  const result = useAtomValue(query);
  const usage = Option.getOrNull(AsyncResult.value(result));
  const error =
    result._tag === "Failure"
      ? "This device could not report Xcode Cloud usage. Its server may need an update."
      : usage?.kind === "unavailable"
        ? unavailableMessages[usage.reason]
        : null;
  const available = usage?.kind === "available" ? usage : null;
  const remaining = available
    ? Math.min(100, Math.round((available.availableMinutes / available.totalMinutes) * 100))
    : 0;

  return (
    <section className="flex flex-col gap-3" aria-label={`Xcode Cloud on ${environmentLabel}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <CloudIcon className="size-4 shrink-0" aria-hidden />
          Xcode Cloud
          <span className="truncate text-xs font-normal text-muted-foreground">
            {environmentLabel}
          </span>
        </h2>
        <Button
          size="xs"
          variant="ghost"
          disabled={result.waiting}
          aria-busy={result.waiting}
          onClick={() => appAtomRegistry.refresh(query)}
        >
          {result.waiting ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <div
        className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 md:grid-cols-[11rem_minmax(0,1fr)]"
        aria-live="polite"
      >
        {available ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">Monthly compute</span>
              <span className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold text-foreground tabular-nums">
                  {remaining}%
                </span>
                <span className="text-sm text-muted-foreground">left</span>
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {hoursAndMinutes(available.availableMinutes)} remaining
              </span>
            </div>
            <div className="min-w-0 space-y-2">
              <div
                role="progressbar"
                aria-label="Xcode Cloud compute allowance remaining"
                aria-valuenow={available.availableMinutes}
                aria-valuemin={0}
                aria-valuemax={Math.max(available.totalMinutes, available.availableMinutes)}
                aria-valuetext={`${hoursAndMinutes(available.availableMinutes)} remaining of ${hoursAndMinutes(available.totalMinutes)}`}
                className="relative h-7 overflow-hidden rounded-md bg-muted"
              >
                <div
                  className="absolute inset-y-0 left-0 bg-foreground/50"
                  style={{ width: `${remaining}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                {hoursAndMinutes(available.usedMinutes)} used of{" "}
                {hoursAndMinutes(available.totalMinutes)}
                {" · "}Resets in {formatDuration(Math.max(0, Date.parse(available.resetsAt) - now))}
              </p>
              <p className="text-xs text-muted-foreground">
                Resets {new Date(available.resetsAt).toLocaleString()}
                {" · "}Updated {new Date(available.checkedAt).toLocaleTimeString()}
              </p>
            </div>
          </>
        ) : null}
        {error ? (
          <p className="col-span-full text-sm text-muted-foreground">{error}</p>
        ) : usage === null ? (
          <p className="col-span-full text-sm text-muted-foreground">Loading Xcode Cloud usage…</p>
        ) : null}
      </div>
    </section>
  );
}
