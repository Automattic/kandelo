import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../src/binary-resolver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export type LibeventArch = "wasm32" | "wasm64";
const paths = new Map<string, string>();

/** Resolve multi-output artifacts through the package contract. */
export function libeventProgramRelPath(arch: LibeventArch, name: "backend" | "regress"): string {
  const key = `${arch}/${name}`;
  let path = paths.get(key);
  if (!path) {
    const mirrorPath = execFileSync("cargo", [
      "xtask", "build-deps", "--arch", arch, "output-path",
      "libevent-tests", `libevent-${name}.wasm`,
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    path = `programs/${arch}/${mirrorPath}`;
    paths.set(key, path);
  }
  return path;
}

export function libeventProgram(arch: LibeventArch, name: "backend" | "regress"): string {
  return resolveBinary(libeventProgramRelPath(arch, name));
}

export const libeventCases = [
  "main/simpleclose_rw",
  "main/simpleclose_close",
  "main/simpleclose_shutdown",
  "main/simpleclose_close_persist",
  "main/simpleclose_shutdown_persist",
  "main/simpleclose_close_et",
  "main/simpleclose_shutdown_et",
  "main/simpleclose_close_persist_et",
  "main/simpleclose_shutdown_persist_et",
  "et/et",
  "et/et_mix_error",
  "et/et_multiple_events",
];

export const libeventModes = [
  { name: "epoll", env: [] },
  { name: "epoll (with changelist)", env: ["EVENT_EPOLL_USE_CHANGELIST=1"] },
];
