// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import { codexAppServerArgs } from "./codexLaunchArgs.ts";
import { resolveCodexProjectProfileArgs } from "./codexProjectProfiles.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture() {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-project-profile-"));
  const home = NodePath.join(base, "home");
  const app = NodePath.join(base, "native app");
  const web = NodePath.join(base, "web");
  for (const directory of [home, NodePath.join(app, ".git"), NodePath.join(web, ".git")]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }
  const config = NodePath.join(home, "t3-project-profiles.json");
  const project = { root: app, profile: "lean-ios" };
  const registry = {
    projects: [project],
    profiles: {
      "lean-ios": {
        instructions: 'Keep selected model.\nQuote: "hello"',
        skills: [{ name: "hallmark", enabled: false }],
      },
    },
  };
  const write = () => NodeFS.writeFileSync(config, encodeJson(registry));
  const resolve = (cwd: string) =>
    resolveCodexProjectProfileArgs({ cwd, environment: { CODEX_HOME: home } });
  return { base, home, app, web, config, project, registry, write, resolve };
}

const withFixture = <A, E>(
  run: (
    f: ReturnType<typeof fixture>,
  ) => Effect.Effect<A, E, import("effect/FileSystem").FileSystem>,
) =>
  Effect.acquireUseRelease(Effect.sync(fixture), run, (f) =>
    Effect.sync(() => NodeFS.rmSync(f.base, { recursive: true, force: true })),
  ).pipe(Effect.provide(NodeServices.layer));

describe("Codex project profiles", () => {
  it.effect("does nothing without a registry and isolates an unmapped web repository", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        NodeAssert.deepEqual(yield* f.resolve(f.app), []);
        f.write();
        NodeAssert.deepEqual(yield* f.resolve(f.web), []);
        const args = yield* f.resolve(f.app);
        NodeAssert.deepEqual(args, [
          "-c",
          `developer_instructions=${encodeJson(f.registry.profiles["lean-ios"].instructions)}`,
          "-c",
          'skills.config=[{name="hallmark",enabled=false}]',
        ]);
        const command = codexAppServerArgs("-c skills.config=[] --strict-config", args);
        NodeAssert.ok(
          command.indexOf("skills.config=[]") >
            command.indexOf('skills.config=[{name="hallmark",enabled=false}]'),
        );
        NodeAssert.ok(!command.some((arg) => arg.startsWith("model=")));
      }),
    ),
  );

  it.effect("inherits selection in linked worktrees, nested folders, and symlink aliases", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        f.write();
        const worktree = NodePath.join(f.base, "linked");
        const gitDirectory = NodePath.join(f.app, ".git/worktrees/linked");
        NodeFS.mkdirSync(gitDirectory, { recursive: true });
        NodeFS.mkdirSync(NodePath.join(worktree, "Sources"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
        NodeFS.writeFileSync(NodePath.join(gitDirectory, "commondir"), "../..\n");
        const alias = NodePath.join(f.base, "alias");
        NodeFS.symlinkSync(worktree, alias, "junction");
        NodeAssert.deepEqual(
          yield* f.resolve(NodePath.join(alias, "Sources")),
          yield* f.resolve(f.app),
        );
      }),
    ),
  );

  it.effect("keeps separate Codex homes isolated", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        f.write();
        const other = NodePath.join(f.base, "other-home");
        NodeFS.mkdirSync(other);
        NodeAssert.deepEqual(
          yield* resolveCodexProjectProfileArgs({
            cwd: f.app,
            homePath: other,
            environment: { CODEX_HOME: f.home },
          }),
          [],
        );
      }),
    ),
  );

  it.effect("reports broken registries and unknown profile names", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        NodeFS.writeFileSync(f.config, "{broken");
        NodeAssert.ok(Exit.isFailure(yield* Effect.exit(f.resolve(f.app))));
        f.project.profile = "missing";
        f.write();
        NodeAssert.ok(Exit.isFailure(yield* Effect.exit(f.resolve(f.app))));
        f.project.profile = "toString";
        f.write();
        NodeAssert.equal((yield* Effect.flip(f.resolve(f.app)))._tag, "ProjectProfileError");
        NodeFS.writeFileSync(
          f.config,
          encodeJson({
            ...f.registry,
            profiles: {
              "lean-ios": { ...f.registry.profiles["lean-ios"], approval_policy: "never" },
            },
          }),
        );
        NodeAssert.ok(Exit.isFailure(yield* Effect.exit(f.resolve(f.app))));
      }),
    ),
  );
  it.effect("rejects contradictory mappings for aliases of one repository", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const alias = NodePath.join(f.base, "same-repository");
        NodeFS.symlinkSync(f.app, alias, "junction");
        f.registry.projects.push({ root: alias, profile: "different" });
        f.write();
        NodeAssert.equal((yield* Effect.flip(f.resolve(f.app)))._tag, "ProjectProfileError");
      }),
    ),
  );

  it.effect("does not let dangling Git metadata block mapped or unrelated sessions", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const broken = NodePath.join(f.base, "stale-worktree");
        NodeFS.mkdirSync(broken);
        NodeFS.writeFileSync(NodePath.join(broken, ".git"), "gitdir: missing-directory\n");
        f.registry.projects.push({ root: broken, profile: "lean-ios" });
        f.registry.projects.push({
          root: NodePath.join(f.base, "moved-away"),
          profile: "lean-ios",
        });
        f.write();
        NodeAssert.deepEqual(yield* f.resolve(f.web), []);
        NodeAssert.deepEqual(yield* f.resolve(broken), []);
        NodeAssert.ok(
          (yield* f.resolve(f.app)).includes('skills.config=[{name="hallmark",enabled=false}]'),
        );
        NodeFS.writeFileSync(NodePath.join(broken, ".git"), "invalid git reference");
        NodeAssert.deepEqual(yield* f.resolve(broken), []);
      }),
    ),
  );

  it.effect("serializes path selectors and TOML control escapes, rejecting invalid Unicode", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const profile = {
          instructions: "Control: \u007f",
          skills: [{ path: "/example/SKILL.md", enabled: false }],
        };
        NodeFS.writeFileSync(
          f.config,
          encodeJson({ ...f.registry, profiles: { "lean-ios": profile } }),
        );
        const args = yield* f.resolve(f.app);
        NodeAssert.ok(args.includes('developer_instructions="Control: \\u007F"'));
        NodeAssert.ok(args.includes('skills.config=[{path="/example/SKILL.md",enabled=false}]'));
        profile.instructions = "\ud800";
        NodeFS.writeFileSync(
          f.config,
          encodeJson({ ...f.registry, profiles: { "lean-ios": profile } }),
        );
        NodeAssert.ok(Exit.isFailure(yield* Effect.exit(f.resolve(f.app))));
        f.project.root = "relative-root";
        f.write();
        NodeAssert.equal((yield* Effect.flip(f.resolve(f.app)))._tag, "ProjectProfileError");
      }),
    ),
  );
});
