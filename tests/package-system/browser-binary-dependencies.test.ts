import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const registryRoot = join(repoRoot, "packages", "registry");
const browserRoot = join(repoRoot, "apps", "browser-demos");

type ProgramOutputOwner = {
  packageName: string;
  packageVersion: string;
  hasBuildToml: boolean;
};

const localOnlyBrowserImports = new Set([
  "programs/wasm32/nginx-vfs.vfs.zst",
  "programs/wasm32/nginx-php-vfs.vfs.zst",
]);

const registryPackagesWithoutBuildToml = new Set([
  "kernel-test-programs",
  "pcre2-source",
  "sqlite-cli",
]);

function registryPackageDirs(): string[] {
  return readdirSync(registryRoot)
    .map((name) => join(registryRoot, name))
    .filter((path) => statSync(path).isDirectory())
    .filter((path) => existsSync(join(path, "package.toml")));
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function firstTomlString(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
  return match?.[1] ?? null;
}

function parseArches(text: string): string[] {
  const match = text.match(/^\s*arches\s*=\s*\[([\s\S]*?)\]/m);
  if (!match) return ["wasm32"];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((arch) => arch[1]);
}

function parseDependsOn(text: string): string[] {
  const match = text.match(/^\s*depends_on\s*=\s*\[([\s\S]*?)\]/m);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((dep) => dep[1]);
}

function parseProgramOutputs(text: string): { name: string; wasm: string }[] {
  return text
    .split(/^\s*\[\[outputs\]\]\s*$/m)
    .slice(1)
    .map((block) => ({
      name: firstTomlString(block, "name"),
      wasm: firstTomlString(block, "wasm"),
    }))
    .filter((output): output is { name: string; wasm: string } =>
      Boolean(output.name && output.wasm),
    );
}

function outputExtension(wasmPath: string): string {
  const basename = wasmPath.split("/").pop() ?? wasmPath;
  const dot = basename.indexOf(".");
  return dot === -1 ? "" : basename.slice(dot);
}

function packageOutputOwners(): Map<string, ProgramOutputOwner> {
  const owners = new Map<string, ProgramOutputOwner>();

  for (const packageDir of registryPackageDirs()) {
    const manifest = readFileSync(join(packageDir, "package.toml"), "utf8");
    if (firstTomlString(manifest, "kind") !== "program") continue;

    const packageName = firstTomlString(manifest, "name");
    const packageVersion = firstTomlString(manifest, "version");
    if (!packageName || !packageVersion) continue;

    const outputs = parseProgramOutputs(manifest);
    if (outputs.length === 0) continue;

    const hasBuildToml = existsSync(join(packageDir, "build.toml"));
    for (const arch of parseArches(manifest)) {
      for (const output of outputs) {
        const dest =
          outputs.length > 1
            ? `${packageName}/${output.name}${outputExtension(output.wasm)}`
            : `${output.name}${outputExtension(output.wasm)}`;
        const rel = `programs/${arch}/${dest}`;
        owners.set(rel, { packageName, packageVersion, hasBuildToml });
      }
    }
  }

  return owners;
}

function normalizeBinariesRel(rel: string): string {
  if (!rel.startsWith("programs/")) return rel;
  const tail = rel.slice("programs/".length);
  const first = tail.split("/", 1)[0];
  if (first === "wasm32" || first === "wasm64") return rel;
  return `programs/wasm32/${tail}`;
}

function browserBinariesImports(): string[] {
  const imports = new Set<string>();
  const patterns = [
    /\bfrom\s+["']@binaries\/([^"'?]+)(?:\?[^"']*)?["']/g,
    /\bimport\(\s*["']@binaries\/([^"'?]+)(?:\?[^"']*)?["']\s*\)/g,
  ];

  for (const file of walkFiles(browserRoot)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        imports.add(normalizeBinariesRel(match[1]));
      }
    }
  }

  return [...imports].sort();
}

describe("browser binary dependencies", () => {
  it("requires a build.toml sidecar for every fetchable registry package", () => {
    const missingBuildToml = registryPackageDirs()
      .filter((packageDir) => {
        const manifest = readFileSync(join(packageDir, "package.toml"), "utf8");
        const packageName = firstTomlString(manifest, "name");
        if (packageName && registryPackagesWithoutBuildToml.has(packageName)) {
          return false;
        }
        return !existsSync(join(packageDir, "build.toml"));
      })
      .map((packageDir) => relative(repoRoot, packageDir));

    expect(missingBuildToml).toEqual([]);
  });

  it("backs every browser @binaries import with a fetchable package output", () => {
    const owners = packageOutputOwners();
    const missingOwners: string[] = [];
    const unfetchableOwners: string[] = [];

    for (const rel of browserBinariesImports()) {
      if (localOnlyBrowserImports.has(rel)) continue;

      const owner = owners.get(rel);
      if (!owner) {
        missingOwners.push(rel);
      } else if (!owner.hasBuildToml) {
        unfetchableOwners.push(`${rel} (${owner.packageName})`);
      }
    }

    expect(missingOwners).toEqual([]);
    expect(unfetchableOwners).toEqual([]);
  });

  it("binds Vim consumers to the exact package artifacts they use", () => {
    const owners = packageOutputOwners();
    const vimBundle = owners.get("programs/wasm32/vim.zip");
    expect(vimBundle).toBeDefined();

    const shellManifest = readFileSync(
      join(registryRoot, "shell", "package.toml"),
      "utf8",
    );
    expect(parseDependsOn(shellManifest)).toContain(
      `${vimBundle!.packageName}@${vimBundle!.packageVersion}`,
    );

    const vimPackageManifest = readFileSync(
      join(registryRoot, "vim", "package.toml"),
      "utf8",
    );
    const vimVersion = firstTomlString(vimPackageManifest, "version");
    expect(vimVersion).not.toBeNull();

    const vimBundleManifest = readFileSync(
      join(registryRoot, vimBundle!.packageName, "package.toml"),
      "utf8",
    );
    expect(parseDependsOn(vimBundleManifest)).toContain(
      `vim@${vimVersion}`,
    );

    const ncursesManifest = readFileSync(
      join(registryRoot, "ncurses", "package.toml"),
      "utf8",
    );
    const ncursesVersion = firstTomlString(ncursesManifest, "version");
    expect(ncursesVersion).not.toBeNull();

    expect(parseDependsOn(vimPackageManifest)).toContain(
      `ncurses@${ncursesVersion}`,
    );
  });
});
