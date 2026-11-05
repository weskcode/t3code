import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const { values } = NodeUtil.parseArgs({
  options: {
    upstream: { type: "string" },
    version: { type: "string" },
    output: { type: "string" },
    "prepare-only": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stdout.write(
    "Usage: node scripts/build-xcode-cloud.mjs --upstream <40-character SHA or v-version tag> --version <upstream version> [--output <directory>] [--prepare-only]\n",
  );
  process.exit(0);
}

function run(command, args, cwd = root, env = process.env, capture = false) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed. ${result.stderr ?? ""}`);
  }
  return result.stdout?.trim() ?? "";
}

try {
  const upstream = values.upstream;
  const version = values.version;
  if (!upstream || !/^(?:[a-f0-9]{40}|v\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(upstream)) {
    throw new Error(
      "Choose an exact upstream commit SHA or version tag; moving branch names are not accepted.",
    );
  }
  if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error("Pass the matching upstream release version with --version.");
  }
  if (upstream.startsWith("v") && upstream.slice(1) !== version) {
    throw new Error("The --version must match the selected upstream version tag.");
  }
  if (run("git", ["status", "--porcelain"], root, process.env, true)) {
    throw new Error("Commit or preserve the source checkout's changes before building.");
  }
  const config = {
    upstreamBase: "935818e422f9b58c46e14d70f4ef386fa3575105",
    upstreamRepository: "https://github.com/pingdotgg/t3code.git",
    sourceBranch: "feature/xcode-cloud-current",
  };
  const source = run(
    "git",
    ["rev-parse", "--verify", `${config.sourceBranch}^{commit}`],
    root,
    process.env,
    true,
  );
  run("git", ["merge-base", "--is-ancestor", config.upstreamBase, source]);
  const commits = run(
    "git",
    ["rev-list", "--reverse", `${config.upstreamBase}..${source}`],
    root,
    process.env,
    true,
  )
    .split("\n")
    .filter(Boolean);
  if (
    commits.length === 0 ||
    run(
      "git",
      ["rev-list", "--merges", `${config.upstreamBase}..${source}`],
      root,
      process.env,
      true,
    )
  ) {
    throw new Error("The customization branch must contain a linear series of feature commits.");
  }
  const upstreamRef = `refs/t3-custom-upstream/${upstream}`;
  run("git", [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    config.upstreamRepository,
    `${upstream}:${upstreamRef}`,
  ]);
  const target = run("git", ["rev-parse", `${upstreamRef}^{commit}`], root, process.env, true);
  const id = `${target.slice(0, 12)}-${source.slice(0, 12)}`;
  const checkout = NodePath.join(NodePath.dirname(root), `xcode-cloud-build-${id}`);
  const output = NodePath.resolve(values.output ?? NodePath.join(root, "release", id));
  const recordPath = NodePath.join(checkout, ".t3", "custom-build.json");
  if (NodeFS.existsSync(checkout)) {
    const record = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
    const head = run("git", ["rev-parse", "HEAD"], checkout, process.env, true);
    if (
      record.upstream !== target ||
      record.source !== source ||
      record.patched !== head ||
      run("git", ["status", "--porcelain"], checkout, process.env, true)
    ) {
      throw new Error(`Existing checkout differs from this build. Inspect it: ${checkout}`);
    }
  } else {
    run("git", ["worktree", "add", "-b", `custom/xcode-cloud-${id}`, checkout, target]);
    try {
      run("git", ["cherry-pick", ...commits], checkout);
    } catch (error) {
      throw new Error(
        `Patch application stopped. The checkout is retained for review at ${checkout}. ${error.message}`,
        { cause: error },
      );
    }
    NodeFS.mkdirSync(NodePath.dirname(recordPath), { recursive: true });
    NodeFS.writeFileSync(
      recordPath,
      JSON.stringify(
        {
          upstream: target,
          source,
          patched: run("git", ["rev-parse", "HEAD"], checkout, process.env, true),
        },
        null,
        2,
      ) + "\n",
    );
  }
  process.stdout.write(`Prepared customization checkout: ${checkout}\n`);
  if (values["prepare-only"]) process.exit(0);
  if (NodeFS.existsSync(output) && NodeFS.readdirSync(output).length > 0) {
    throw new Error(`Output directory is not empty; choose a new --output: ${output}`);
  }
  const env = {
    ...process.env,
    PATH: [
      NodePath.join(checkout, "node_modules", ".bin"),
      "/opt/homebrew/opt/rustup/bin",
      process.env.PATH,
    ]
      .filter(Boolean)
      .join(NodePath.delimiter),
    TMPDIR: NodeFS.realpathSync(process.env.TMPDIR ?? "/tmp"),
    T3CODE_DESKTOP_SIGNED: "false",
    T3CODE_DESKTOP_MOCK_UPDATES: "false",
  };
  delete env.T3CODE_DESKTOP_UPDATE_REPOSITORY;
  delete env.GITHUB_REPOSITORY;
  for (const file of [".env", ".env.local"]) {
    if (NodeFS.existsSync(NodePath.join(checkout, file)))
      throw new Error(`Review local build configuration before proceeding: ${file}`);
  }
  run("vp", ["install", "--frozen-lockfile"], checkout, env);
  run("vp", ["run", "check:changed", target, "--concurrency", "1"], checkout, env);
  run(
    "node",
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "mac",
      "--arch",
      "arm64",
      "--target",
      "zip",
      "--build-version",
      version,
      "--output-dir",
      output,
    ],
    checkout,
    env,
  );
  const archives = NodeFS.readdirSync(output).filter((file) => file.endsWith(".zip"));
  if (archives.length !== 1) throw new Error("Expected exactly one packaged app ZIP.");
  const archive = NodePath.join(output, archives[0]);
  const entries = run("unzip", ["-Z1", archive], checkout, env, true).split("\n");
  if (entries.some((entry) => entry.endsWith("/Contents/Resources/app-update.yml"))) {
    throw new Error("Packaged app contains an update feed. Do not install it.");
  }
  const record = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
  NodeFS.writeFileSync(
    NodePath.join(output, "custom-build.json"),
    JSON.stringify(
      { ...record, version, archive, automaticUpdates: false, signed: false },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Custom build ready for isolated verification: ${archive}\nNothing was installed or published.\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
