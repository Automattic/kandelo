/**
 * Node has no GLES renderer (D-37). Exercise the ordinary SDL playground's
 * clean refusal at EGL admission; a headless fake cannot validate its editor,
 * shaders or rendered audio. Real rendering lives in kandelo-sdl2.spec.ts,
 * and sdl2-editor-unit.test.ts retains the native editor-logic checks.
 */
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";

it("SDL2 playground reports the Node renderer boundary before editor startup", async () => {
  let stdout = "", stderr = "";
  const diagnostics: string[] = [];
  const host = new NodeKernelHost({
    onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
    onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    onHostDiagnostic: diagnostic => diagnostics.push(diagnostic.message),
  });
  try {
    await host.init();
    host.setInputCanvasDims(1280, 720);
    const bytes = readFileSync(resolveBinary("programs/sdl2.wasm"));
    const code = await host.spawn(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      ["sdl2"],
      { ownedJob: { id: "sdl2-node-renderer-boundary", timeoutMs: 15_000 } },
    );
    expect(code, `${stdout}\n${stderr}`).toBe(1);
    expect(stdout).toContain("sdl2: SDL_Init OK");
    expect(stderr).toContain("eglInitialize: no GLES renderer is available on this host");
    expect(stderr).toContain("FAIL: SDL_CreateWindow: Can't load EGL/GL library on window creation.");
    expect(stdout).not.toContain("sdl2: editor loaded");
    expect(stdout).not.toContain("sdl2: OK frames=");
    expect(diagnostics).toEqual([]);
  } finally { await host.destroy(); }
}, 30_000);
