import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const registryRoot = join(repoRoot, "packages", "registry");
const setsRoot = join(repoRoot, "packages", "sets");

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function tomlString(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
  return match?.[1] ?? null;
}

function sectionTomlString(text: string, section: string, key: string): string | null {
  const sectionStart = text.indexOf(`[${section}]`);
  if (sectionStart === -1) return null;
  const rest = text.slice(sectionStart + section.length + 2);
  const nextSection = rest.search(/^\s*\[/m);
  const body = nextSection === -1 ? rest : rest.slice(0, nextSection);
  return tomlString(body, key);
}

function tomlBool(text: string, key: string): boolean | null {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, "m"));
  return match ? match[1] === "true" : null;
}

function shellVar(text: string, name: string): string | null {
  const match = text.match(new RegExp(`^${name}="([^"]+)"`, "m"));
  return match?.[1] ?? null;
}

function setFiles(): string[] {
  return readdirSync(setsRoot)
    .filter((name) => name.endsWith(".toml"))
    .map((name) => join(setsRoot, name));
}

describe("registry helper input ownership", () => {
  it("models pcre2-source as a MariaDB-owned resource helper", () => {
    const helper = readRepo("packages/registry/mariadb/helper-inputs.toml");
    const legacy = readRepo("packages/registry/pcre2-source/package.toml");

    expect(tomlString(helper, "name")).toBe("pcre2-source");
    expect(tomlString(helper, "owner")).toBe("mariadb");
    expect(tomlString(helper, "disposition")).toBe("homebrew_resource_helper");
    expect(tomlBool(helper, "registry_identity")).toBe(false);
    expect(tomlString(helper, "version")).toBe(tomlString(legacy, "version"));
    expect(tomlString(helper, "source_url")).toBe(sectionTomlString(legacy, "source", "url"));
    expect(tomlString(helper, "sha256")).toBe(sectionTomlString(legacy, "source", "sha256"));
    expect(tomlString(helper, "license_spdx")).toBe(sectionTomlString(legacy, "license", "spdx"));
    expect(tomlString(helper, "license_url")).toBe(sectionTomlString(legacy, "license", "url"));
    expect(tomlString(helper, "dist_behavior")).toContain("MariaDB builds");
  });

  it("models npm as a node-vfs-owned resource helper with pinned dist behavior", () => {
    const helper = readRepo("packages/registry/node-vfs/helper-inputs.toml");
    const nodeVfs = readRepo("packages/registry/node-vfs/package.toml");
    const fetchNpm = readRepo("packages/registry/npm/fetch-npm.sh");

    expect(tomlString(helper, "name")).toBe("npm");
    expect(tomlString(helper, "owner")).toBe("node-vfs");
    expect(tomlString(helper, "disposition")).toBe("homebrew_resource_helper");
    expect(tomlBool(helper, "registry_identity")).toBe(false);
    expect(tomlString(helper, "version")).toBe(shellVar(fetchNpm, "NPM_VERSION"));
    expect(tomlString(helper, "source_url")).toBe(sectionTomlString(nodeVfs, "source", "url"));
    expect(tomlString(helper, "sha256")).toBe(shellVar(fetchNpm, "NPM_SHA256"));
    expect(tomlString(helper, "sha256")).toBe(sectionTomlString(nodeVfs, "source", "sha256"));
    expect(tomlString(helper, "license_spdx")).toBe(sectionTomlString(nodeVfs, "license", "spdx"));
    expect(tomlString(helper, "license_url")).toBe(sectionTomlString(nodeVfs, "license", "url"));
    expect(tomlString(helper, "dist_behavior")).toContain("packages/registry/npm/dist");
    expect(tomlString(helper, "dist_behavior")).toContain("/usr/local/lib/npm");
  });

  it("models node-compat as SpiderMonkey runtime tooling data", () => {
    const helper = readRepo("packages/registry/spidermonkey/helper-inputs.toml");
    const spidermonkeyBuild = readRepo("packages/registry/spidermonkey/build.toml");
    const spidermonkeyScript = readRepo("packages/registry/spidermonkey/build-spidermonkey.sh");

    expect(tomlString(helper, "name")).toBe("node-compat");
    expect(tomlString(helper, "owner")).toBe("spidermonkey");
    expect(tomlString(helper, "disposition")).toBe("sidecar_tooling_owned_data");
    expect(tomlBool(helper, "registry_identity")).toBe(false);
    expect(tomlString(helper, "helper_path")).toBe("packages/registry/node-compat/bootstrap.js");
    expect(existsSync(join(repoRoot, tomlString(helper, "helper_path") ?? ""))).toBe(true);
    expect(spidermonkeyBuild).toContain('"packages/registry/node-compat/bootstrap.js"');
    expect(spidermonkeyScript).toContain("NODE_SHARED_BOOTSTRAP_JS");
  });

  it("excludes helper inputs from package set identities", () => {
    const helperNames = ["pcre2-source", "npm", "node-compat"];
    for (const setFile of setFiles()) {
      const text = readFileSync(setFile, "utf8");
      for (const helperName of helperNames) {
        expect(text).not.toMatch(new RegExp(`"${helperName}"`));
      }
    }

    expect(tomlString(readRepo("packages/registry/pcre2-source/package.toml"), "kind")).toBe("source");
    expect(existsSync(join(registryRoot, "pcre2-source", "build.toml"))).toBe(false);
    expect(existsSync(join(registryRoot, "npm", "package.toml"))).toBe(false);
    expect(existsSync(join(registryRoot, "node-compat", "package.toml"))).toBe(false);
  });
});
