import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { SHELL_LAZY_ARCHIVE_SPECS } from "../../images/vfs/scripts/shell-lazy-archives";
import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { ClosedLazyAsset } from "../src/vfs/closed-lazy-assets";

// End-to-end Node-host proof that every manual page a shell image carries
// renders through mandoc's `man` name-lookup front-end inside a booted
// Kandelo shell, faulting its docs archive in on first read.
//
// The image under test is, in order of preference:
//
//  - the worktree's partial image (`./run.sh partial shell
//    mandoc-browser-bundle bash-docs ...`), when its selection includes the
//    man viewer. Lazy archives resolve through the Node host's repository
//    resolver, as a developer's shell would.
//  - the canonical source-only `shell.vfs.zst`, with every docs archive it
//    declares bound offline via `rootfsLazyAssets`, so the test never
//    touches the network and fails loudly if recorded archive integrity
//    drifts from the bytes on disk.
//
// The page list is read from the image's own /usr/share/man tree, so a new
// docs package is covered without editing this file.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const kernelPath = tryResolveBinary("kernel.wasm");

const partialDir = join(repoRoot, "local-binaries/partial");
const partialManifestPath = join(partialDir, "partial.json");
const partialManifest: { file: string; selection: string[] } | null =
  existsSync(partialManifestPath)
    ? JSON.parse(readFileSync(partialManifestPath, "utf8"))
    : null;
const usePartial =
  partialManifest?.selection.includes("mandoc-browser-bundle") === true;

// The canonical shell product and its lazy archives are read directly from
// the source-only-v1 tree rather than through `resolveBinary`: the shell
// composite image is not itself a declared package output with a stable
// cross-tier identity, so the general resolver rejects mixing the mutable
// source-only-v1 tier with other tiers for it.
const sourceOnlyProgramsDir = join(
  repoRoot,
  "local-binaries/source-only-v1/programs/wasm32",
);
const MAN_ARCHIVES = SHELL_LAZY_ARCHIVE_SPECS.filter(
  (spec) => spec.id === "man" || spec.id.endsWith("-docs"),
).map((spec) => spec.resolverPath.replace(/^programs\/wasm32\//, ""));

// The man-page index is a lazy file beside the archives; bind it too when
// the image under test carries one.
const MAN_INDEX = "man-index.db";
const MAN_ASSETS = existsSync(join(sourceOnlyProgramsDir, MAN_INDEX))
  ? [...MAN_ARCHIVES, MAN_INDEX]
  : MAN_ARCHIVES;

const shellImagePath = usePartial
  ? join(partialDir, partialManifest!.file)
  : join(sourceOnlyProgramsDir, "shell.vfs.zst");
const available =
  kernelPath !== null &&
  existsSync(shellImagePath) &&
  (usePartial ||
    MAN_ARCHIVES.every((name) => existsSync(join(sourceOnlyProgramsDir, name))));

// Offline binding base for the canonical image. Its lazy archives record
// their package-mirror path (e.g. "kandelo-lazy:programs/wasm32/man.zip"),
// which `rootfsLazyAssetDirectory` resolves to
// `<base>assets/programs/wasm32/man.zip` before the closed, in-memory lazy
// fetcher is consulted. No request ever leaves the process.
const LAZY_URL_BASE = "https://kandelo.invalid/";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

interface ManPage {
  section: string;
  name: string;
  /** For an alias page, the page it links to (same section). */
  target: string | null;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function closedLazyAsset(name: string): ClosedLazyAsset {
  const bytes = new Uint8Array(readFileSync(join(sourceOnlyProgramsDir, name)));
  return {
    url: `${LAZY_URL_BASE}assets/programs/wasm32/${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    bytes,
  };
}

function imageHasIndex(imageBytes: Uint8Array): boolean {
  const fs = KandeloImageFs.create();
  fs.loadImage(imageBytes);
  try {
    fs.lstat("/usr/share/man/mandoc.db");
    return true;
  } catch {
    return false;
  }
}

function imagePages(imageBytes: Uint8Array): ManPage[] {
  const fs = KandeloImageFs.create();
  fs.loadImage(imageBytes);
  const pages: ManPage[] = [];
  for (const dir of fs.readDirNames("/usr/share/man").sort()) {
    const match = /^man([1-9])$/.exec(dir);
    if (!match) continue;
    for (const file of fs.readDirNames(`/usr/share/man/${dir}`).sort()) {
      const name = new RegExp(`^(.+)\\.${match[1]}$`).exec(file)?.[1];
      if (!name) continue;
      const path = `/usr/share/man/${dir}/${file}`;
      const isLink = (fs.lstat(path).mode & S_IFMT) === S_IFLNK;
      const target = isLink ? fs.readlink(path).replace(/\.[1-9]$/, "") : null;
      pages.push({ section: match[1], name, target });
    }
  }
  return pages;
}

// mandoc's ASCII renderer marks bold/underlined text with classic nroff
// backspace-overstrike (`X\bX`). Strip it so assertions read the text a
// human sees on screen.
function stripOverstrike(text: string): string {
  return text.replace(/.\x08/g, "");
}

describe.skipIf(!available)(
  "every shell manual page renders through man (Node-host)",
  () => {
    const imageBytes = () => new Uint8Array(readFileSync(shellImagePath));

    it("renders each page, and each alias as the page it names", async () => {
      const pages = imagePages(imageBytes());
      expect(pages.length, "no pages under /usr/share/man").toBeGreaterThan(0);
      const indexed = imageHasIndex(imageBytes());

      // The commands go to bash as its -c argument, so they run in batches to
      // stay under the argument-size limit (several hundred pages fail with
      // E2BIG as one script).
      const BATCH = 100;
      let stdout = "";
      for (let start = 0; start < pages.length; start += BATCH) {
        const script = pages
          .slice(start, start + BATCH)
          .map(
            ({ section, name }) =>
              `printf '\\n@@BEGIN %s %s\\n' ${section} '${name}'; ` +
              `man ${section} '${name}' 2>/tmp/man.err; rc=$?; ` +
              `printf '\\n@@ERR\\n'; cat /tmp/man.err; ` +
              `printf '\\n@@END %s\\n' "$rc"`,
          )
          .join("\n");
        const batch = await runInShell(imageBytes(), script);
        expect(batch.exitCode, `stderr:\n${batch.stderr}`).toBe(0);
        stdout += batch.stdout;
      }

      const rendered = new Map<string, string>();
      const failures: string[] = [];
      const blocks = stdout.split("\n@@BEGIN ").slice(1);
      for (const block of blocks) {
        const header = block.slice(0, block.indexOf("\n"));
        const errAt = block.lastIndexOf("\n@@ERR\n");
        const end = block.lastIndexOf("\n@@END ");
        const status = block.slice(end + "\n@@END ".length).trim();
        const text = stripOverstrike(block.slice(header.length + 1, errAt));
        const err = block.slice(errAt + "\n@@ERR\n".length, end).trim();
        rendered.set(header, text);
        // mandoc 1.14.6 warns whenever it has to find a page by searching
        // the manpath. With the man-page index (man-index) every page is in
        // mandoc.db, so `man` must be silent; an image without the index
        // (a partial image without every docs package) may only warn.
        const unexpected = err
          .split("\n")
          .filter((line) => line !== "" && (indexed
            || !/^man: outdated mandoc\.db lacks \S+ entry, run makewhatis \/usr\/share\/man$/.test(line)));
        if (status !== "0") failures.push(`${header}: man exited ${status}: ${err.slice(0, 200)}`);
        else if (unexpected.length > 0) failures.push(`${header}: ${unexpected.join("; ").slice(0, 200)}`);
        // Case-insensitive: docutils' manpage writer (sfwbar's pages) emits
        // `.SH Name`, which mandoc renders as written.
        else if (!/^NAME$/im.test(text)) failures.push(`${header}: no NAME section`);
        else if (/^\.(TH|SH|Dd|Dt|so) /m.test(text)) failures.push(`${header}: raw roff in output`);
      }
      expect(blocks.length).toBe(pages.length);
      expect(failures).toEqual([]);

      for (const page of pages.filter((p) => p.target !== null)) {
        expect(
          rendered.get(`${page.section} ${page.name}`),
          `${page.name}(${page.section}) is an alias of ${page.target}`,
        ).toBe(rendered.get(`${page.section} ${page.target}`));
      }
    }, 900_000);

    it("renders the text of the program's own manual", async () => {
      const pages = new Set(imagePages(imageBytes()).map((p) => `${p.section} ${p.name}`));
      const probes: [string, RegExp][] = [
        ["1 ls", /List information about the FILEs/],
        ["8 lsof", /list open files/],
        ["1 bash", /GNU Bourne-Again SHell/],
        ["1 sh", /GNU Bourne-Again SHell/],
        ["1 grep", /print lines that match patterns/],
        ["1 unxz", /Compress or decompress \.xz and\s+\.lzma files/],
        ["1 man", /display manual pages/],
        ["1 curl", /transfer a URL/],
        ["1 wget", /The non-interactive network downloader/],
        ["1 perlfunc", /Perl builtin functions/],
      ];
      const present = probes.filter(([page]) => pages.has(page));
      expect(present.length).toBeGreaterThan(0);
      const script = present
        .map(([page]) => `printf '\\n@@BEGIN %s\\n' '${page}'; man ${page} 2>/dev/null`)
        .join("\n");
      const { stdout } = await runInShell(imageBytes(), script);
      for (const [page, text] of present) {
        const block = stripOverstrike(stdout.split(`\n@@BEGIN ${page}\n`)[1] ?? "");
        expect(block.split("\n@@BEGIN ")[0], `man ${page}`).toMatch(text);
      }
    }, 300_000);

    it.skipIf(!available || !imageHasIndex(new Uint8Array(readFileSync(shellImagePath))))(
      "searches the index with whatis and apropos",
      async () => {
        const { stdout, stderr, exitCode } = await runInShell(
          imageBytes(),
          "whatis grep; whatis 5 nanorc; apropos -s 1 decompress",
        );
        expect(exitCode, `stderr:\n${stderr}`).toBe(0);
        expect(stderr).toBe("");
        expect(stdout).toMatch(/^grep\(1\) - print lines that match patterns$/m);
        expect(stdout).toMatch(/^nanorc\(5\) - /m);
        // apropos lists all of a page's names, aliases included.
        expect(stdout).toMatch(/^xz, [^(]*\bunxz\b[^(]*\(1\) - Compress or decompress/m);
      },
      120_000,
    );
  },
);

async function runInShell(
  imageBytes: Uint8Array,
  script: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const host = new NodeKernelHost({
    // `MemoryFileSystem.fromImage` (used internally by the worker) detects
    // the zstd magic and decompresses transparently.
    rootfsImage: imageBytes,
    ...(usePartial
      ? {}
      : {
          rootfsLazyUrlBase: LAZY_URL_BASE,
          rootfsLazyAssetDirectory: LAZY_URL_BASE,
          rootfsLazyAssets: MAN_ASSETS.map(closedLazyAsset),
        }),
    onStdout: (_pid, bytes) => {
      stdout += decoder.decode(bytes, { stream: true });
    },
    onStderr: (_pid, bytes) => {
      stderr += decoder.decode(bytes, { stream: true });
    },
  });

  try {
    await host.init(asArrayBuffer(kernelBytes));
    // `-lc` makes bash a login shell that sources /etc/profile, which in
    // turn sources /etc/profile.d/man.sh for MANPATH=/usr/share/man.
    // MANPAGER=cat after it renders inline instead of through less.
    const { exit } = await host.spawnFromVfs(
      "/bin/bash",
      ["bash", "-lc", `export MANPAGER=cat\n${script}`],
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
