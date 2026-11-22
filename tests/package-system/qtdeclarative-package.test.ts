import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("qtdeclarative package contract", () => {
  it("keeps the <linux/limits.h> shim a forward to POSIX <limits.h>", () => {
    const shim = source(
      "packages/registry/qtdeclarative/src/include/linux/limits.h",
    );

    // Qt 6.12's bundled WTF includes <linux/limits.h> under OS(LINUX) for
    // PATH_MAX. The shim forwards to <limits.h> and carries no values of
    // its own, so nothing here can disagree with libc's limits.
    expect(shim.match(/^#\s*include\s+.*$/gm)).toEqual([
      "#include <limits.h>",
    ]);
    // Only the include guard.
    expect(shim.match(/^#\s*define\s+\w+/gm)).toEqual([
      "#define KANDELO_SHIM_LINUX_LIMITS_H",
    ]);
  });

  it("puts the shim directory on the compile line and in the cache key", () => {
    const build = source(
      "packages/registry/qtdeclarative/build-qtdeclarative.sh",
    );
    const buildToml = source("packages/registry/qtdeclarative/build.toml");

    expect(build).toContain(
      'TARGET_DEFINES="-D__linux__=1 -DQT_LINUXBASE -I$SCRIPT_DIR/src/include"',
    );
    // script_path is not implicit: only what `inputs` names is hashed.
    expect(buildToml).toContain(
      '"packages/registry/qtdeclarative/src/include/linux/limits.h"',
    );
  });
});
