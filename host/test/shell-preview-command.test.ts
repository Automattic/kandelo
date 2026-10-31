import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { populateShellRuntimeLayout } from "../src/shell-runtime-layout";
import type { VfsImageFilesystem } from "../src/vfs/vfs-image-filesystem";

function installedCommand(): { script: string; mode: number } {
  const files: { path: string; content: string; mode: number }[] = [];
  const fs = {
    mkdir: vi.fn(), chmod: vi.fn(), chown: vi.fn(), close: vi.fn(),
    open(path: string, _flags: number, mode: number) { files.push({ path, content: "", mode }); return files.length - 1; },
    write(handle: number, bytes: Uint8Array) { files[handle].content += new TextDecoder().decode(bytes); return bytes.length; },
  } as unknown as VfsImageFilesystem;
  populateShellRuntimeLayout(fs);
  const command = files.find(file => file.path === "/usr/local/bin/kandelo-preview")!;
  return { script: command.content, mode: command.mode };
}

describe("installed kandelo-preview command", () => {
  it("is executable, has valid POSIX shell syntax and documents request semantics", () => {
    const { script, mode } = installedCommand();
    expect(mode).toBe(0o755);
    expect(spawnSync("sh", ["-n"], { input: script }).status).toBe(0);
    const help = spawnSync("sh", ["-c", script, "kandelo-preview", "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("connection errors appear in Web");
    expect(script).toContain("777;kandelo-preview;1;");
  });

  it("refuses nonterminal output instead of writing control sequences into files or pipes", () => {
    const result = spawnSync("sh", ["-c", installedCommand().script, "kandelo-preview", "http://localhost:3000/"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("standard output must be an attached Kandelo terminal");
  });

  it("reports invalid argument counts", () => {
    for (const args of [[], ["first", "second"]]) {
      const result = spawnSync("sh", ["-c", installedCommand().script, "kandelo-preview", ...args], { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Usage:");
    }
  });
});
