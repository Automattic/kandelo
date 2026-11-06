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
