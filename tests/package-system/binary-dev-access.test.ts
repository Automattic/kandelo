import { describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "vite";
import { createBinaryDevAccess } from "../../apps/browser-demos/binary-dev-access";

type Guard = (
  request: { url?: string },
  response: { statusCode: number; end(body: string): void },
  next: () => void,
) => void;

function fsUrl(file: string): string {
  return `/@fs/${encodeURI(normalizePath(file).replace(/^\//, ""))}`;
}

describe("Vite browser binary capabilities", () => {
  it("accepts only canonical approved files in the configured cache root", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "kandelo-binary-roots-"));
    try {
      const repoRoot = join(testRoot, "repo");
      const programCacheRoot = join(testRoot, "cache", "programs");
      const generation = join(programCacheRoot, "generation");
      const approved = join(generation, "approved.wasm");
      const unapproved = join(generation, "unapproved.wasm");
      const siblingRoot = join(testRoot, "sibling-cache", "programs");
      const sibling = join(siblingRoot, "private.wasm");
      const escapedAlias = join(generation, "escaped.wasm");
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(generation, { recursive: true });
      mkdirSync(siblingRoot, { recursive: true });
      writeFileSync(approved, "approved");
      writeFileSync(unapproved, "unapproved");
      writeFileSync(sibling, "private");
      symlinkSync(sibling, escapedAlias);

      const access = createBinaryDevAccess({
        repoRoot: realpathSync(repoRoot),
        programCacheRoot: realpathSync(programCacheRoot),
        caseInsensitivePaths: false,
      });
      expect(access.approve(approved)).toBe(realpathSync(approved));
      expect(() => access.approve(sibling)).toThrow(
        "outside the Kandelo program cache",
      );
      expect(() =>
        access.approve(
          join(
            programCacheRoot,
            "..",
            "..",
            "sibling-cache",
            "programs",
            "private.wasm",
          ),
        ),
      ).toThrow("outside the Kandelo program cache");
      expect(() => access.approve(escapedAlias)).toThrow(
        "outside the Kandelo program cache",
      );

      let guard: Guard | undefined;
      access.attachServer({
        middlewares: {
          use(candidate: unknown) {
            guard = candidate as Guard;
          },
        },
      } as Parameters<typeof access.attachServer>[0]);

      const approvedResponse = { statusCode: 200, end: vi.fn() };
      const approvedNext = vi.fn();
      guard!(
        { url: fsUrl(realpathSync(approved)) },
        approvedResponse,
        approvedNext,
      );
      expect(approvedResponse.statusCode).toBe(200);
      expect(approvedNext).toHaveBeenCalledOnce();

      for (const denied of [
        realpathSync(unapproved),
        join(realpathSync(generation), "escaped.wasm"),
      ]) {
        const deniedResponse = { statusCode: 200, end: vi.fn() };
        const deniedNext = vi.fn();
        guard!({ url: fsUrl(denied) }, deniedResponse, deniedNext);
        expect(deniedResponse.statusCode).toBe(403);
        expect(deniedNext).not.toHaveBeenCalled();
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("publishes no member when a later member fails batch approval", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "kandelo-binary-access-"));
    try {
      const repoRoot = join(testRoot, "repo");
      const programCacheRoot = join(testRoot, "cache", "programs");
      const first = join(programCacheRoot, "generation", "first.wasm");
      const invalidSecond = join(programCacheRoot, "generation", "not-a-file");
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(invalidSecond, { recursive: true });
      writeFileSync(first, "first");

      const access = createBinaryDevAccess({
        repoRoot: realpathSync(repoRoot),
        programCacheRoot: realpathSync(programCacheRoot),
        caseInsensitivePaths: false,
      });
      let guard: Guard | undefined;
      access.attachServer({
        middlewares: {
          use(candidate: unknown) {
            guard = candidate as Guard;
          },
        },
      } as Parameters<typeof access.attachServer>[0]);

      expect(() => access.approveBatch([first, invalidSecond])).toThrow(
        "not a regular file",
      );
      const rejectedResponse = {
        statusCode: 200,
        end: vi.fn(),
      };
      const rejectedNext = vi.fn();
      guard!(
        { url: fsUrl(realpathSync(first)) },
        rejectedResponse,
        rejectedNext,
      );
      expect(rejectedResponse.statusCode).toBe(403);
      expect(rejectedNext).not.toHaveBeenCalled();

      rmSync(invalidSecond, { recursive: true });
      writeFileSync(invalidSecond, "second");
      expect(access.approveBatch([first, invalidSecond])).toHaveLength(2);
      const approvedResponse = {
        statusCode: 200,
        end: vi.fn(),
      };
      const approvedNext = vi.fn();
      guard!(
        { url: fsUrl(realpathSync(first)) },
        approvedResponse,
        approvedNext,
      );
      expect(approvedResponse.statusCode).toBe(200);
      expect(approvedNext).toHaveBeenCalledOnce();
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("routes main and worker aliases through the same cache capability", () => {
    const config = readFileSync(
      new URL("../../apps/browser-demos/vite.config.ts", import.meta.url),
      "utf8",
    );
    expect(
      config.match(/resolveKernelArtifactsAlias\(binaryDevAccess\)/g),
    ).toHaveLength(2);
    expect(
      config.match(
        /resolveBinariesAlias\(binaryDevAccess, browserBinaryResolution\)/g,
      ),
    ).toHaveLength(2);
    expect(
      config.match(/programCacheRoot: browserExternalArtifactRoot/g),
    ).toHaveLength(1);
    expect(
      config.match(/allow: \[repoRoot, browserExternalArtifactRoot\]/g),
    ).toHaveLength(1);
    expect(config).toContain("sourceOnlyBinaryRoot");
    expect(config).toContain(
      ".kandelo/source-only-program-projection-v1.json",
    );
    expect(config).toContain(
      'sourceOnlyViteAssets.resolve("kernel.wasm")',
    );
    expect(config).toContain(
      'sourceOnlyViteAssets!.resolve(\n            "programs/wasm32/rootfs.vfs",',
    );
    expect(config).toContain(
      "sourceOnlyViteAssets.resolve(request.relPath)",
    );
    expect(config.match(/sourceOnlyViteAssets\.plugin\(\)/g)).toHaveLength(2);
    expect(config).toContain(
      "SourceOnly browser builds admit only the root main, kandelo, and network inputs",
    );
    expect(config).toContain(
      'publicDir: sourceOnlyPublicSnapshot?.path ?? "public"',
    );
  });
});
