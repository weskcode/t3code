# Build T3 Code with the Xcode Cloud card

The customization branch is `feature/xcode-cloud-current` in
`weskcode/t3code`. It adds a read-only Xcode Cloud allowance card to **Usage →
Limits**. Keep this branch as feature commits on the base recorded in
`scripts/build-xcode-cloud.mjs`; do not merge upstream into it. The build
command replays those commits onto the release you choose in a separate
worktree. The fork's `main` branch stays unchanged.

## Prepare a build

Use an Apple Silicon Mac with the repository's Node and Vite+ prerequisites,
Rust/Cargo, and enough free space for dependencies and desktop packaging.
Keep GitHub Actions disabled on this fork. The command runs locally and never
pushes, publishes, installs, or deletes a worktree.

From a clean customization checkout, choose an exact upstream commit or release
tag and its matching release version. For the initial supported nightly:

```sh
node scripts/build-xcode-cloud.mjs \
  --upstream 935818e422f9b58c46e14d70f4ef386fa3575105 \
  --version 0.1.8-nightly.20261105.4205
```

The command creates a sibling worktree, applies the feature commits, installs
the locked dependencies, runs `check:changed`, and packages an unsigned ARM64
macOS app. It verifies that the ZIP contains no `app-update.yml` update feed.
The artifact and `custom-build.json` record the upstream SHA, customization
SHA, resulting build SHA, and release version. The upstream version is kept;
the custom commit identifies your changes.

Add `--prepare-only` to stop after applying the commits. Repeating the same
command reuses that checkout only while its recorded commit and clean state
still match. A completed build needs a new empty `--output` directory to run
again. Conflicts stop the command and leave the checkout available for review;
resolve them deliberately rather than bypassing checks.

## Verify before installation

Test the packaged app with an isolated T3 home and Electron profile before
using it with live data. Check that **Usage → Limits** shows the Xcode Cloud
card, both Refresh controls complete, and updates are disabled. Test the ASC
session failure path too. Do not run the official and custom apps against the
same live database concurrently.

Unsigned local builds are not equivalent to the signed official app. In
particular, macOS passkeys require a signed, provisioned app. Decide whether
the local build meets your needs before replacing the installed app. Signing,
installation, and a restart require separate approval.

The card uses `asc web xcode-cloud usage summary --output json` on the selected
environment. Install ASC CLI and authenticate its Apple web session there.
No Apple credentials belong in Git or build metadata. An expired session
requires reauthentication through ASC CLI; Apple API changes may require a
reader update independently of T3 updates.

## Update later

Run the command again with a chosen newer upstream release and its version.
Keep the last working app until the new package passes isolated verification.
Official T3 updates do not contain this customization. Keep custom builds
without an update feed until you explicitly choose a different update policy.
