/**
 * The Kandelo exchange userland on the Node host: kxchgd (the agent the
 * kernel starts on demand), its rules, the catch-all `99-save` handler, and
 * kandelo-publish, from the kandelo-exchange package.
 *
 * The image holds the same exchange entries as the base rootfs (MANIFEST,
 * images/rootfs/): the `exchange` group with maker in it, exchange.conf
 * naming maker, the rule directories, and the vendor `99-save` rule. Skips
 * if the package is not built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { ExchangeOfferError } from "../src/exchange-controller";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

const binary = (name: string) => tryResolveBinary(`programs/kandelo-exchange/${name}.wasm`);
const kxchgd = binary("kxchgd");
const save = binary("exchange-save");
const publish = binary("kandelo-publish");
const helper = binary("kandelo-exchange");
const built = Boolean(kxchgd && save && publish && helper);
const rootfs = fileURLToPath(new URL("../../images/rootfs", import.meta.url));
const helloWasm = fileURLToPath(new URL("../../examples/hello.wasm", import.meta.url));
const text = (s: string) => new TextEncoder().encode(s);

async function exchangeImage(): Promise<Uint8Array> {
  const fs = KandeloImageFs.create();
  for (const [dir, uid, gid] of [
    ["/etc", 0, 0],
    ["/etc/kandelo", 0, 0],
    ["/etc/kandelo/exchange-handlers.d", 1000, 120],
    ["/usr", 0, 0],
    ["/usr/bin", 0, 0],
    ["/usr/libexec", 0, 0],
    ["/usr/libexec/kandelo", 0, 0],
    ["/usr/share", 0, 0],
    ["/usr/share/kandelo", 0, 0],
    ["/usr/share/kandelo/exchange-handlers.d", 0, 0],
    ["/home", 0, 0],
    ["/home/maker", 1000, 1000],
  ] as const) {
    fs.mkdirWithOwner(dir, 0o755, uid, gid);
  }
  const file = (path: string, mode: number, bytes: Uint8Array) => fs.createFileWithOwner(path, mode, 0, 0, bytes);
  // The base rootfs's own files, so the test sees what images ship.
  for (const path of ["/etc/passwd", "/etc/group", "/etc/kandelo/exchange.conf"]) {
    file(path, 0o644, new Uint8Array(readFileSync(`${rootfs}${path}`)));
  }
  file(
    "/usr/share/kandelo/exchange-handlers.d/99-save.handler",
    0o644,
    new Uint8Array(readFileSync(`${rootfs}/usr/share/kandelo/exchange-handlers.d/99-save.handler`)),
  );
  file("/usr/libexec/kandelo/exchange-agent", 0o755, new Uint8Array(readFileSync(kxchgd!)));
  file("/usr/libexec/kandelo/exchange-save", 0o755, new Uint8Array(readFileSync(save!)));
  file("/usr/bin/kandelo-publish", 0o755, new Uint8Array(readFileSync(publish!)));
  file("/usr/bin/kandelo-exchange", 0o755, new Uint8Array(readFileSync(helper!)));
  file("/usr/bin/hello", 0o755, new Uint8Array(readFileSync(helloWasm)));
  return fs.saveImage();
}

const decode = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));

describe("Kandelo exchange userland", () => {
  it.skipIf(!built)(
    "saves what no rule takes to ~/Downloads as the handler account, and follows rule changes",
    async () => {
      const host = new NodeKernelHost({ rootfsImage: await exchangeImage() });
      try {
        await host.init();
        const first = await host.exchange.offer([{ name: "notes.txt", source: new Blob(["first"]) }])
          .catch(async (error: Error) => {
            const log = decode(await host.readFileFromVfs("/var/log/kxchgd.log"));
            throw new Error(`${error.message}; consumer ${JSON.stringify(await host.exchange.consumerState())}; log:\n${log}`);
          });
        expect(await first.settled).toEqual({ outcome: "removed", status: "saved to ~/Downloads/notes.txt" });
        expect(decode(await host.readFileFromVfs("/home/maker/Downloads/notes.txt"))).toBe("first");
        // The handler ran as maker, the account exchange.conf names.
        expect(await host.statVfsPath("/home/maker/Downloads/notes.txt")).toMatchObject({ uid: 1000 });

        // A colliding name, a folder, and a stream in one batch.
        const feed = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(text("streamed "));
            controller.enqueue(text("bytes"));
            controller.close();
          },
        });
        const second = await host.exchange.offer([
          { name: "notes.txt", source: new Blob(["second"]) },
          { name: "a.txt", dirs: ["folder"], source: new Blob(["inside"]) },
          { name: "feed.log", source: feed },
        ]);
        expect(await second.settled).toEqual({ outcome: "removed", status: "saved 3 items to ~/Downloads/" });
        expect(decode(await host.readFileFromVfs("/home/maker/Downloads/notes (2).txt"))).toBe("second");
        expect(decode(await host.readFileFromVfs("/home/maker/Downloads/folder/a.txt"))).toBe("inside");
        expect(decode(await host.readFileFromVfs("/home/maker/Downloads/feed.log"))).toBe("streamed bytes");

        // An empty rule in /etc masks the vendor catch-all; the next batch
        // sees it with no restart.
        await host.writeFileToVfs("/etc/kandelo/exchange-handlers.d/99-save.handler", new Uint8Array(0));
        const masked = await host.exchange.offer([{ name: "b.txt", source: new Blob(["b"]) }]);
        expect(await masked.settled).toEqual({ outcome: "removed", status: "no handler: b.txt" });

        // A rule anyone may write is refused, not run.
        await host.writeFileToVfs(
          "/etc/kandelo/exchange-handlers.d/10-unsafe.handler",
          text("kind any\nrun /usr/libexec/kandelo/exchange-save\n"),
          0o666,
        );
        const unsafe = await host.exchange.offer([{ name: "c.txt", source: new Blob(["c"]) }]);
        expect(await unsafe.settled).toEqual({ outcome: "removed", status: "no handler: c.txt" });

        // A safe runtime rule takes effect on the next batch.
        await host.writeFileToVfs(
          "/etc/kandelo/exchange-handlers.d/10-unsafe.handler",
          text("match extension .txt\nrun /usr/libexec/kandelo/exchange-save\n"),
          0o644,
        );
        const restored = await host.exchange.offer([{ name: "d.txt", source: new Blob(["d"]) }]);
        expect(await restored.settled).toEqual({ outcome: "removed", status: "saved to ~/Downloads/d.txt" });
        const nontext = await host.exchange.offer([{ name: "e.bin", source: new Blob(["e"]) }]);
        expect(await nontext.settled).toEqual({ outcome: "removed", status: "no handler: e.bin" });
        expect(host.exchange.stats()).toMatchObject({ sources: 0, batches: 0 });
      } finally {
        await host.destroy();
      }
    },
    90_000,
  );

  it.skipIf(!built)("publishes stored and streamed outputs with kandelo-publish", async () => {
    const host = new NodeKernelHost({ rootfsImage: await exchangeImage() });
    const listening = new AbortController();
    try {
      await host.init();
      const outputs: Record<string, { kind: string; mime?: string; text: string }> = {};
      host.exchange.onOutput(
        async (output) => {
          const body = await new Response(output.read()).text().catch((error: Error) => `ERROR ${error.message}`);
          outputs[output.name] = { kind: output.kind, ...(output.mimeType ? { mime: output.mimeType } : {}), text: body };
        },
        { signal: listening.signal },
      );
      await host.writeFileToVfs("/tmp/report.txt", text("a report"));
      const read = (path: string) => readFileSync(path);
      const program = (path: string) => {
        const bytes = read(path);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      };
      expect(await host.spawn(program(publish!), ["kandelo-publish", "--mime", "text/plain", "/tmp/report.txt"])).toBe(0);
      expect(
        await host.spawn(program(publish!), ["kandelo-publish", "--stream", "--name", "hello.txt", "--", "/usr/bin/hello"]),
      ).toBe(0);
      const deadline = Date.now() + 20_000;
      while (Object.keys(outputs).length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(outputs["report.txt"]).toEqual({ kind: "stored", mime: "text/plain", text: "a report" });
      expect(outputs["hello.txt"]?.kind).toBe("stream");
      expect(outputs["hello.txt"]?.text).toMatch(/^Hello/);
    } finally {
      listening.abort();
      await host.destroy();
    }
  }, 60_000);

  it.skipIf(!built)("does not run as root without saying so in exchange.conf", async () => {
    const host = new NodeKernelHost({ rootfsImage: await exchangeImage() });
    try {
      await host.init();
      await host.writeFileToVfs("/etc/kandelo/exchange.conf", text("user nobody-here\n"));
      const states: unknown[] = [];
      const unsubscribe = host.exchange.onConsumer((state) => states.push(state));
      await expect(
        host.exchange.offer([{ name: "a.txt", source: new Blob(["a"]) }], { consumerTimeoutMs: 1_500 }),
      ).rejects.toSatisfy((error) => error instanceof ExchangeOfferError && error.reason === "consumer-timeout");
      // kxchgd exits EX_CONFIG (78) before opening events: a failure.
      expect(states).toContainEqual(expect.objectContaining({ lastFailure: { exitStatus: 78 } }));
      unsubscribe();
    } finally {
      await host.destroy();
    }
  }, 60_000);

  it.skipIf(!built)("manages rules and sessions with kandelo-exchange", async () => {
    let out = "";
    const host = new NodeKernelHost({
      rootfsImage: await exchangeImage(),
      onStdout: (_pid, data) => { out += new TextDecoder().decode(data); },
    });
    const bytes = readFileSync(helper!);
    const run = (...args: string[]) =>
      host.spawn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ["kandelo-exchange", ...args]);
    try {
      await host.init();
      expect(await run("handler", "add", "20-wad", "--extension", ".wad", "--run", "/usr/libexec/kandelo/exchange-save")).toBe(0);
      expect(await run("handler", "mask", "99-save")).toBe(0);
      out = "";
      expect(await run("handler", "list")).toBe(0);
      expect(out).toMatch(/20-wad\.handler +\/etc\/kandelo\/exchange-handlers\.d +kind=file extension=\.wad +run \/usr\/libexec\/kandelo\/exchange-save/);
      expect(out).toMatch(/99-save\.handler +\/etc\/kandelo\/exchange-handlers\.d +\(masked\)/);
      const wad = await host.exchange.offer([{ name: "doom.wad", source: new Blob(["IWAD"]) }]);
      expect(await wad.settled).toEqual({ outcome: "removed", status: "saved to ~/Downloads/doom.wad" });
      const other = await host.exchange.offer([{ name: "doom.txt", source: new Blob(["x"]) }]);
      expect(await other.settled).toEqual({ outcome: "removed", status: "no handler: doom.txt" });
      expect(await run("handler", "remove", "20-wad")).toBe(0);
      expect(await run("handler", "remove", "20-wad")).toBe(1);
      // `run` holds a session for its command, which sees KANDELO_WORK.
      expect(await run("run", "--", "/usr/bin/hello")).toBe(0);
      expect(await run("ack", "not-an-id")).toBe(64);
    } finally {
      await host.destroy();
    }
  }, 60_000);

  const getfattr = tryResolveBinary("programs/attr/getfattr.wasm");
  const setfattr = tryResolveBinary("programs/attr/setfattr.wasm");
  it.skipIf(!built || !getfattr || !setfattr)("reads and refuses attributes with the attr tools", async () => {
    let out = "";
    let err = "";
    const host = new NodeKernelHost({
      rootfsImage: await exchangeImage(),
      onStdout: (_pid, data) => { out += new TextDecoder().decode(data); },
      onStderr: (_pid, data) => { err += new TextDecoder().decode(data); },
    });
    const listening = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const spawnFile = (path: string, argv: string[]) => {
      const bytes = readFileSync(path);
      return host.spawn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), argv);
    };
    try {
      await host.init();
      let published = false;
      // Hold the lease, so the output stays in outbox/ while the tools look.
      host.exchange.onOutput(async () => { published = true; await held; }, { signal: listening.signal });
      await host.writeFileToVfs("/tmp/report.txt", text("a report"));
      expect(await spawnFile(publish!, ["kandelo-publish", "--mime", "text/plain", "/tmp/report.txt"])).toBe(0);
      while (!published) await new Promise((r) => setTimeout(r, 5));
      const output = "/run/kandelo/exchange/outbox/report.txt";
      out = "";
      expect(await spawnFile(getfattr!, ["getfattr", "-d", output]), err).toBe(0);
      expect(out).toContain('user.mime_type="text/plain"');
      expect(out).toMatch(/user\.kandelo\.id="[0-9a-f-]{36}"/);
      // Published outputs are frozen; elsewhere attributes are unsupported.
      err = "";
      expect(await spawnFile(setfattr!, ["setfattr", "-n", "user.note", "-v", "x", output])).not.toBe(0);
      expect(err).toContain("Operation not permitted");
      err = "";
      expect(await spawnFile(setfattr!, ["setfattr", "-n", "user.note", "-v", "x", "/tmp/report.txt"])).not.toBe(0);
      expect(err).toContain("Not supported");
    } finally {
      release();
      listening.abort();
      await host.destroy();
    }
  }, 60_000);
});
