import { describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "vite";
import {
  createBinaryDevAccess,
} from "../../apps/browser-demos/binary-dev-access";

type Guard = (
  request: { url?: string },
  response: { statusCode: number; end(body: string): void },
  next: () => void,
) => void;

function fsUrl(file: string): string {
  return `/@fs/${encodeURI(normalizePath(file).replace(/^\//, ""))}`;
}

describe("Vite browser binary capabilities", () => {
  it("publishes no member when a later member fails batch approval", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "kandelo-binary-access-"));
    try {
      const repoRoot = join(testRoot, "repo");
      const programCacheRoot = join(testRoot, "cache", "programs");
      const first = join(programCacheRoot, "generation", "first.wasm");
      const invalidSecond = join(
        programCacheRoot,
        "generation",
        "not-a-file",
      );
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
      guard!({ url: fsUrl(realpathSync(first)) }, rejectedResponse, rejectedNext);
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
      guard!({ url: fsUrl(realpathSync(first)) }, approvedResponse, approvedNext);
      expect(approvedResponse.statusCode).toBe(200);
      expect(approvedNext).toHaveBeenCalledOnce();
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});
