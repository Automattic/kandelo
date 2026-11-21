import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const helper = resolve(import.meta.dirname, "../../scripts/package-rust-build-env.sh");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each([
  { name: "standalone package", workspace: "", members: ["main"] },
  {
    name: "workspace with existing members and multiline exclusions",
    workspace: '[workspace]\nmembers = ["public"]\nexclude = [\n # Keep this existing glob\n "vendor/[abc]/**",\n]\nresolver = "2"\n',
    members: ["main", "public"],
  },
  {
    name: "workspace declared through an inherited package table",
    workspace: '[workspace.package]\nlicense = "MIT"\n',
    members: ["main"],
  },
])("keeps private Rust dependencies outside a $name", ({ workspace, members }) => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-rust-workspace-"));
  roots.push(root);
  const packages = [
    ["", "main"], ["public", "public"],
    [".kandelo-rust/sysroot/libc-kandelo", "private-libc"],
    [".kandelo-patched-crates/hidden", "private-patch"],
    [".kandelo-vendor/hidden", "private-vendor"],
  ];
  for (const [path, name] of packages) {
    const dir = join(root, path);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/lib.rs"), "");
    writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2024"\n`);
  }
  const manifest = join(root, "Cargo.toml");
  writeFileSync(manifest, readFileSync(manifest, "utf8") +
    '[dependencies]\nprivate-libc = { path = ".kandelo-rust/sysroot/libc-kandelo" }\n' +
    'private-patch = { path = ".kandelo-patched-crates/hidden" }\n' +
    'private-vendor = { path = ".kandelo-vendor/hidden" }\n' + workspace);
  const prepare = () => execFileSync("bash", ["-c",
    'source "$1"; kandelo_package_rust_prepare_workspace "$2"', "_", helper, root]);
  prepare();
  const first = readFileSync(manifest, "utf8");
  prepare();
  expect(readFileSync(manifest, "utf8")).toBe(first);
  if (workspace.includes("# Keep")) expect(first).toContain("# Keep this existing glob");
  // Cargo, rather than a source-text assertion, decides whether private
  // dependencies became accidental workspace members. Keep them resolved
  // as dependencies so excluding them cannot hide a missing build input.
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--offline", "--format-version", "1"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
  expect(metadata.packages.filter((pkg: any) => metadata.workspace_members.includes(pkg.id))
    .map((pkg: any) => pkg.name).sort()).toEqual(members);
  expect(metadata.packages.filter((pkg: any) => pkg.name.startsWith("private-")).map((pkg: any) => pkg.name).sort())
    .toEqual(["private-libc", "private-patch", "private-vendor"]);
});

// Each patches/<crate>-<version>.patch becomes a Cargo [patch] entry whose
// key must be unique and a valid bare TOML key, including for semver build
// metadata. Run the real helper with stubbed Cargo and sysroot steps, and
// let a TOML parser, rather than a source-text match, read the result.
it("derives bare TOML [patch] keys from crate versions", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-rust-patch-key-"));
  roots.push(root);
  const [repo, src, work, patches, bin] = ["repo", "src", "work", "patches", "bin"].map((dir) => join(root, dir));
  const entries = ["tar-0.4.45", "libgit2-sys-0.18.3+1.9.2"];
  for (const dir of [join(repo, "scripts"), join(src, "src"), work, patches, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(src, "Cargo.toml"), '[package]\nname = "main"\nversion = "0.1.0"\nedition = "2024"\n');
  writeFileSync(join(src, "src/lib.rs"), "");
  writeFileSync(join(repo, "scripts/build-rust-sysroot.sh"),
    'mkdir -p "$KANDELO_RUST_DIR/sysroot/libc-kandelo"\n' +
    'printf \'[package]\\nname = "libc"\\nversion = "0.2.999"\\n\' > "$KANDELO_RUST_DIR/sysroot/libc-kandelo/Cargo.toml"\n');
  // `cargo vendor` lays out each locked crate; other subcommands are logged.
  writeFileSync(join(bin, "cargo"), [
    "#!/usr/bin/env bash",
    'printf \'%s\\n\' "$*" >> "$STUB_CARGO_LOG"',
    'if [ "$1" = vendor ]; then',
    '  for entry in $STUB_VENDOR_ENTRIES; do mkdir -p "${@: -1}/$entry/src"; echo original > "${@: -1}/$entry/src/lib.rs"; done',
    '  printf \'[source.vendored-sources]\\ndirectory = "%s"\\n\' "${@: -1}"',
    "fi",
    "",
  ].join("\n"), { mode: 0o755 });
  for (const entry of entries) {
    writeFileSync(join(patches, `${entry}.patch`),
      "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-original\n+patched\n");
  }
  execFileSync("bash", ["-c", 'source "$1"; kandelo_package_rust_build_env "$2" "$3" "$4" "$5"',
    "_", helper, repo, src, work, patches], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_CARGO_LOG: join(work, "cargo.log"),
      STUB_VENDOR_ENTRIES: entries.join(" "),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(execFileSync("python3", ["-c",
    "import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))['patch']['crates-io']))",
    join(work, "guest-cargo-home/config.toml")], { encoding: "utf8" }));
  expect(Object.keys(parsed).sort()).toEqual(["libc", "libgit2_sys_0_18_3_1_9_2", "tar_0_4_45"]);
  expect(parsed.tar_0_4_45).toEqual({ path: join(src, ".kandelo-patched-crates/tar-0.4.45"), package: "tar" });
  expect(parsed.libgit2_sys_0_18_3_1_9_2).toEqual({
    path: join(src, ".kandelo-patched-crates/libgit2-sys-0.18.3+1.9.2"), package: "libgit2-sys",
  });
  expect(readFileSync(join(work, "cargo.log"), "utf8"))
    .toContain("update --offline -p libgit2-sys@0.18.3+1.9.2 -p tar@0.4.45");
});
