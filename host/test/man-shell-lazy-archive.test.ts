import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { ClosedLazyAsset } from "../src/vfs/closed-lazy-assets";

// End-to-end Node-host proof that `man ls` and `man lsof` render real,
// mandoc-formatted manual pages inside a booted Kandelo shell — the first
// exercise of mandoc's `man` name-lookup front-end (as opposed to Task 1's
// direct `mandoc -Tascii` invocation, which never reaches that code path).
//
// This boots the exact `shell.vfs.zst` product artifact and binds the three
// lazy-archives it declares (`man.zip`, `coreutils-docs.zip`,
// `lsof-docs.zip`) offline via `rootfsLazyAssets`, so the test never touches
// the network and fails loudly if the recorded archive integrity drifts
// from the bytes on disk.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const kernelPath = tryResolveBinary("kernel.wasm");

// The shell product and its lazy-archives are resolved directly from the
// source-only-v1 tree rather than through `resolveBinary`: the shell
// composite image (`shell.vfs.zst`) is not itself a declared package
// output with a stable cross-tier identity, so the general resolver
// rejects mixing the mutable source-only-v1 tier with other tiers for it.
// Reading the known build location directly matches how the plan's task
// brief and Task 1-11 reports describe verifying this artifact.
const sourceOnlyProgramsDir = join(
  repoRoot,
  "local-binaries/source-only-v1/programs/wasm32",
);
const shellImagePath = join(sourceOnlyProgramsDir, "shell.vfs.zst");
const ARCHIVE_NAMES = ["man.zip", "coreutils-docs.zip", "lsof-docs.zip"] as const;
const archivePaths = ARCHIVE_NAMES.map((name) =>
  join(sourceOnlyProgramsDir, name)
);

const haveKernel = kernelPath !== null;
const haveShellImage = existsSync(shellImagePath);
const haveArchives = archivePaths.every(existsSync);
const available = haveKernel && haveShellImage && haveArchives;

// Offline binding base. `shell.vfs.zst`'s lazy-archive entries store bare,
// image-relative URLs (e.g. "man.zip") that `rootfsLazyUrlBase` rewrites to
// an absolute canonical HTTPS URL before the closed, in-memory lazy fetcher
// is consulted — no request ever leaves the process.
const LAZY_URL_BASE = "https://kandelo.invalid/";

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function closedLazyAsset(name: string): ClosedLazyAsset {
  const bytes = new Uint8Array(
    readFileSync(join(sourceOnlyProgramsDir, name)),
  );
  return {
    url: `${LAZY_URL_BASE}${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    bytes,
  };
}

// mandoc's ASCII renderer marks bold/underlined text (section headers,
// command names, ...) with classic nroff/groff backspace-overstrike
// (`X\bX`), exactly like `mandoc -Tascii` output normally consumed through
// `col -b` or a pager. Task 1's smoke test hit the same thing. Strip it so
// assertions read the same text a human would see on screen.
function stripOverstrike(text: string): string {
  return text.replace(/.\x08/g, "");
}

describe.skipIf(!available)(
  "man ls / man lsof render real manual pages (Node-host, offline)",
  () => {
    it("renders coreutils ls(1) through mandoc's man front-end", async () => {
      const { stdout, stderr, exitCode } = await runManCommand("man ls");
      expect(exitCode, `man ls stderr:\n${stderr}`).toBe(0);
      const rendered = stripOverstrike(stdout);

      // Proof of real rendering: text derived from `ls --help`/coreutils'
      // ls.1 DESCRIPTION section, not the raw troff source.
      expect(rendered).toMatch(/\bNAME\b/);
      expect(rendered).toMatch(/\bSYNOPSIS\b/);
      expect(rendered).toMatch(/\bDESCRIPTION\b/);
      expect(rendered).toContain(
        "List information about the FILEs",
      );
      expect(rendered).not.toContain(".TH");
      expect(rendered).not.toContain(".SH");
    }, 60_000);

    it("renders lsof(8) through mandoc's man front-end", async () => {
      const { stdout, stderr, exitCode } = await runManCommand("man lsof");
      expect(exitCode, `man lsof stderr:\n${stderr}`).toBe(0);
      const rendered = stripOverstrike(stdout);

      expect(rendered).toMatch(/\bNAME\b/);
      expect(rendered).toMatch(/lsof/);
      expect(rendered).toMatch(/list open files/);
      expect(rendered).not.toContain(".TH");
      expect(rendered).not.toContain(".SH");
    }, 60_000);

    // The pre-built, combined mandoc.db shipped by the `mandoc-db` package
    // (staged eagerly at /usr/share/man/mandoc.db) means mandoc's `man`
    // front-end no longer warns that the database is missing or stale. That
    // warning ("outdated mandoc.db lacks ls(1) entry") was the visible symptom
    // of an image with man pages but no index. Its absence proves the eager db
    // matches the lazily-mounted pages.
    it("resolves man ls without an outdated-mandoc.db warning", async () => {
      const { stderr, exitCode } = await runManCommand("man ls");
      expect(exitCode, `man ls stderr:\n${stderr}`).toBe(0);
      expect(stderr).not.toMatch(/outdated mandoc\.db/);
      expect(stderr).not.toMatch(/lacks .*entry/);
    }, 60_000);
  },
);

// The `mandoc-db` package builds one combined whatis/apropos index over every
// shipped -docs archive with the host `makewhatis`, then stages it eagerly so
// name-lookup (`whatis`) and keyword-search (`apropos` / `man -k`) work the
// moment the shell boots — without ever running `makewhatis` inside the guest.
// These front-ends read /usr/share/man/mandoc.db directly; the pages
// themselves stay lazily mounted from coreutils-docs.zip / lsof-docs.zip.
describe.skipIf(!available)(
  "whatis / apropos read the combined mandoc.db (Node-host, offline)",
  () => {
    it("whatis reports the exact coreutils ls(1) NAME line", async () => {
      const { stdout, stderr, exitCode } = await runManCommand("whatis ls");
      expect(exitCode, `whatis ls stderr:\n${stderr}`).toBe(0);
      // mandoc whatis prints "ls (1) - list directory contents".
      expect(stdout).toMatch(/ls\s*\(1\)\s*-\s*list directory contents/);
    }, 60_000);

    it("apropos finds ls by keyword out of the shared index", async () => {
      const { stdout, stderr, exitCode } = await runManCommand("apropos ls");
      expect(exitCode, `apropos ls stderr:\n${stderr}`).toBe(0);
      expect(stdout).toMatch(/ls\s*\(1\)\s*-\s*list directory contents/);
    }, 60_000);

    it("man -k searches the same index as apropos", async () => {
      const { stdout, stderr, exitCode } =
        await runManCommand("man -k lsof");
      expect(exitCode, `man -k lsof stderr:\n${stderr}`).toBe(0);
      // lsof(8) is indexed from lsof-docs.zip, proving the db spans every
      // -docs archive, not just coreutils.
      expect(stdout).toMatch(/lsof\s*\(8\)\s*-\s*.*list open files/);
    }, 60_000);
  },
);

async function runManCommand(
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
  const shellImageBytes = new Uint8Array(readFileSync(shellImagePath));

  let stdout = "";
  let stderr = "";
  const host = new NodeKernelHost({
    // `MemoryFileSystem.fromImage` (used internally by the worker) detects
    // the zstd magic and decompresses transparently — the compressed
    // `.zst` product bytes are handed over exactly as built.
    rootfsImage: shellImageBytes,
    rootfsLazyUrlBase: LAZY_URL_BASE,
    rootfsLazyAssets: ARCHIVE_NAMES.map(closedLazyAsset),
    onStdout: (_pid, bytes) => {
      stdout += new TextDecoder().decode(bytes);
    },
    onStderr: (_pid, bytes) => {
      stderr += new TextDecoder().decode(bytes);
    },
  });

  try {
    await host.init(asArrayBuffer(kernelBytes));
    // Bash is baked eagerly into the shell image at /usr/bin/bash (not a
    // lazy-archive member), so spawning it by VFS path never touches the
    // closed lazy fetcher. `-lc` makes bash a login shell that sources
    // /etc/profile, which in turn sources /etc/profile.d/man.sh — the
    // script that exports MANPAGER=cat and MANPATH=/usr/share/man so
    // mandoc's `man` front-end renders inline (this Node-host spawn has no
    // pty, so stdout is already a non-tty and mandoc would not fork a
    // pager regardless).
    const { exit } = await host.spawnFromVfs(
      "/usr/bin/bash",
      ["bash", "-lc", command],
      {
        env: ["HOME=/home/maker", "USER=maker", "LOGNAME=maker"],
        uid: 1000,
        gid: 1000,
      },
    );
    const exitCode = await exit;
    return { stdout, stderr, exitCode };
  } finally {
    await host.destroy().catch(() => {});
  }
}
