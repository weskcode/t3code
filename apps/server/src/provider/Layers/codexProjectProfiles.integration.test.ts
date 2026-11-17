// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { withCodexAppServerClient } from "./CodexProvider.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeArgs = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

it.effect(
  "sends project settings to real spawned probe and session processes with an explicit environment",
  () =>
    Effect.gen(function* () {
      const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-profile-spawn-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(base, { recursive: true, force: true })),
      );
      const home = NodePath.join(base, "home");
      const app = NodePath.join(base, "app");
      NodeFS.mkdirSync(home);
      NodeFS.mkdirSync(NodePath.join(app, ".git"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(home, "t3-project-profiles.json"),
        encodeJson({
          projects: [{ root: app, profile: "lean-ios" }],
          profiles: {
            "lean-ios": {
              instructions: "from automatic profile",
              skills: [{ name: "hallmark", enabled: false }],
            },
          },
        }),
      );
      const script = NodePath.join(base, "script.json");
      const recorded = NodePath.join(base, "argv.json");
      NodeFS.writeFileSync(script, encodeJson({ rootThreadId: "fixture-root", notifications: [] }));
      const peer = NodePath.join(base, "peer.mjs");
      const mock = NodeURL.pathToFileURL(
        NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.mjs"),
      ).href;
      NodeFS.writeFileSync(
        peer,
        `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(process.env.T3_PROFILE_ARGV, JSON.stringify(process.argv.slice(2)));\nawait import(${encodeJson(mock)});\n`,
        { mode: 0o755 },
      );
      const windows = NodePath.join(base, "peer.cmd");
      NodeFS.writeFileSync(windows, '@echo off\r\nnode "%~dp0peer.mjs" %*\r\n');
      const platform = yield* HostProcessPlatform;
      const binaryPath = platform === "win32" ? windows : peer;
      const environment = {
        ...process.env,
        CODEX_HOME: home,
        T3_CODEX_COLLAB_SCRIPT: script,
        T3_PROFILE_ARGV: recorded,
      };
      const automatic = 'skills.config=[{name="hallmark",enabled=false}]';
      yield* withCodexAppServerClient({ binaryPath, cwd: app, environment }).pipe(Effect.scoped);
      const probeArgs = yield* decodeArgs(NodeFS.readFileSync(recorded, "utf8"));
      NodeAssert.ok(probeArgs.includes(automatic));
      NodeAssert.ok(probeArgs.includes('developer_instructions="from automatic profile"'));
      yield* Effect.gen(function* () {
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("profile-runtime-fixture"),
          binaryPath,
          cwd: app,
          environment,
          runtimeMode: "approval-required",
          launchArgs: "-c skills.config=[]",
          appServerArgs: ["-c", 'mcp_servers.fixture.url="http://127.0.0.1:1"'],
        });
        yield* runtime.start();
        const sessionArgs = yield* decodeArgs(NodeFS.readFileSync(recorded, "utf8"));
        NodeAssert.ok(sessionArgs.includes(automatic));
        NodeAssert.ok(sessionArgs.indexOf("skills.config=[]") > sessionArgs.indexOf(automatic));
        NodeAssert.ok(sessionArgs.includes('mcp_servers.fixture.url="http://127.0.0.1:1"'));
        yield* runtime.close;
      }).pipe(Effect.scoped);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessPlatform, HostProcessPlatform.defaultValue()),
    ),
);
