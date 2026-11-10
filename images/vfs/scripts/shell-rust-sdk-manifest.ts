import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { KandeloImageFs } from "../lib/kandelo-image-fs";
import { SHELL_LAZY_BINARY_SPECS, shellLazySpecDependency } from "../lib/init/shell-binaries";
import { SHELL_LAZY_ARCHIVE_SPECS, type ShellLazyArchiveResolver } from "./shell-lazy-archives";
import { ensureDirRecursive, writeVfsFile } from "./vfs-image-helpers";

/** Match the standalone SDK's real component identity in every shell family. */
export function registerShellRustSdkManifest(
  fs: KandeloImageFs,
  resolveArtifact: ShellLazyArchiveResolver,
  includes: (dependency: string) => boolean = () => true,
): void {
  const schema: { required: string[]; optional: string[] } = JSON.parse(readFileSync(
    new URL("../../../sdk/guest-rust/src/sdk-components.json", import.meta.url), "utf8",
  ));
  const allowed = new Set([...schema.required, ...schema.optional]);
  const components = new Map<string, string>();
  for (const spec of SHELL_LAZY_BINARY_SPECS) {
    const dependency = shellLazySpecDependency(spec);
    if (allowed.has(spec.id) && includes(dependency)) {
      components.set(spec.id, resolveArtifact(spec.resolverPath, dependency));
    }
  }
  for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
    if (allowed.has(spec.id) && includes(spec.dependency)) {
      components.set(spec.id, resolveArtifact(spec.resolverPath, spec.dependency));
    }
  }
  // A developer may select a single component in a partial image. Publish an
  // SDK identity only when its complete minimum toolchain is actually present.
  if (!schema.required.every(name => components.has(name))) return;
  const args = [...components].flatMap(([name, path]) => ["--component", name, path]);
  const manifest = execFileSync("python3", [
    fileURLToPath(new URL("./rust-sdk-manifest.py", import.meta.url)), ...args,
  ], { encoding: "utf8" });
  ensureDirRecursive(fs, "/usr/share/kandelo/rust-sdk");
  writeVfsFile(fs, "/usr/share/kandelo/rust-sdk/manifest.json", manifest, 0o644);
}
