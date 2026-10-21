import { test, expect } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { makeHostScratchTempRoot } from "./centralized-test-helper";

test("LÖVE headless audio API uses the paced Node device", async () => {
  const root = makeHostScratchTempRoot("love-audio-");
  let stdout = "", stderr = "";
  const diagnostics: string[] = [];
  const host = new NodeKernelHost({
    onStdout: (_, bytes) => { stdout += new TextDecoder().decode(bytes); },
    onStderr: (_, bytes) => { stderr += new TextDecoder().decode(bytes); },
    onHostDiagnostic: diagnostic => diagnostics.push(diagnostic.message),
  });
  try {
    // Stage only the packaged fixture and its WAV/Vorbis inputs. This is the
    // same Lua consumer used in browsers, not a replacement audio backend.
    const inputs = /^share\/love\/examples\/(audio-check\/[^/]+|sounds\/score\.wav|bytepath\/resources\/sounds\/keystroke_1\.ogg)$/;
    const archive = unzipSync(
      readFileSync(resolveBinary("programs/love/share/love-examples.zip")),
      { filter: file => inputs.test(file.name) },
    );
    for (const [name, bytes] of Object.entries(archive)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    await host.init();
    const bytes = readFileSync(resolveBinary("programs/love/love.wasm"));
    const code = await host.spawn(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      ["love", join(root, "share/love/examples/audio-check")],
      { env: ["SDL_AUDIODRIVER=dsp"], ownedJob: { id: "love-audio-api", timeoutMs: 45_000 } },
    );
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("love: audio API checks passed");
    expect(stderr).toContain("graphics and window modules disabled by conf.lua");
    expect(stderr).toContain("love: audio output via SDL2/dsp on /dev/dsp");
    expect(diagnostics).toEqual([]);
  } finally {
    await host.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);


test("LÖVE reports an unavailable graphics context without trapping", async () => {
  const root = makeHostScratchTempRoot("love-no-graphics-");
  writeFileSync(join(root, "main.lua"), 'error("main must not run without graphics")');
  let stderr = "";
  const diagnostics: string[] = [];
  const host = new NodeKernelHost({
    onStderr: (_, bytes) => { stderr += new TextDecoder().decode(bytes); },
    onHostDiagnostic: diagnostic => diagnostics.push(diagnostic.message),
  });
  try {
    await host.init();
    const bytes = readFileSync(resolveBinary("programs/love/love.wasm"));
    const code = await host.spawn(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      ["love", root],
      { ownedJob: { id: "love-graphics-capability", timeoutMs: 15_000 } },
    );
    expect(code, stderr).toBe(1);
    expect(stderr).toContain("an active OpenGL ES context is required for graphics");
    expect(stderr).not.toContain("main must not run");
    expect(diagnostics).toEqual([]);
  } finally {
    await host.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
