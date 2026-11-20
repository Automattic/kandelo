import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";

import { KandeloImageFs } from "../../../../../images/vfs/lib/kandelo-image-fs";
import { ABI_VERSION } from "../../../../../host/src/generated/abi";
import type { DeloPackage, DeloPipeline } from "../src/registry";
import { EMPTY_DELO_PIPELINE } from "../src/draft";
import { parseZipCentralDirectory } from "../../../../../host/src/vfs/zip";
import { buildComputerImage, type ComputerDisk } from "../src/computer-image";
import { DELO_CONFIG_PATH } from "../src/computer-record";

const FOO = new TextEncoder().encode("foo program");
const ARCHIVE = zipSync({ "share/bar/": new Uint8Array(), "share/bar/baz": new TextEncoder().encode("baz") });

const pkg = (name: string, files: DeloPackage["files"]): DeloPackage => ({
  name,
  type: "binary",
  description: name,
  files,
  use: [],
  enable: [],
  provide: [],
  need: [],
  device: [],
});

const plan = (binaries: DeloPackage[], firstProcess: string | null, name = "corge", pipeline: DeloPipeline = EMPTY_DELO_PIPELINE) =>
  ({ name, binaries, description: "garply", pipeline: { name: "waldo", description: "", ...pipeline }, firstProcess, added: binaries.map((entry) => entry.name) });

const PACKAGES = [
  pkg("foo", [{ from: "programs/wasm32/foo.wasm", to: "/usr/bin/foo", mode: "755" }, { to: "/bin/foo", type: "symlink", from: "/usr/bin/foo" }]),
  pkg("bar", [{ type: "directory", from: "programs/wasm32/bar.zip", to: "/usr" }]),
  pkg("qux", [{ to: "/etc/qux", content: "qux\n", mode: "600" }, { from: "https://example.com/qux", to: "/usr/share/qux" }]),
];

const SOURCES: Record<string, Uint8Array<ArrayBuffer>> = {
  "programs/wasm32/foo.wasm": FOO,
  "programs/wasm32/bar.zip": ARCHIVE,
  "https://example.com/qux": new TextEncoder().encode("qux"),
};

const read = async (from: string) => {
  const bytes = SOURCES[from];
  if (bytes === undefined) throw new Error(`no source ${from}`);
  return bytes;
};

const index = async (from: string) => {
  throw new Error(`no archive ${from}`);
};

const SIZES: Record<string, number> = { "programs/wasm32/grault.wasm": 5, "https://example.com/grault.wad": 3 };

const size = async (from: string) => {
  const bytes = SIZES[from];
  if (bytes === undefined) throw new Error(`no size ${from}`);
  return bytes;
};

const sources = { read, index, size };

const mount = ({ image }: Pick<ComputerDisk, "image">) => {
  const fs = KandeloImageFs.create();
  fs.loadImage(image);
  return fs;
};

const text = (fs: KandeloImageFs, path: string) => new TextDecoder().decode(fs.readFile(path));

test("writes every output, the machine and the first process", async () => {
  const fs = mount(await buildComputerImage(plan(PACKAGES, "foo"), sources));
  assert.deepEqual(fs.readFile("/usr/bin/foo"), FOO);
  assert.equal(fs.stat("/usr/bin/foo").mode & 0o7777, 0o755);
  assert.equal(fs.readlink("/bin/foo"), "/usr/bin/foo");
  assert.equal(text(fs, "/usr/share/bar/baz"), "baz");
  assert.equal(text(fs, "/etc/qux"), "qux\n");
  assert.equal(fs.stat("/etc/qux").mode & 0o7777, 0o600);
  assert.equal(text(fs, "/usr/share/qux"), "qux");
  assert.deepEqual(JSON.parse(text(fs, "/etc/kandelo/demo.json")), { version: 1, image: { title: "corge" } });
  assert.deepEqual(JSON.parse(text(fs, "/etc/kandelo/experimental-terminal-session.json")).initial, { path: "/usr/bin/foo", argv: ["foo"], uid: 0, gid: 0 });
  assert.equal(fs.getImageMetadata()?.kernelAbi, ABI_VERSION);
});

test("starts a first process that is a shell as a login shell", async () => {
  const shell = { ...pkg("foo", PACKAGES[0].files), provide: ["init", "shell"] };
  const fs = mount(await buildComputerImage(plan([shell], "foo"), sources));
  assert.deepEqual(JSON.parse(text(fs, "/etc/kandelo/experimental-terminal-session.json")).initial.argv, ["-foo"]);
});

test("refuses a first process that is not installed, or that installs no executable file", async () => {
  await assert.rejects(buildComputerImage({ ...plan([PACKAGES[0]], "foo"), firstProcess: "bar" }, sources), /bar is the first process but is not installed/);
  await assert.rejects(buildComputerImage(plan([PACKAGES[2]], "qux"), sources), /qux is the first process but installs no executable file/);
});

test("refuses an archive entry that escapes its directory, and writes an archive's symlink", async () => {
  const symlink = zipSync({ "fred": [new TextEncoder().encode("/usr/bin/foo"), { os: 3, attrs: (0o120777 << 16) >>> 0 }] });
  const archives = { "programs/wasm32/escape.zip": zipSync({ "../foo": FOO }), "programs/wasm32/link.zip": symlink };
  const fromArchives = async (from: string) => archives[from as keyof typeof archives] ?? read(from);
  const archive = (name: string) => pkg(name, [{ type: "directory", from: `programs/wasm32/${name}.zip`, to: "/opt" }]);
  await assert.rejects(buildComputerImage(plan([archive("escape")], null), { ...sources, read: fromArchives }), /escape: archive entry \.\.\/foo escapes \/opt/);
  const fs = mount(await buildComputerImage(plan([archive("link")], null), { ...sources, read: fromArchives }));
  assert.equal(fs.readlink("/opt/fred"), "/usr/bin/foo");
});

test("an empty draft builds a computer with nothing to run", async () => {
  const fs = mount(await buildComputerImage(plan([], null), sources));
  assert.throws(() => fs.lstat("/etc/kandelo/experimental-terminal-session.json"));
});

test("starts dinit at boot when the disk has its boot service, and declares the web preview port", async () => {
  const dinit = pkg("grault", [{ to: "/etc/dinit.d/boot", content: "type = internal\n" }]);
  const web = { ...pkg("garply", [{ to: "/etc/garply", content: "garply" }]), provide: ["web"] };
  const fs = mount(await buildComputerImage(plan([dinit, web], null), sources));
  assert.deepEqual(JSON.parse(text(fs, "/etc/kandelo/demo.json")), {
    version: 1,
    image: { title: "corge" },
    defaultProfile: "delo",
    profiles: { delo: { init: { program: "/sbin/dinit", args: ["--system", "-p", "/run/dinitctl"], uid: 0, gid: 0 }, web: { requiredPorts: [8080] } } },
  });
});

test("writes a lazy file as its address and the size its server gives, with no digest, and never reads it", async () => {
  const lazy = pkg("grault", [
    { from: "programs/wasm32/grault.wasm", to: "/usr/bin/grault", lazy: true, mode: "755" },
    { to: "/bin/grault", type: "symlink", from: "/usr/bin/grault" },
    { from: "https://example.com/grault.wad", to: "/usr/share/grault.wad", lazy: true },
  ]);
  const fs = mount(await buildComputerImage(plan([lazy], null), sources));
  const files = fs.lazyEntries().files.map(({ path, uri, size, digest }) => ({ path, uri, size, digest: Buffer.from(digest).toString("hex") }));
  assert.deepEqual(files, [
    { path: "/usr/bin/grault", uri: "binaries/programs/wasm32/grault.wasm", size: 5, digest: "0".repeat(64) },
    { path: "/usr/share/grault.wad", uri: "https://example.com/grault.wad", size: 3, digest: "0".repeat(64) },
  ]);
  assert.equal(fs.stat("/usr/bin/grault").mode & 0o7777, 0o755);
  assert.equal(fs.readlink("/bin/grault"), "/usr/bin/grault");
});

test("writes a lazy archive as its members under its address and length, and never reads it", async () => {
  const archive = zipSync({ "share/garply/": new Uint8Array(), "share/garply/waldo": new TextEncoder().encode("waldo") });
  const entries = parseZipCentralDirectory(archive);
  const lazy = pkg("garply", [{ type: "directory", from: "programs/wasm32/garply.zip", to: "/usr", lazy: true }]);
  const listed = async (from: string) => {
    assert.equal(from, "programs/wasm32/garply.zip");
    return { entries, symlinkTargets: new Map<string, string>(), bytes: archive.byteLength };
  };
  const fs = mount(await buildComputerImage(plan([lazy], null), { ...sources, index: listed }));
  const [registered] = fs.lazyEntries().archives;
  assert.equal(registered.uri, "binaries/programs/wasm32/garply.zip");
  assert.equal(registered.bytes, archive.byteLength);
  assert.equal(fs.isPathDeferred("/usr/share/garply/waldo"), true);
  assert.equal(fs.stat("/usr/share/garply/waldo").size, 5);
  const twin = pkg("fred", [{ to: "/usr/share/garply/waldo", content: "fred" }]);
  await assert.rejects(buildComputerImage(plan([twin, lazy], null), { ...sources, index: listed }), /garply: \/usr\/share\/garply\/waldo is already in the computer/);
});

test("adds the pipeline's text to a file a binary or the pipeline wrote, which keeps its mode, and refuses a mode there", async () => {
  const base = pkg("fred", [{ to: "/etc/fred", content: "root\n", mode: "600" }]);
  const pipeline = (...files: DeloPipeline["files"]) => ({ ...EMPTY_DELO_PIPELINE, use: ["fred"], files });
  const both = pipeline({ to: "/etc/fred", content: "plugh\n" }, { to: "/etc/plugh", content: "xyzzy\n", mode: "600" }, { to: "/etc/plugh", content: "thud\n" });
  const fs = mount(await buildComputerImage(plan([base], null, "corge", both), sources));
  assert.equal(text(fs, "/etc/fred"), "root\nplugh\n");
  assert.equal(fs.stat("/etc/fred").mode & 0o7777, 0o600);
  assert.equal(text(fs, "/etc/plugh"), "xyzzy\nthud\n");
  assert.equal(fs.stat("/etc/plugh").mode & 0o7777, 0o600);
  await assert.rejects(buildComputerImage(plan([base], null, "corge", pipeline({ to: "/etc/fred", content: "plugh\n", mode: "644" })), sources), /\/etc\/delo\/config.json: \/etc\/fred keeps the mode fred gave it/);
  const binary = { ...pkg("thud", [{ from: "programs/wasm32/foo.wasm", to: "/etc/fred" }]), use: ["fred"] };
  await assert.rejects(buildComputerImage(plan([base, binary], null), sources), /thud: \/etc\/fred is already in the computer/);
});

test("creates a directory with its owner and mode, which is never the first process", async () => {
  const home = pkg("fred", [
    { to: "/home/fred", type: "directory", owner: "1000:1000" },
    { to: "/srv/fred", type: "directory", mode: "700" },
    { to: "/usr/bin/fred", content: "#!/bin/sh\n", mode: "755" },
  ]);
  const fs = mount(await buildComputerImage(plan([home], "fred"), sources));
  const stat = fs.stat("/home/fred");
  assert.deepEqual([stat.mode & 0o7777, stat.uid, stat.gid], [0o755, 1000, 1000]);
  assert.deepEqual([fs.stat("/srv/fred").mode & 0o7777, fs.stat("/srv/fred").uid], [0o700, 0]);
  assert.equal(JSON.parse(text(fs, "/etc/kandelo/experimental-terminal-session.json")).initial.path, "/usr/bin/fred");
});

test("copies a tree out of a Kandelo image with its modes and owners, reading the image once", async () => {
  const source = pkg("thud", [
    { to: "/srv/fred/index.php", content: "<?php echo 1;\n" },
    { to: "/srv/fred/home.php", type: "symlink", from: "/srv/fred/index.php" },
    { to: "/srv/fred/bin/run", content: "#!/bin/sh\n", mode: "755" },
    { to: "/srv/plugh", content: "plugh", mode: "600" },
    { to: "/srv/fred/data", type: "directory", owner: "1000:1000", mode: "777" },
  ]);
  const { image } = await buildComputerImage(plan([source], null, "thud"), sources);
  let reads = 0;
  const fromImage = async (from: string) => {
    assert.equal(from, "programs/wasm32/fred.vfs.zst");
    reads += 1;
    return new Uint8Array(image);
  };
  const fred = pkg("fred", [
    { from: "programs/wasm32/fred.vfs.zst:/srv/fred", to: "/var/www/fred" },
    { from: "programs/wasm32/fred.vfs.zst:/srv/plugh", to: "/etc/plugh" },
  ]);
  const fs = mount(await buildComputerImage(plan([fred], null), { ...sources, read: fromImage }));
  assert.equal(reads, 1);
  assert.equal(text(fs, "/var/www/fred/index.php"), "<?php echo 1;\n");
  assert.equal(fs.stat("/var/www/fred/bin/run").mode & 0o7777, 0o755);
  assert.equal(fs.readlink("/var/www/fred/home.php"), "/srv/fred/index.php");
  assert.equal(fs.stat("/etc/plugh").mode & 0o7777, 0o600);
  const data = fs.stat("/var/www/fred/data");
  assert.deepEqual([data.mode & 0o7777, data.uid, data.gid], [0o777, 1000, 1000]);
  const kept = pkg("grault", [{ to: "/var/www/fred/data", type: "directory", mode: "700" }]);
  const both = mount(await buildComputerImage(plan([kept, fred], null), { ...sources, read: fromImage }));
  assert.deepEqual([both.stat("/var/www/fred/data").mode & 0o7777, both.stat("/var/www/fred/data").uid], [0o700, 0]);
});

test("refuses to copy a file that is lazy in its image", async () => {
  const lazy = pkg("grault", [{ from: "programs/wasm32/grault.wasm", to: "/srv/grault", lazy: true }]);
  const { image } = await buildComputerImage(plan([lazy], null, "grault"), sources);
  const fromImage = async () => new Uint8Array(image);
  const deferred = pkg("fred", [{ from: "programs/wasm32/fred.vfs.zst:/srv/grault", to: "/srv/fred" }]);
  await assert.rejects(buildComputerImage(plan([deferred], null), { ...sources, read: fromImage }), /fred: \/srv\/grault is lazy in its image and cannot be copied/);
});

test("refuses two packages that claim one path, and a path delo writes", async () => {
  const twin = pkg("garply", [{ to: "/bin/foo", content: "garply" }]);
  await assert.rejects(buildComputerImage(plan([PACKAGES[0], twin], null), sources), /garply: \/bin\/foo is already in the computer/);
  const own = pkg("fred", [{ to: "/etc/kandelo/demo.json", content: "{}" }]);
  await assert.rejects(buildComputerImage(plan([own], null), sources), /fred: \/etc\/kandelo\/demo\.json is a file delo writes itself/);
});

const files = (...list: DeloPipeline["files"]): DeloPipeline => ({ ...EMPTY_DELO_PIPELINE, files: list });

/** The image after a program inside the computer wrote `changes`. */
const edited = async (disk: ComputerDisk, changes: Record<string, string>): Promise<ComputerDisk> => {
  const fs = mount(disk);
  for (const [path, content] of Object.entries(changes)) fs.writeFile(path, new TextEncoder().encode(content));
  return { ...disk, image: await fs.saveImage() };
};

const exists = (fs: KandeloImageFs, path: string) => {
  try {
    fs.lstat(path);
    return true;
  } catch {
    return false;
  }
};

test("writes the config and a record of each step's paths, and nothing for a computer with no first process", async () => {
  const pipeline = files({ to: "/etc/grault", content: "grault" });
  const disk = await buildComputerImage(plan([PACKAGES[0]], null, "corge", pipeline), sources);
  const { written } = disk;
  const fs = mount(disk);
  assert.deepEqual(JSON.parse(text(fs, DELO_CONFIG_PATH)), { description: "garply", pipeline: { name: "waldo", description: "", ...pipeline }, firstProcess: null, added: ["foo"], written });
  assert.deepEqual(Object.keys(written.steps), ["/usr/bin/foo", "/bin/foo", "/etc/grault"]);
  assert.deepEqual(written.steps["/bin/foo"].claims, { "/bin/foo": "foo" });
  assert.deepEqual(written.left, []);
});

test("onto an existing disk, skips an unchanged step, writes a new one, deletes a removed one, rewrites a changed one, and keeps data", async () => {
  const first = await buildComputerImage(plan(PACKAGES, "foo", "corge", files({ to: "/etc/grault", content: "grault" }, { to: "/etc/garply", content: "garply" })), sources);
  const used = await edited(first, { "/etc/grault": "edited", "/etc/waldo": "data" });
  const fs = mount(await buildComputerImage(plan(PACKAGES.slice(0, 2), null, "corge", files({ to: "/etc/grault", content: "grault" }, { to: "/etc/garply", content: "garply 2" }, { to: "/etc/fred", content: "fred" })), sources, used));
  assert.equal(text(fs, "/etc/grault"), "edited");
  assert.equal(text(fs, "/etc/garply"), "garply 2");
  assert.equal(text(fs, "/etc/fred"), "fred");
  assert.equal(text(fs, "/etc/waldo"), "data");
  assert.deepEqual(fs.readFile("/usr/bin/foo"), FOO);
  assert.equal(exists(fs, "/etc/qux"), false);
  assert.equal(exists(fs, "/usr/share/qux"), false);
  assert.equal(exists(fs, "/etc/kandelo/experimental-terminal-session.json"), false);
});

test("rewrites a file and the text the pipeline adds to it together when one of them changes", async () => {
  const base = pkg("fred", [{ to: "/etc/fred", content: "root\n" }]);
  const appending = (content: string) => ({ ...files({ to: "/etc/fred", content }, { to: "/usr/share/bar/baz", content }), use: ["fred", "bar"] });
  const first = await buildComputerImage(plan([base, PACKAGES[1]], null, "corge", appending("plugh\n")), sources);
  const changed = await buildComputerImage(plan([base, PACKAGES[1]], null, "corge", appending("thud\n")), sources, first);
  assert.equal(text(mount(changed), "/etc/fred"), "root\nthud\n");
  assert.equal(text(mount(changed), "/usr/share/bar/baz"), "bazthud\n");
  const removed = mount(await buildComputerImage(plan([base, PACKAGES[1]], null, "corge", { ...EMPTY_DELO_PIPELINE, use: ["fred", "bar"] }), sources, changed));
  assert.equal(text(removed, "/etc/fred"), "root\n");
  assert.equal(text(removed, "/usr/share/bar/baz"), "baz");
});

test("refuses a new step that writes a path already on the disk, by name", async () => {
  const used = await edited(await buildComputerImage(plan([], null), sources), { "/etc/fred": "data" });
  await assert.rejects(buildComputerImage(plan([], null, "corge", files({ to: "/etc/fred", content: "fred" })), sources, used), /\/etc\/delo\/config.json: \/etc\/fred is already in the computer/);
});

test("a removed step leaves its directories, which a step can create again", async () => {
  const first = await buildComputerImage(plan([], null, "corge", files({ to: "/srv/fred", type: "directory" }, { to: "/srv/fred/plugh", content: "plugh" })), sources);
  const gone = await buildComputerImage(plan([], null), sources, first);
  assert.equal(exists(mount(gone), "/srv/fred/plugh"), false);
  assert.equal(exists(mount(gone), "/srv/fred"), true);
  assert.deepEqual(gone.written.left, ["/srv/fred"]);
  const again = mount(await buildComputerImage(plan([], null, "corge", files({ to: "/srv/fred", type: "directory", owner: "1000:1000" })), sources, gone));
  assert.equal(again.stat("/srv/fred").uid, 1000);
});
