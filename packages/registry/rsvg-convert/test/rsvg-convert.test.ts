import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "../../../../host/test/centralized-test-helper";

/*
 * rsvg-convert, librsvg's command-line converter (a Rust program), turns
 * SVG files into PNG and PDF on the kernel.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../..");
const INCONSOLATA = join(REPO_ROOT, "third_party/Inconsolata-Regular.ttf");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">
  <rect width="40" height="40" fill="#ff0000"/>
  <text x="44" y="28" font-family="Inconsolata" font-size="20">svg</text>
</svg>
`;

// Building needs the dev shell (SDK, cargo).
function hasToolchain(): boolean {
  for (const tool of ["wasm32posix-cc", "cargo"]) {
    try {
      execFileSync(tool, ["--version"], { stdio: "ignore" });
    } catch {
      return false;
    }
  }
  return true;
}

const canBuild = hasToolchain();
let workDir: string | null = null;
let programPath = "";
let confPath = "";

beforeAll(() => {
  if (!canBuild) return;
  const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .split("\n")
    .find((l) => l.startsWith("host: "))!
    .slice(6);
  // The first resolve builds the program (Rust sysroot and crates) and any
  // missing dependency.
  const resolved = execFileSync(
    "cargo",
    ["run", "-q", "-p", "xtask", "--target", host, "--", "build-deps", "resolve", "rsvg-convert"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // resolve prints the package's cache directory.
  programPath = join(resolved.trim().split("\n").pop()!, "rsvg-convert.wasm");
  expect(existsSync(programPath), programPath).toBe(true);

  workDir = makeHostScratchTempRoot("rsvg-convert-");
  const fontDir = join(workDir, "fonts");
  mkdirSync(fontDir);
  mkdirSync(join(workDir, "cache"));
  copyFileSync(INCONSOLATA, join(fontDir, "Inconsolata-Regular.ttf"));
  confPath = join(workDir, "fonts.conf");
  writeFileSync(
    confPath,
    `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>${join(workDir, "cache")}</cachedir>
</fontconfig>
`,
  );
  writeFileSync(join(workDir, "in.svg"), SVG);
}, 2_400_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function rsvgConvert(args: string[]) {
  const result = await runCentralizedProgram({
    programPath,
    argv: ["rsvg-convert", ...args],
    env: [`FONTCONFIG_FILE=${confPath}`],
    timeout: 60_000,
    // No rootfs image: the guest sees the host filesystem.
    useDefaultRootfs: false,
  });
  return {
    result,
    dump: `exit=${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  };
}

describe.skipIf(!canBuild)("rsvg-convert on the kernel", () => {
  it("reports its version", async () => {
    const { result, dump } = await rsvgConvert(["--version"]);
    expect(result.exitCode, dump).toBe(0);
    expect(result.stdout, dump).toContain("rsvg-convert version 2.63.2");
  }, 120_000);

  it("converts SVG to PNG at a requested size", async () => {
    const out = join(workDir!, "out.png");
    const { result, dump } = await rsvgConvert([
      "-w", "240", "-h", "80", "-o", out, join(workDir!, "in.svg"),
    ]);
    expect(result.exitCode, dump).toBe(0);
    const png = readFileSync(out);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    // IHDR: width and height are the big-endian words at offsets 16 and 20.
    expect(png.readUInt32BE(16)).toBe(240);
    expect(png.readUInt32BE(20)).toBe(80);
  }, 120_000);

  it("converts SVG to PDF", async () => {
    const out = join(workDir!, "out.pdf");
    const { result, dump } = await rsvgConvert([
      "-f", "pdf", "-o", out, join(workDir!, "in.svg"),
    ]);
    expect(result.exitCode, dump).toBe(0);
    const pdf = readFileSync(out);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 120_000);

  it("fails on malformed input with an error", async () => {
    const bad = join(workDir!, "bad.svg");
    writeFileSync(bad, "<svg");
    const { result, dump } = await rsvgConvert(["-o", join(workDir!, "bad.png"), bad]);
    expect(result.exitCode, dump).not.toBe(0);
    expect(result.stderr, dump).not.toContain("Unimplemented import");
    expect(result.stderr.length, dump).toBeGreaterThan(0);
  }, 120_000);
});
