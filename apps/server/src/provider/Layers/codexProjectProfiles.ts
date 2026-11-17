// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

const unicode = Schema.isPattern(/^[^\uD800-\uDFFF]*$/u);
const Skill = Schema.Union([
  Schema.Struct({ name: Schema.NonEmptyString.check(unicode), enabled: Schema.Boolean }),
  Schema.Struct({ path: Schema.NonEmptyString.check(unicode), enabled: Schema.Boolean }),
]);
const Registry = Schema.Struct({
  profiles: Schema.Record(
    Schema.String,
    Schema.Struct({
      instructions: Schema.String.check(unicode),
      skills: Schema.Array(Skill),
    }),
  ),
  projects: Schema.Array(
    Schema.Struct({ root: Schema.NonEmptyString, profile: Schema.NonEmptyString }),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const decodeRegistry = Schema.decodeUnknownEffect(Schema.fromJsonString(Registry));
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const quoteString = (value: string) => encodeString(value).replaceAll("\u007f", "\\u007F");

class ProjectProfileError extends Schema.TaggedError<ProjectProfileError>()("ProjectProfileError", {
  message: Schema.String,
}) {}

const readOptional = Effect.fn("codexProjectProfiles.readOptional")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs
    .stat(path)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
  if (info === undefined) return undefined;
  if (info.type !== "File")
    return yield* new ProjectProfileError({ message: `Expected a regular file at ${path}` });
  return yield* fs
    .readFileString(path)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
});

const repositoryIdentity = Effect.fn("codexProjectProfiles.repositoryIdentity")(
  function* (cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    let directory = NodePath.resolve(cwd);
    while (true) {
      const dotGit = NodePath.join(directory, ".git");
      const info = yield* fs
        .stat(dotGit)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
      if (info !== undefined) {
        let gitDirectory = dotGit;
        if (info.type !== "Directory") {
          if (info.type !== "File") return undefined;
          const contents = yield* fs.readFileString(dotGit);
          const gitPath = /^gitdir:\s*(.+)\s*$/u.exec(contents.trim())?.[1];
          if (!gitPath)
            return yield* new ProjectProfileError({
              message: `Invalid Git directory reference in ${dotGit}`,
            });
          gitDirectory = NodePath.resolve(directory, gitPath);
        }
        const common = yield* readOptional(NodePath.join(gitDirectory, "commondir"));
        return yield* fs.realPath(NodePath.resolve(gitDirectory, common?.trim() || "."));
      }
      const parent = NodePath.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  },
  (effect, cwd) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Skipping unreadable Codex project Git identity", { cwd, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    ),
);

/** User-owned mappings select profiles; repository files cannot select a user profile. */
export const resolveCodexProjectProfileArgs = Effect.fn("resolveCodexProjectProfileArgs")(
  function* (input: {
    readonly cwd: string;
    readonly homePath?: string | undefined;
    readonly environment?: NodeJS.ProcessEnv | undefined;
  }) {
    const home = expandHomePath(
      input.homePath ||
        input.environment?.CODEX_HOME ||
        (input.environment === undefined ? process.env.CODEX_HOME : undefined) ||
        "~/.codex",
    );
    const contents = yield* readOptional(NodePath.join(home, "t3-project-profiles.json"));
    if (contents === undefined) return [];
    const registry = yield* decodeRegistry(contents);
    const identity = yield* repositoryIdentity(input.cwd);
    if (identity === undefined) return [];
    let selected: string | undefined;
    for (const project of registry.projects) {
      if (!NodePath.isAbsolute(project.root)) {
        return yield* new ProjectProfileError({
          message: "Project profile roots must be absolute paths",
        });
      }
      const root = project.root;
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs
        .exists(root)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Skipping inaccessible Codex profile root", { root, cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
      if (!exists) continue;
      if ((yield* repositoryIdentity(root)) !== identity) continue;
      if (selected !== undefined && selected !== project.profile) {
        return yield* new ProjectProfileError({
          message: "Conflicting profiles configured for the same Git repository",
        });
      }
      selected = project.profile;
    }
    if (selected === undefined) return [];
    const profile = Object.hasOwn(registry.profiles, selected)
      ? registry.profiles[selected]
      : undefined;
    if (!profile)
      return yield* new ProjectProfileError({
        message: `Unknown Codex project profile: ${selected}`,
      });
    const skills = profile.skills
      .map((skill) => {
        const selector =
          "name" in skill ? `name=${quoteString(skill.name)}` : `path=${quoteString(skill.path)}`;
        return `{${selector},enabled=${skill.enabled}}`;
      })
      .join(",");
    return [
      "-c",
      `developer_instructions=${quoteString(profile.instructions)}`,
      "-c",
      `skills.config=[${skills}]`,
    ];
  },
  Effect.provide(NodeFileSystem.layer),
);
