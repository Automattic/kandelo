import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build as viteBuild } from "vite";
import {
  createSourceOnlyPublicSnapshot,
  createSourceOnlyViteAssets,
  rewriteBinaryMirrorUrlGlobs,
  SOURCE_ONLY_VITE_RETAINED_MAX_BYTES,
} from "../../apps/browser-demos/source-only-vite-assets";
import type {
  SourceOnlyBinarySnapshot,
  SourceOnlyBinarySnapshotSession,
} from "../../host/src/binary-resolver";
import type { Plugin } from "vite";

describe("normal binary mirror URL globs", () => {
  const specifier = "../../local-binaries/programs/wasm32/lamp.vfs.zst";
  const code = `export const images = import.meta.glob(${JSON.stringify(specifier)}, `
    + '{ query: "?url", import: "default" });';

  it("asks the binary authority even when the authored mirror is absent", () => {
    const requests: string[] = [];
    const rewritten = rewriteBinaryMirrorUrlGlobs(code, "/app/loader.ts", {
      resolveMirrorImport: () => "programs/wasm32/lamp.vfs.zst",
      resolveModule: (relPath) => {
        requests.push(relPath);
        return `@binaries/${relPath}?url`;
      },
    });
    expect(requests).toEqual(["programs/wasm32/lamp.vfs.zst"]);
    expect(rewritten).toContain(JSON.stringify(specifier));
    expect(rewritten).toContain('import("@binaries/programs/wasm32/lamp.vfs.zst?url")');
    expect(rewritten).not.toContain("import.meta.glob");
  });

  it("distinguishes an absent asset from a rejected provenance check", () => {
    const options = {
      resolveMirrorImport: () => "programs/wasm32/lamp.vfs.zst",
      resolveModule: () => null,
    };
    expect(rewriteBinaryMirrorUrlGlobs(code, "/app/loader.ts", options))
      .toBe("export const images = ({});");
    const failure = new Error("stale artifact receipt");
    expect(() => rewriteBinaryMirrorUrlGlobs(code, "/app/loader.ts", {
      ...options,
      resolveModule: () => { throw failure; },
    })).toThrow(failure);
  });

  it("defers development import analysis until the optional loader is called", () => {
    const rewritten = rewriteBinaryMirrorUrlGlobs(code, "/app/loader.ts", {
      resolveMirrorImport: () => "programs/wasm32/lamp.vfs.zst",
      resolveModule: (relPath) => `/@id/@binaries/${relPath}?url`,
      deferDevImportAnalysis: true,
    });
    expect(rewritten).toContain(
      '((id)=>import(/* @vite-ignore */ id))("/@id/@binaries/programs/wasm32/lamp.vfs.zst?url")',
    );
  });
});

function snapshot(relPath: string, text: string): SourceOnlyBinarySnapshot {
  const bytes = Buffer.from(text);
  return {
    relPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

function emittedBytes(plugin: Plugin, id: string): Buffer {
  let source: string | Uint8Array | undefined;
  (plugin.configResolved as (config: unknown) => void)({
    command: "build",
    base: "/",
  });
  (plugin.load as (this: unknown, id: string) => unknown).call({
    emitFile(asset: { source: string | Uint8Array }) {
      source = asset.source;
      return "test-reference";
    },
  }, id);
  if (source === undefined) throw new Error("test asset was not emitted");
  return Buffer.from(source);
}

describe("SourceOnly Vite asset snapshots", () => {
  it("captures the authored batch from one pinned session and stores immutable files", () => {
    const available = new Map([
      ["kernel.wasm", snapshot("kernel.wasm", "kernel generation one")],
      [
        "programs/wasm32/demo/demo.wasm",
        snapshot("programs/wasm32/demo/demo.wasm", "demo generation one"),
      ],
    ]);
    const calls: Array<{ paths: readonly string[]; limit: number }> = [];
    const session: SourceOnlyBinarySnapshotSession = {
      snapshots(paths, limit) {
        calls.push({ paths: [...paths], limit });
        return paths.map((path) => available.get(path) ?? null);
      },
    };
    const assets = createSourceOnlyViteAssets(session, [
      "kernel.wasm",
      "programs/wasm32/demo/demo.wasm",
      "programs/wasm32/optional/missing.wasm",
    ]);

    const demoId = assets.resolve("programs/wasm32/demo/demo.wasm");
    expect(calls).toEqual([{
      paths: [
        "kernel.wasm",
        "programs/wasm32/demo/demo.wasm",
        "programs/wasm32/optional/missing.wasm",
      ],
      limit: SOURCE_ONLY_VITE_RETAINED_MAX_BYTES,
    }]);
    expect(emittedBytes(assets.plugin(), demoId).toString("utf8")).toBe(
      "demo generation one",
    );

    available.set(
      "programs/wasm32/demo/demo.wasm",
      snapshot("programs/wasm32/demo/demo.wasm", "poison generation two"),
    );
    expect(assets.resolve("programs/wasm32/demo/demo.wasm")).toBe(demoId);
    expect(calls).toHaveLength(1);
    expect(emittedBytes(assets.plugin(), demoId).toString("utf8")).toBe(
      "demo generation one",
    );
    assets.dispose();
  });

  it("rejects a provider that exceeds the total retained-byte cap", () => {
    const bytes = Buffer.from("nine-byte");
    const session: SourceOnlyBinarySnapshotSession = {
      snapshots(paths) {
        return paths.map((relPath) => ({
          relPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes,
        }));
      },
    };
    const assets = createSourceOnlyViteAssets(
      session,
      ["too-large.dat"],
      { maxRetainedBytes: 8 },
    );
    expect(() => assets.resolve("too-large.dat")).toThrow(
      "total retained-byte limit",
    );
    assets.dispose();
  });

  it("rewrites an exact mirror glob when only SourceOnly owns the artifact", () => {
    const relPath = "programs/wasm32/optional/demo.wasm";
    const specifier = "../../../../local-binaries/programs/wasm32/optional/demo.wasm";
    const poisonedFallback = "../../public/poison.vfs.zst";
    const session: SourceOnlyBinarySnapshotSession = {
      snapshots(paths) {
        return paths.map((path) =>
          path === relPath ? snapshot(path, "source-only optional") : null
        );
      },
    };
    const assets = createSourceOnlyViteAssets(session, [], {
      resolveMirrorImport(candidate) {
        return candidate === specifier ? relPath : null;
      },
      denyFallbackGlob(candidate) {
        return candidate === poisonedFallback;
      },
    });
    const plugin = assets.plugin();
    const original =
      `export const optional = import.meta.glob(${JSON.stringify(specifier)}, ` +
      `{ query: "?url", import: "default" });\n` +
      `export const poisoned = import.meta.glob(${JSON.stringify(poisonedFallback)}, ` +
      `{ query: "?url", import: "default" });`;
    const transformed = (
      plugin.transform as (code: string, id: string) =>
        { code: string } | null
    )(original, "/repo/apps/browser-demos/pages/example.ts");

    expect(transformed?.code).toContain(JSON.stringify(specifier));
    expect(transformed?.code).toContain("virtual:kandelo-source-only-asset:");
    expect(transformed?.code).not.toContain("import.meta.glob");
    expect(transformed?.code).not.toContain(poisonedFallback);
    assets.dispose();
  });

  it("rejects array-valued globs before Vite can bypass the scalar boundary", () => {
    const session: SourceOnlyBinarySnapshotSession = {
      snapshots(paths) {
        return paths.map(() => null);
      },
    };
    const assets = createSourceOnlyViteAssets(session, [], {
      resolveMirrorImport() {
        return null;
      },
    });
    const plugin = assets.plugin();
    const original =
      `export const optional = import.meta.glob(["../../local-binaries/a.wasm"], ` +
      `{ query: "?url", import: "default" });`;
    expect(() => (
      plugin.transform as (code: string, id: string) => unknown
    )(original, "/repo/apps/browser-demos/pages/example.ts")).toThrow(
      "array-valued import.meta.glob is not admitted",
    );
    assets.dispose();
  });

  it("snapshots only the closed authored-public allowlist", () => {
    const publicRoot = mkdtempSync(join(tmpdir(), "kandelo-public-source-"));
    let filtered: ReturnType<typeof createSourceOnlyPublicSnapshot> | null = null;
    try {
      mkdirSync(join(publicRoot, "nested"), { recursive: true });
      writeFileSync(join(publicRoot, "service-worker.js"), "safe worker\n");
      writeFileSync(join(publicRoot, "nested", "probe.html"), "ambient html\n");
      for (const artifact of [
        "ambient.zip",
        "ambient.wasm",
        "ambient.vfs",
        "ambient.vfs.zst",
        "ambient.sql",
        "ambient.data.json",
        "extensionless-output",
      ]) {
        writeFileSync(join(publicRoot, artifact), `poison ${artifact}\n`);
      }

      filtered = createSourceOnlyPublicSnapshot(publicRoot);
      expect(readFileSync(join(filtered.path, "service-worker.js"), "utf8"))
        .toBe("safe worker\n");
      expect(existsSync(join(filtered.path, "nested", "probe.html"))).toBe(false);
      for (const artifact of [
        "ambient.zip",
        "ambient.wasm",
        "ambient.vfs",
        "ambient.vfs.zst",
        "ambient.sql",
        "ambient.data.json",
        "extensionless-output",
      ]) {
        expect(existsSync(join(filtered.path, artifact))).toBe(false);
        expect(filtered.deniesRequestPath(artifact)).toBe(true);
      }
      expect(filtered.deniesRequestPath("nested/probe.html")).toBe(true);
      expect(filtered.deniesRequestPath("service-worker.js")).toBe(false);
    } finally {
      filtered?.dispose();
      rmSync(publicRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "builds publicly readable static files while keeping the snapshot directory private",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kandelo-public-build-"));
      const publicRoot = join(root, "public");
      const outDir = join(root, "dist");
      let filtered: ReturnType<typeof createSourceOnlyPublicSnapshot> | null = null;
      const savedUmask = process.umask(0o022);
      try {
        mkdirSync(publicRoot);
        writeFileSync(join(root, "index.html"), "<h1>Kandelo</h1>\n");
        for (const name of ["service-worker.js", "blob-iframe-interceptor.js"]) {
          const file = join(publicRoot, name);
          writeFileSync(file, `// ${name}\n`);
          chmodSync(file, 0o600);
        }
        writeFileSync(join(publicRoot, "ambient.wasm"), "excluded\n");
        filtered = createSourceOnlyPublicSnapshot(publicRoot);

        await viteBuild({
          configFile: false,
          root,
          publicDir: filtered.path,
          logLevel: "silent",
          build: { outDir },
        });

        expect(statSync(dirname(filtered.path)).mode & 0o777).toBe(0o700);
        expect(statSync(filtered.path).mode & 0o777).toBe(0o700);
        expect(statSync(outDir).mode & 0o777).toBe(0o755);
        for (const name of ["index.html", "service-worker.js", "blob-iframe-interceptor.js"]) {
          expect(statSync(join(outDir, name)).mode & 0o777, name).toBe(0o644);
        }
        expect(readFileSync(join(outDir, "service-worker.js"), "utf8"))
          .toBe("// service-worker.js\n");
        expect(existsSync(join(outDir, "ambient.wasm"))).toBe(false);
        expect(statSync(join(publicRoot, "service-worker.js")).mode & 0o777)
          .toBe(0o600);
      } finally {
        process.umask(savedUmask);
        filtered?.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
