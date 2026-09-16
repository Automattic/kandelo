/**
 * An image written by the RUST writer boots, and its deferred files are
 * fetchable.
 *
 * This covers a seam nothing else did. Every other Node runtime test builds its
 * fixture with `MemoryFileSystem`, which emits `KLZY` — so when `tools/mkrootfs`
 * moved to the Rust writer and began emitting `SDEF`, the whole suite stayed
 * green while no test anywhere booted the format the rootfs image now ships in.
 *
 * The gap was not hypothetical: it let a wrong diagnosis stand for an hour. A
 * scratch harness that passed no `rootfsImage` was reading the MACHINE's `/bin`
 * (`/bin/launchctl` in the listing), and its `Exec format error` was read as
 * evidence about SDEF. A test in the repo, driven the way the real host is
 * driven, is what that hour was missing.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import { SffsImageFs } from "../../images/vfs/lib/sffs-image-fs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { buildImage } from "../../tools/mkrootfs/src/builder";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const kernel = [
  join(repoRoot, "local-binaries/kernel.wasm"),
  join(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"),
].find(existsSync) ?? join(repoRoot, "local-binaries/kernel.wasm");
const dash = join(repoRoot, "binaries/programs/wasm32/dash.wasm");
const available = [kernel, dash].every(existsSync);

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe.skipIf(!available)("an SDEF image at runtime", () => {
  it("carries its deferred files' real size and address into the kernel", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "kandelo-sdef-runtime-"));
    try {
      const payload = new TextEncoder().encode("the deferred bytes themselves");
      const artifact = join(tmp, "tool.wasm");
      writeFileSync(artifact, payload);
      const digest = createHash("sha256").update(payload).digest("hex");

      const manifest = join(tmp, "MANIFEST");
      writeFileSync(
        manifest,
        [
          "/ d 0755 0 0",
          "/bin d 0755 0 0",
          `/bin/tool f 0755 0 0 lazy_url=tool.wasm lazy_size=${payload.byteLength} lazy_sha256=${digest}`,
          "",
        ].join("\n"),
      );
      const image = await buildImage({ sourceTree: tmp, manifest, repoRoot: tmp });

      // The format the Rust writer emits, asserted rather than assumed — if
      // this ever says KLZY the rest of the test is measuring something else.
      expect(Buffer.from(image).toString("latin1")).toContain("SDEF");

      // And the kernel's own loader reads all three facts back out of it.
      const reader = SffsImageFs.create();
      reader.loadImage(image);
      const [file] = reader.lazyEntries().files;
      expect(file.path).toBe("/bin/tool");
      expect(file.size).toBe(payload.byteLength);
      expect(file.uri).toBe("tool.wasm");
      expect(Array.from(file.digest, (b) => b.toString(16).padStart(2, "0")).join(""))
        .toBe(digest);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("boots, and the kernel reports a deferred file's real length", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "kandelo-sdef-boot-"));
    try {
      const payload = new Uint8Array(4242).fill(7);
      writeFileSync(join(tmp, "tool.wasm"), payload);
      const manifest = join(tmp, "MANIFEST");
      writeFileSync(
        manifest,
        [
          "/ d 0755 0 0",
          "/bin d 0755 0 0",
          `/bin/tool f 0755 0 0 lazy_url=tool.wasm lazy_size=${payload.byteLength}`,
          "",
        ].join("\n"),
      );
      const image = await buildImage({ sourceTree: tmp, manifest, repoRoot: tmp });

      const dashBytes = new Uint8Array(readFileSync(dash));
      let stdout = "";
      const host = new NodeKernelHost({
        rootfsImage: image,
        execPrograms: { "/bin/sh": dashBytes, "/bin/dash": dashBytes },
        onStdout: (_pid, bytes) => {
          stdout += new TextDecoder().decode(bytes);
        },
      });
      try {
        await host.init(arrayBuffer(new Uint8Array(readFileSync(kernel))));
        // `-s` is the question: the body inode is a zero-length stub, and only
        // the deferred record carries the real length. A kernel that could not
        // read SDEF would answer EMPTY here and every lazy binary in the rootfs
        // image would be an empty file.
        await host.spawn(dashBytes, [
          "/bin/sh",
          "-c",
          "if [ -s /bin/tool ]; then echo REAL_LENGTH; else echo EMPTY; fi",
        ], {
          env: ["PATH=/bin", "HOME=/tmp", "TMPDIR=/tmp", "TERM=dumb"],
          cwd: "/",
        });
      } finally {
        await host.destroy().catch(() => {});
      }
      expect(stdout).toContain("REAL_LENGTH");
      expect(stdout).not.toContain("EMPTY");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  // This was `it.fails` — defect B43, pinned rather than hidden — until the URI
  // relay landed. The cause was the host's id->URL table:
  // `configureRootfsOverlay` handed the kernel the image bytes (so the kernel
  // parsed `SDEF` itself and knew the file's real length — `SIZE_OK` proves
  // that), while the table turning a `host_fetch_deferred(kind, id)` back into
  // a URL was built from `baseImage.exportLazyEntries()`, which reads
  // host-side JSON sections an `SDEF` image does not carry. The kernel asked
  // and the host could not answer.
  //
  // Now the kernel names the resource by the URI its own image recorded, so
  // there is no table to be empty. The control below fetches the same bytes
  // through the same transport from a `KLZY` image, which is what keeps this a
  // test of the FORMAT rather than of the harness.
  it("fetches a deferred file's bytes through the host transport", async () => {
    // The other half, and the one B43 was actually about. The kernel knowing a
    // file's length proves it read the section; it does not prove the bytes can
    // be obtained. The kernel asks the host for them, and for an SDEF image the
    // host's lazy table is built from a reader that sees SDEF — if that ever
    // regresses, this is where it shows.
    const tmp = mkdtempSync(join(tmpdir(), "kandelo-sdef-fetch-"));
    try {
      const text = "deferred-bytes-arrived\n";
      const payload = new TextEncoder().encode(text);
      const artifact = join(tmp, "tool.txt");
      writeFileSync(artifact, payload);
      const sha256 = createHash("sha256").update(payload).digest("hex");
      // An absolute URL, because the closed-asset transport validates one: the
      // image names where the bytes are, and the host maps that name to a
      // source it is willing to fetch from.
      const lazyUrl = "https://example.invalid/tool.txt";

      const manifest = join(tmp, "MANIFEST");
      writeFileSync(
        manifest,
        [
          "/ d 0755 0 0",
          "/bin d 0755 0 0",
          `/bin/tool f 0644 0 0 lazy_url=${lazyUrl} lazy_size=${payload.byteLength} lazy_sha256=${sha256}`,
          "",
        ].join("\n"),
      );
      const image = await buildImage({ sourceTree: tmp, manifest, repoRoot: tmp });

      // A loopback server, because the closed-asset transport accepts only a
      // root-relative, HTTPS, or loopback-HTTP source. The image says WHERE the
      // bytes are; this says where the host may actually go and get them, and
      // the two are deliberately different statements.
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-length": String(payload.byteLength) });
        res.end(Buffer.from(payload));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const sourceUrl = `http://127.0.0.1:${port}/tool.txt`;

      const dashBytes = new Uint8Array(readFileSync(dash));
      let stdout = "";
      const host = new NodeKernelHost({
        rootfsImage: image,
        rootfsLazyAssetSources: [{
          url: lazyUrl,
          sourceUrl,
          sha256,
          size: payload.byteLength,
        }],
        execPrograms: { "/bin/sh": dashBytes, "/bin/dash": dashBytes },
        onStdout: (_pid, bytes) => {
          stdout += new TextDecoder().decode(bytes);
        },
      });
      try {
        await host.init(arrayBuffer(new Uint8Array(readFileSync(kernel))));
        // Reading the file is what forces the fetch: the body holds a
        // zero-length stub until the bytes arrive.
        await host.spawn(dashBytes, [
          "/bin/sh",
          "-c",
          "if [ -s /bin/tool ]; then echo SIZE_OK; else echo SIZE_EMPTY; fi; "
            + "if read line < /bin/tool; then echo GOT:$line; else echo READ_FAILED=$?; fi",
        ], {
          env: ["PATH=/bin", "HOME=/tmp", "TMPDIR=/tmp", "TERM=dumb"],
          cwd: "/",
        });
      } finally {
        await host.destroy().catch(() => {});
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      expect(stdout).toContain("GOT:deferred-bytes-arrived");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it("CONTROL: a KLZY image fetches the same bytes the same way", async () => {
    // The control that makes the test above mean something. Same transport,
    // same probe, same loopback source — only the image FORMAT differs. If both
    // fail, the harness is wrong and neither result is about SDEF; if this one
    // passes and the other does not, the format is the cause.
    const text = "deferred-bytes-arrived\n";
    const payload = new TextEncoder().encode(text);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const lazyUrl = "https://example.invalid/tool.txt";

    const memfs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    memfs.mkdirWithOwner("/bin", 0o755, 0, 0);
    memfs.registerLazyFile("/bin/tool", lazyUrl, payload.byteLength, 0o644);
    const image = await memfs.saveImage();
    expect(Buffer.from(image).toString("latin1")).toContain("KLZY");

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-length": String(payload.byteLength) });
      res.end(Buffer.from(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const dashBytes = new Uint8Array(readFileSync(dash));
    let stdout = "";
    const host = new NodeKernelHost({
      rootfsImage: image,
      rootfsLazyAssetSources: [{
        url: lazyUrl,
        sourceUrl: `http://127.0.0.1:${port}/tool.txt`,
        sha256,
        size: payload.byteLength,
      }],
      execPrograms: { "/bin/sh": dashBytes, "/bin/dash": dashBytes },
      onStdout: (_pid, bytes) => {
        stdout += new TextDecoder().decode(bytes);
      },
    });
    try {
      await host.init(arrayBuffer(new Uint8Array(readFileSync(kernel))));
      await host.spawn(dashBytes, [
        "/bin/sh",
        "-c",
        "if [ -s /bin/tool ]; then echo SIZE_OK; else echo SIZE_EMPTY; fi; "
          + "if read line < /bin/tool; then echo GOT:$line; else echo READ_FAILED=$?; fi",
      ], {
        env: ["PATH=/bin", "HOME=/tmp", "TMPDIR=/tmp", "TERM=dumb"],
        cwd: "/",
      });
    } finally {
      await host.destroy().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Recorded as an observation, not asserted: what matters is the COMPARISON
    // with the SDEF case above, and a control that fails is itself the finding.
    console.log("[control KLZY]", JSON.stringify(stdout));
  }, 120_000);
});
