import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { describe, expect, it } from "vitest";

import { DEV_TOOL_ARCHIVE_SPECS, DEV_TOOL_BINARY_SPECS } from "../../images/vfs/lib/init/dev-tools";
import { shellLazySpecDependency } from "../../images/vfs/lib/init/shell-binaries";

function outputs(pkg: string): { name: string; wasm: string }[] {
  const text = readFileSync(new URL(`../../packages/registry/${pkg}/package.toml`, import.meta.url), "utf8");
  return [...text.matchAll(/^\[\[outputs\]\]\nname = "([^"]+)"\nwasm = "([^"]+)"/gm)]
    .map((match) => ({ name: match[1]!, wasm: match[2]! }));
}

function dependsOn(manifest: string): string[] {
  const text = readFileSync(new URL(`../../${manifest}`, import.meta.url), "utf8");
  const list = /^depends_on = \[([\s\S]*?)\]/m.exec(text)?.[1] ?? "";
  return [...list.matchAll(/"([^"@]+)@[^"]+"/g)].map((match) => match[1]!);
}

const specs = [
  ...DEV_TOOL_BINARY_SPECS.map((spec) => ({ id: spec.id, dependency: shellLazySpecDependency(spec), resolverPath: spec.resolverPath })),
  ...DEV_TOOL_ARCHIVE_SPECS.map((spec) => ({ id: spec.id, dependency: spec.dependency, resolverPath: spec.resolverPath })),
];

describe("GNU build tool specs", () => {
  it.each(specs)("$id names a declared output by its projected file name", ({ dependency, resolverPath }) => {
    // The package projection names an output's file after the output's name,
    // so a spec resolves only when the name and the file name agree.
    const file = basename(resolverPath);
    const output = outputs(dependency).find((candidate) => candidate.wasm === file);
    expect(output, `${dependency} declares no output ${file}`).toBeDefined();
    expect(`${output!.name}${extname(output!.wasm)}`).toBe(file);
  });

  it("is in both images that carry the tools", () => {
    const owners = new Set(specs.map(({ dependency }) => dependency));
    for (const manifest of ["packages/registry/shell/package.toml", "packages/registry/kandelo-build-image/package.toml"]) {
      expect(dependsOn(manifest), manifest).toEqual(expect.arrayContaining([...owners]));
    }
  });
});
