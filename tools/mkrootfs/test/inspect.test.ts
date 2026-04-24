import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildImage } from "../src/builder.ts";
import { inspectImage, type InspectLine } from "../src/inspect.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("inspect command", () => {
  it("prints type, mode, uid:gid, size, and path for each entry", async () => {
    const fixture = join(here, "fixtures", "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });

    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-inspect-"));
    const imagePath = join(tmp, "rootfs.vfs");
    writeFileSync(imagePath, image);
    try {
      const captured: string[] = [];
      const lines: InspectLine[] = inspectImage(imagePath, (s) => captured.push(s));

      const byPath = new Map(lines.map((l) => [l.path, l]));
      expect(byPath.has("/")).toBe(true);
      expect(byPath.get("/etc")!.type).toBe("d");
      expect(byPath.get("/etc")!.modeOctal).toBe("0755");
      expect(byPath.get("/etc/passwd")!.type).toBe("-");
      expect(byPath.get("/etc/passwd")!.modeOctal).toBe("0644");
      expect(byPath.get("/home/alice")!.uid).toBe(1000);
      expect(byPath.get("/home/alice")!.gid).toBe(1000);
      expect(byPath.get("/tmp")!.modeOctal).toBe("1777");

      // Ensure the write callback got each path
      expect(captured.some((s) => s.includes("/etc/passwd"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
