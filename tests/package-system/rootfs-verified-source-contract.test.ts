import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import { buildImage } from "../../tools/mkrootfs/src/builder";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const verifiedArchivePackages = [
  ["dash", "DASH_VERSION", "auto"],
  ["bash", "BASH_VERSION_PKG", "auto"],
  ["ncurses", "NCURSES_VERSION", "auto"],
  ["coreutils", "COREUTILS_VERSION", "auto"],
  ["gawk", "GAWK_VERSION", "auto"],
  ["grep", "GREP_VERSION", "auto"],
  ["sed", "SED_VERSION", "auto"],
  ["bc", "BC_VERSION", "disabled"],
  ["file", "FILE_VERSION", "auto"],
  ["m4", "M4_VERSION", "auto"],
  ["make", "MAKE_VERSION", "auto"],
  ["findutils", "FINDUTILS_VERSION", "auto"],
  ["diffutils", "DIFFUTILS_VERSION", "auto"],
] as const;

function manifestField(source: string, pattern: RegExp, label: string): string {
  const value = pattern.exec(source)?.[1];
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function sourceField(manifest: string, field: "url" | "sha256"): string {
  const sourceBlock = manifest.split(/^\[source\]\s*$/m)[1]?.split(/^\[/m)[0];
  if (sourceBlock === undefined) throw new Error("missing [source] block");
  return manifestField(
    sourceBlock,
    new RegExp(`^${field}\\s*=\\s*"([^"]+)"$`, "m"),
    `source ${field}`,
  );
}

function readVfsText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    const read = fs.read(fd, bytes, null, bytes.byteLength);
    return new TextDecoder().decode(bytes.subarray(0, read));
  } finally {
    fs.close(fd);
  }
}

describe("source-rootfs verified archive contract", () => {
  const rootfsManifest = readFileSync(
    resolve(repoRoot, "packages/registry/rootfs/package.toml"),
    "utf8",
  );

  for (const [
    packageName,
    versionVariable,
    forkInstrumentation,
  ] of verifiedArchivePackages) {
    it(`${packageName} binds isolated builds to its manifest source`, () => {
      const manifest = readFileSync(
        resolve(repoRoot, `packages/registry/${packageName}/package.toml`),
        "utf8",
      );
      const buildScript = readFileSync(
        resolve(
          repoRoot,
          `packages/registry/${packageName}/build-${packageName}.sh`,
        ),
        "utf8",
      );
      const buildToml = readFileSync(
        resolve(repoRoot, `packages/registry/${packageName}/build.toml`),
        "utf8",
      );
      const version = manifestField(
        manifest,
        /^version\s*=\s*"([^"]+)"$/m,
        "package version",
      );
      const sourceUrl = sourceField(manifest, "url");
      const sourceSha256 = sourceField(manifest, "sha256");
      expect(sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      const sourceUrlTemplate = sourceUrl.replace(
        version,
        `\${${versionVariable}}`,
      );

      expect(buildScript).toContain(
        `${versionVariable}="\${WASM_POSIX_DEP_VERSION:-\${${versionVariable}:-${version}}}"`,
      );
      expect(buildScript).toContain(
        `SOURCE_URL="\${WASM_POSIX_DEP_SOURCE_URL:-${sourceUrlTemplate}}"`,
      );
      expect(buildScript).toContain(
        `SOURCE_SHA256="\${WASM_POSIX_DEP_SOURCE_SHA256:-${sourceSha256}}"`,
      );
      expect(buildScript).toContain(
        'VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"',
      );
      expect(buildScript).toContain("scripts/package-build-roots.sh");
      expect(buildScript).toContain("kandelo_package_prepare_build_roots");
      expect(buildScript).toContain(
        `kandelo_package_stage_verified_source ${packageName}`,
      );
      expect(buildScript).toContain("WASM_POSIX_INSTALL_LOCAL_MIRROR=0");
      expect(buildScript).toContain(
        `WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=${forkInstrumentation}`,
      );
      expect(buildScript).toMatch(/^SRC_DIR="\$WORK_DIR\//m);
      expect(buildScript).not.toContain('SRC_DIR="$SCRIPT_DIR/');
      expect(buildScript).not.toContain('"$SCRIPT_DIR/bin/');
      expect(buildScript).not.toContain("curl ");
      expect(buildScript).not.toContain('"/tmp/$TARBALL"');
      expect(buildToml).toContain('"scripts/package-build-roots.sh"');
      expect(buildToml).toMatch(/^commit\s*=\s*"UNPUBLISHED"$/m);
      expect(rootfsManifest).toContain(`"${packageName}@${version}"`);
    });
  }

  it("generates bc's host table without an ambient ed", () => {
    const scratch = mkdtempSync(resolve(tmpdir(), "kandelo-bc-libmath-"));
    try {
      writeFileSync(
        resolve(scratch, "libmath.h"),
        "first generated line\nsecond generated line\nfbc marker\n",
      );
      execFileSync(
        "python3",
        [resolve(repoRoot, "packages/registry/bc/fix-libmath-h.py")],
        { cwd: scratch, stdio: "pipe" },
      );
      expect(readFileSync(resolve(scratch, "libmath.h"), "utf8")).toBe(
        '{"first generated line",\n"second generated line",0}\n',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("composes rootfs only from resolver-owned dependency, work, and output roots", () => {
    const wrapper = readFileSync(
      resolve(repoRoot, "packages/registry/rootfs/build-rootfs-package.sh"),
      "utf8",
    );
    const builder = readFileSync(
      resolve(repoRoot, "scripts/build-rootfs.sh"),
      "utf8",
    );
    const buildToml = readFileSync(
      resolve(repoRoot, "packages/registry/rootfs/build.toml"),
      "utf8",
    );

    expect(wrapper).toContain("WASM_POSIX_DEP_WORK_DIR");
    expect(wrapper).toContain('ROOTFS_OUT="$VFS"');
    expect(wrapper).toContain(
      'ROOTFS_BINARIES_DIR="$work_real/rootfs-binaries"',
    );
    expect(wrapper).toContain("ROOTFS_STAGE_RESOLVER_BINARIES=1");
    expect(wrapper).toContain("ROOTFS_SEALED_BUILD=1");
    expect(builder).toContain("--stage-resolver-binaries");
    expect(builder).toContain("node_modules/tsx/dist/cli.mjs");
    expect(buildToml).toContain('"package-lock.json"');
    expect(buildToml).toMatch(/^revision\s*=\s*10$/m);
    expect(buildToml).toMatch(/^commit\s*=\s*"UNPUBLISHED"$/m);
  });

  it("composes the image-owned hostname and default Bash prompt", async () => {
    const image = await buildImage({
      sourceTree: resolve(repoRoot, "images/rootfs"),
      manifest: resolve(repoRoot, "MANIFEST"),
      repoRoot,
    });
    const fs = MemoryFileSystem.fromImage(image);

    expect(readVfsText(fs, "/etc/hostname")).toBe("kandelo\n");
    expect(readVfsText(fs, "/etc/profile.d/kandelo-prompt.sh")).not.toBe("");
    expect(fs.stat("/etc/profile.d").mode & 0o777).toBe(0o755);
    expect(fs.stat("/etc/profile.d/kandelo-prompt.sh").mode & 0o777).toBe(
      0o644,
    );
  });

  it("declares prompt image metadata and advances dependent image identities", () => {
    const manifest = readFileSync(resolve(repoRoot, "MANIFEST"), "utf8");
    expect.soft(manifest).toMatch(/^\/etc\/profile\.d\s+d\s+0755\s+0\s+0$/m);
    expect
      .soft(manifest)
      .toMatch(/^\/etc\/profile\.d\/kandelo-prompt\.sh\s+f\s+0644\s+0\s+0$/m);
    expect
      .soft(
        readFileSync(
          resolve(repoRoot, "packages/registry/shell/build.toml"),
          "utf8",
        ),
      )
      .toMatch(/^revision\s*=\s*24$/m);
    expect
      .soft(
        readFileSync(
          resolve(repoRoot, "homebrew/source-rootfs-shell-package/build.toml"),
          "utf8",
        ),
      )
      .toMatch(/^revision\s*=\s*4$/m);
  });

  const promptPath = resolve(
    repoRoot,
    "images/rootfs/etc/profile.d/kandelo-prompt.sh",
  );
  const printPrompt = 'PS1=sentinel; . "$1"; printf "%s" "$PS1"';
  const styledRootPrompt =
    "\\[\\e]133;A\\a\\]\\[\\e[36m\\]\\u@\\h \\[\\e[34m\\]\\w \\[\\e[31m\\]❯\\[\\e[0m\\] \\[\\e]133;B\\a\\]";
  const styledUserPrompt =
    "\\[\\e]133;A\\a\\]\\[\\e[36m\\]\\u@\\h \\[\\e[34m\\]\\w \\[\\e[32m\\]❯\\[\\e[0m\\] \\[\\e]133;B\\a\\]";
  const runBash = (
    interactive: boolean,
    term: string,
    forcedPrivilege: "actual" | "root" | "user" = "actual",
  ): string =>
    execFileSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        ...(interactive ? ["-i"] : []),
        "-c",
        `
forced_privilege=$2
if [[ $forced_privilege != actual ]]; then
  function [ {
    if [[ $# -eq 4 && $2 == -eq && $3 == 0 && $4 == "]" ]]; then
      [[ $forced_privilege == root ]]
      return
    fi
    builtin [ "$@"
  }
fi
${printPrompt}
`,
        "bash",
        promptPath,
        forcedPrivilege,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TERM: term },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

  it("leaves the image prompt unchanged outside interactive Bash", () => {
    expect(runBash(false, "xterm-256color")).toBe("sentinel");
    for (const interactive of [false, true]) {
      expect(
        execFileSync(
          "dash",
          [
            ...(interactive ? ["-i"] : []),
            "-c",
            printPrompt,
            "dash",
            promptPath,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, TERM: "xterm-256color" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      ).toBe("sentinel");
    }
  });

  it("uses the plain prompt for dumb interactive terminals", () => {
    expect(runBash(true, "dumb")).toBe("\\u@\\h \\w \\$ ");
  });

  it("selects exact styled prompts for root and ordinary users", () => {
    expect(runBash(true, "xterm-256color", "root")).toBe(styledRootPrompt);
    expect(runBash(true, "xterm-256color", "user")).toBe(styledUserPrompt);

    expect(runBash(true, "xterm-256color")).toBe(
      process.geteuid?.() === 0 ? styledRootPrompt : styledUserPrompt,
    );
  });

  it("keeps browser shell launch policy without overriding the image prompt", async () => {
    const pageUrl = new URL("https://example.test/kandelo/");
    const serviceWorker = {
      controller: {},
      register: vi.fn(async () => undefined),
      ready: Promise.resolve({}),
    };
    const sessionValues = new Map<string, string>();
    vi.stubGlobal("window", {
      location: pageUrl,
      crossOriginIsolated: true,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("location", pageUrl);
    vi.stubGlobal("navigator", { serviceWorker });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => sessionValues.set(key, value),
      removeItem: (key: string) => sessionValues.delete(key),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) =>
        String(input).endsWith("/gallery.json")
          ? Promise.resolve(
              new Response(JSON.stringify({ entries: [] }), {
                headers: { "content-type": "application/json" },
              }),
            )
          : new Promise<Response>(() => {}),
      ),
    );

    let shellHost: { halt(): Promise<void> } | undefined;
    let nodeHost: { halt(): Promise<void> } | undefined;
    try {
      const { createLiveHost } =
        await import("../../apps/browser-demos/pages/kandelo/kernel-host/live-setup");
      shellHost = await createLiveHost({ demo: "shell" });
      nodeHost = await createLiveHost({ demo: "node" });
      const shellEnv = shellHost.getBootDescriptor().boot.env;
      const nodeEnv = nodeHost.getBootDescriptor().boot.env;

      expect(shellEnv).toMatchObject({
        HOME: "/home/user",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        PATH: "/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
        USER: "user",
        LOGNAME: "user",
      });
      expect(nodeEnv).toMatchObject({
        HOME: "/work",
        PWD: "/work",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        PATH: "/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
        USER: "user",
        LOGNAME: "user",
      });
      expect.soft(shellEnv).not.toHaveProperty("PS1");
      expect.soft(nodeEnv).not.toHaveProperty("PS1");
    } finally {
      await shellHost?.halt();
      await nodeHost?.halt();
      await new Promise<void>((resolveDone) => setTimeout(resolveDone, 20));
      vi.unstubAllGlobals();
    }
  });
});
