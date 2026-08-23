import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const successfulResult = JSON.stringify({
  schema: 1,
  policy: "source-only-v1",
  outcome: "succeeded",
  nodes: [
    {
      node: { kind: "package", name: "base", target_arch: "wasm32" },
      state: "succeeded",
      disposition: "cached",
    },
    {
      node: { kind: "package", name: "app", target_arch: "wasm32" },
      state: "succeeded",
      disposition: "published",
    },
    {
      node: { kind: "product", id: "browser-app" },
      state: "succeeded",
      disposition: "cached",
    },
  ],
});
const failedResult = JSON.stringify({
  schema: 1,
  policy: "source-only-v1",
  outcome: "failed",
  nodes: [
    {
      node: { kind: "package", name: "base", target_arch: "wasm32" },
      state: "succeeded",
      disposition: "cached",
    },
    {
      node: { kind: "package", name: "app", target_arch: "wasm32" },
      state: "failed",
      exit_code: 1,
    },
    {
      node: { kind: "product", id: "browser-app" },
      state: "blocked",
      failed_ancestors: [
        { kind: "package", name: "app", target_arch: "wasm32" },
      ],
    },
  ],
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture(result = successfulResult, cargoStatus = 0) {
  const root = mkdtempSync(join(tmpdir(), "kandelo-local-build-wrapper-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const cargoRecord = join(root, "cargo.args");
  const ghRecord = join(root, "gh.calls");
  const nixRecord = join(root, "nix.calls");
  const npxRecord = join(root, "npx.calls");
  roots.push(root);
  mkdirSync(bin);
  mkdirSync(home);

  writeFileSync(
    join(bin, "rustc"),
    `#!/usr/bin/env bash
cat <<'EOF'
rustc 1.99.0
binary: rustc
commit-hash: fixture
commit-date: 2026-08-23
host: fixture-host-target
release: 1.99.0
LLVM version: 20.0.0
EOF
`,
  );
  writeFileSync(
    join(bin, "cargo"),
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$CARGO_RECORD"
printf '%s\\n' "$FAKE_LOCAL_BUILD_RESULT"
exit "$FAKE_CARGO_STATUS"
`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
printf 'call\n' >> "$GH_RECORD"
exit 91
`,
  );
  writeFileSync(
    join(bin, "nix"),
    `#!/usr/bin/env bash
printf 'call\\n' >> "$NIX_RECORD"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--command" ]; then
    shift
    export KANDELO_DEV_SHELL_TOOL_PATH="$FAKE_TOOL_PATH"
    exec "$@"
  fi
  shift
done
exit 90
`,
  );
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash
exit 0
`,
  );
  writeFileSync(
    join(bin, "npx"),
    `#!/usr/bin/env bash
{
  printf 'policy=%s\n' "\${WASM_POSIX_RESOLUTION_POLICY:-<unset>}"
  printf 'root=%s\n' "\${WASM_POSIX_SOURCE_ONLY_BINARY_ROOT:-<unset>}"
  printf 'product-map=%s\n' "\${KANDELO_PAGES_PRODUCT_MAP:-<unset>}"
  printf 'asset-group=%s\n' "\${KANDELO_PAGES_VFS_ASSET_GROUP_DIR:-<unset>}"
  for arg in "$@"; do
    printf 'arg=%s\n' "$arg"
  done
  printf 'end\n'
} >> "$NPX_RECORD"
`,
  );
  for (const name of ["rustc", "cargo", "gh", "nix", "npm", "npx"]) {
    chmodSync(join(bin, name), 0o755);
  }

  const path = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  const env = {
    ...process.env,
    PATH: path,
    HOME: home,
    CARGO_RECORD: cargoRecord,
    GH_RECORD: ghRecord,
    NIX_RECORD: nixRecord,
    NPX_RECORD: npxRecord,
    FAKE_TOOL_PATH: path,
    FAKE_LOCAL_BUILD_RESULT: result,
    FAKE_CARGO_STATUS: String(cargoStatus),
    KANDELO_NIX_BIN: join(bin, "nix"),
  };

  return { bin, cargoRecord, env, ghRecord, nixRecord, npxRecord };
}

function successfulSummary(): string {
  return [
    "Local build succeeded",
    "  Nodes:      3/3",
    "  Cache hits: 2",
    "  Built:      1",
    "  Products:   1/1",
    "  Output:     local-binaries/source-only-v1",
    "",
  ].join("\n");
}

function expectedCargoArgs(home: string): string[] {
  return [
    "run",
    "-p",
    "xtask",
    "--target",
    "fixture-host-target",
    "--",
    "local-build",
    "run",
    "--set",
    join(repoRoot, "packages/sets/local-supported.toml"),
    "--source-cache-root",
    join(home, ".cache/kandelo/source-only"),
    "--output-root",
    join(repoRoot, "local-binaries/source-only-v1"),
    "--product",
    "all",
    "--jobs",
    "16",
  ];
}

describe("run.sh local-build", () => {
  it("uses the active direnv dev shell without invoking Nix", () => {
    const fixture = makeFixture();
    const result = spawnSync(
      "/bin/bash",
      [join(repoRoot, "run.sh"), "local-build"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...fixture.env,
          KANDELO_DEV_SHELL_TOOL_PATH: fixture.env.PATH,
        },
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toBe(successfulSummary());
    expect(
      readFileSync(fixture.cargoRecord, "utf8").trim().split("\n"),
    ).toEqual(expectedCargoArgs(fixture.env.HOME));
    expect(() => readFileSync(fixture.nixRecord, "utf8")).toThrow();
  });

  it("enters the declared dev shell when direnv is not active", () => {
    const fixture = makeFixture();
    const result = spawnSync(
      "/bin/bash",
      [join(repoRoot, "run.sh"), "local-build"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...fixture.env,
          KANDELO_DEV_SHELL_TOOL_PATH: "",
        },
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toBe(successfulSummary());
    expect(
      readFileSync(fixture.cargoRecord, "utf8").trim().split("\n"),
    ).toEqual(expectedCargoArgs(fixture.env.HOME));
    expect(readFileSync(fixture.nixRecord, "utf8")).toBe("call\ncall\n");
  });

  it("preserves the canonical machine result with --json", () => {
    const fixture = makeFixture();
    const result = spawnSync(
      "/bin/bash",
      [join(repoRoot, "run.sh"), "local-build", "--json"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...fixture.env,
          KANDELO_DEV_SHELL_TOOL_PATH: fixture.env.PATH,
        },
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toBe(`${successfulResult}\n`);
  });

  it("summarizes failed and blocked nodes without hiding failure", () => {
    const fixture = makeFixture(failedResult, 1);
    const result = spawnSync(
      "/bin/bash",
      [join(repoRoot, "run.sh"), "local-build"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...fixture.env,
          KANDELO_DEV_SHELL_TOOL_PATH: fixture.env.PATH,
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      [
        "Local build failed",
        "  Nodes:      1/3",
        "  Cache hits: 1",
        "  Built:      0",
        "  Products:   0/1",
        "  Failed:     1",
        "  Blocked:    1",
        "  Output:     local-binaries/source-only-v1",
        "",
      ].join("\n"),
    );
  });
});

describe("run.sh browser", () => {
  it("serves the completed SourceOnly projection without legacy fetching", () => {
    const fixture = makeFixture();
    const result = spawnSync(
      "/bin/bash",
      [join(repoRoot, "run.sh"), "browser"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...fixture.env,
          KANDELO_PAGES_PRODUCT_MAP: "/legacy/pages-map.json",
          KANDELO_PAGES_VFS_ASSET_GROUP_DIR: "/legacy/vfs-group",
          KANDELO_DEV_SHELL_TOOL_PATH: fixture.env.PATH,
        },
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain(successfulSummary());
    expect(
      readFileSync(fixture.cargoRecord, "utf8").trim().split("\n"),
    ).toEqual(expectedCargoArgs(fixture.env.HOME));
    expect(readFileSync(fixture.npxRecord, "utf8")).toBe(
      [
        "policy=source-only-v1",
        `root=${join(repoRoot, "local-binaries/source-only-v1")}`,
        "product-map=<unset>",
        "asset-group=<unset>",
        "arg=vite",
        "end",
        "",
      ].join("\n"),
    );
    expect(() => readFileSync(fixture.nixRecord, "utf8")).toThrow();
  });

  it("rejects the retired PR-staging browser selection before remote access", () => {
    const fixture = makeFixture();
    const result = spawnSync(
      "/bin/bash",
      [join(repoRoot, "run.sh"), "--pr-staging", "browser"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...fixture.env,
          KANDELO_DEV_SHELL_TOOL_PATH: fixture.env.PATH,
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "browser commands use local SourceOnly builds",
    );
    expect(() => readFileSync(fixture.ghRecord, "utf8")).toThrow();
  });
});
