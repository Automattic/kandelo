import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function xtask(args: string[]): string {
  const hostTarget = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .match(/^host: (\S+)$/m)?.[1];
  if (!hostTarget) throw new Error("could not determine the Rust host target");
  return execFileSync(
    "cargo",
    ["run", "-p", "xtask", "--target", hostTarget, "--quiet", "--", ...args],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

export function resolvePackagePrefix(name: string): string {
  xtask(["build-deps", "resolve", name, "--arch", "wasm32"]);
  return xtask(["build-deps", "--arch", "wasm32", "path", name]);
}
