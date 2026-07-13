import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "../..");
const resolveBinaryScript = join(repoRoot, "scripts/resolve-binary.sh");

const SDL_DSP_FIXTURES = [
  "programs/sdl-dsp-test/sdl2-dsp-test.wasm",
  "programs/sdl-dsp-test/sdl3-dsp-test.wasm",
] as const;

function binaryResolves(relativePath: string): boolean {
  try {
    execFileSync("bash", [resolveBinaryScript, relativePath], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Materialize the upstream-SDL integration fixtures through the normal
 * package resolver. This helper is imported only by audio-integration.test.ts
 * so unrelated focused Vitest runs do not build SDL.
 */
export function ensureSdlDspFixtures(): void {
  const rustcVersion = execFileSync("rustc", ["-vV"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const hostTarget = /^host:\s*(\S+)$/m.exec(rustcVersion)?.[1];
  if (!hostTarget) {
    throw new Error(
      "[audio-integration] rustc -vV did not report a host target",
    );
  }

  // Always enter through the resolver. It owns dependency and source/cache
  // invalidation; merely accepting an old output symlink could run stale SDL
  // fixtures after package metadata, patches, or the cache key changes.
  console.log("[audio-integration] Resolving SDL2/SDL3 /dev/dsp fixtures...");
  execFileSync(
    "cargo",
    [
      "run",
      "-p",
      "xtask",
      "--target",
      hostTarget,
      "--quiet",
      "--",
      "build-deps",
      "resolve",
      "sdl-dsp-test",
      "--arch",
      "wasm32",
      "--binaries-dir",
      join(repoRoot, "binaries"),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );

  for (const fixture of SDL_DSP_FIXTURES) {
    if (!binaryResolves(fixture)) {
      throw new Error(
        `[audio-integration] package resolver did not materialize ${fixture}`,
      );
    }
  }
}
