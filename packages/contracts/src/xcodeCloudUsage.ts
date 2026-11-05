import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

export const XcodeCloudUsage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"),
    usedMinutes: NonNegativeInt,
    availableMinutes: NonNegativeInt,
    totalMinutes: PositiveInt,
    resetsAt: Schema.String,
    checkedAt: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals(["cliMissing", "sessionUnavailable", "invalidResponse"]),
  }),
]);
export type XcodeCloudUsage = typeof XcodeCloudUsage.Type;
