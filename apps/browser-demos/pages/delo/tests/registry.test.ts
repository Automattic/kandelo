import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  deloBootsDinit,
  deloFileKind,
  deloImageSource,
  deloImages,
  deloLazyStorePaths,
  deloPipelineName,
  deloPipelineNameProblem,
  deloToolFilesOf,
  findDeloImage,
  parseDeloRegistry,
  parseDeloToolFile,
  type DeloPackage,
} from "../src/registry";

const FOO = {
  name: "@foo/bar",
  type: "image",
  description: "foo",
  vfs: "https://foo.test/bar.vfs",
  profile: "bar",
};

const BAZ = {
  name: "@foo/baz",
  type: "app",
  description: "baz",
  url: "https://baz.test/",
};

const QUX = {
  name: "qux",
  type: "binary",
  description: "qux",
  provide: ["shell"],
  files: [{ from: "programs/wasm32/qux.wasm", to: "/bin/qux", mode: "755" }, { to: "/usr/bin/qux", type: "symlink", from: "/bin/qux" }],
};

const QUUX = {
  name: "quux",
  type: "binary",
  description: "quux",
  use: ["qux"],
  need: ["shell"],
  device: ["fb0"],
  files: [{ to: "/etc/quux", mode: "600", content: "quux\n" }],
};

const TOOL = JSON.stringify({
  description: "Qux the bar",
  inputSchema: { type: "object", properties: { bar: { type: "string", description: "The bar" } }, required: ["bar"] },
  command: ["/bin/qux", "{bar}"],
});

const THEME = {
  name: "theme",
  type: "option",
  description: "theme",
  use: ["qux"],
  need: ["shell"],
};

const CORGE = {
  name: "corge",
  type: "pipeline",
  description: "corge",
  use: ["qux"],
  enable: ["theme"],
  provide: ["web"],
  need: ["shell"],
  device: ["fb0"],
  files: [{ to: "/etc/corge", content: "corge\n" }, { to: "/etc/corge", content: "grault\n" }],
};

function parsed(entry: Record<string, unknown>): Record<string, unknown> {
  if (entry.type === "option") return { use: [], need: [], ...entry };
  return { use: [], enable: [], provide: [], need: [], device: [], files: [], ...entry };
}

function validRegistryText(entries: unknown[] = [FOO]): string {
  return JSON.stringify({ schema: 1, entries });
}

function expectRejected(entries: unknown[], message: RegExp): void {
  assert.throws(() => parseDeloRegistry(validRegistryText(entries)), message);
}

function quxWith(files: unknown[]): unknown {
  return parseDeloRegistry(validRegistryText([{ ...QUX, files }])).entries[0];
}

describe("parseDeloRegistry", () => {
  it("parses every entry type and preserves entry order", () => {
    const registry = parseDeloRegistry(validRegistryText([QUX, FOO, THEME, QUUX, CORGE, BAZ]));
    assert.deepEqual(registry, {
      schema: 1,
      entries: [parsed(QUX), FOO, parsed(THEME), parsed(QUUX), parsed(CORGE), BAZ],
    });
  });

  it("rejects a non-object payload", () => {
    assert.throws(() => parseDeloRegistry("[]"), /must be an object/);
  });

  it("rejects an unrecognized top-level key", () => {
    assert.throws(() => parseDeloRegistry(
      JSON.stringify({ schema: 1, entries: [], extra: true }),
    ), /must have exactly these keys/);
  });

  it("rejects a malformed schema version", () => {
    assert.throws(() => parseDeloRegistry(validRegistryText().replace('"schema":1', '"schema":2')), /schema must be 1, got 2/);
  });

  it("rejects an empty entries array", () => {
    expectRejected([], /must not be empty/);
  });

  it("rejects an unknown entry type", () => {
    expectRejected([{ ...FOO, type: "site" }], /entries\[0\]\.type must be "image", "app", "binary", "pipeline", or "option"/);
  });

  it("rejects a binary that enables something", () => {
    expectRejected([{ ...QUX, enable: ["theme"] }, THEME], /entries\[0\] is a binary, which takes no enable: a pipeline does/);
  });

  it("reads a tool file named after the type that writes it, and refuses another name", () => {
    const binary = { ...QUX, files: [{ to: "/etc/mcp/binary_qux.json", content: TOOL }] };
    const pipeline = { name: "corge", type: "pipeline", description: "corge", files: [{ to: "/etc/mcp/pipeline_corge.json", content: TOOL }] };
    assert.deepEqual(parseDeloRegistry(validRegistryText([binary, pipeline])).entries, [parsed(binary), parsed(pipeline)]);
    expectRejected([{ ...QUX, files: [{ to: "/etc/mcp/pipeline_qux.json", content: TOOL }] }], /entries\[0\] writes \/etc\/mcp\/pipeline_qux\.json, but a binary names its tool files \/etc\/mcp\/binary_<name>\.json/);
    expectRejected([{ ...pipeline, files: [{ to: "/etc/mcp/binary_corge.json", content: TOOL }] }], /entries\[0\] writes \/etc\/mcp\/binary_corge\.json, but a pipeline names its tool files \/etc\/mcp\/pipeline_<name>\.json/);
    expectRejected([{ ...QUX, files: [{ to: "/etc/mcp/qux.json", type: "symlink", from: "/bin/qux" }] }], /writes \/etc\/mcp\/qux\.json, but a binary names/);
  });

  it("refuses a tool file that does not parse, or that runs a shell", () => {
    expectRejected([{ ...QUX, files: [{ to: "/etc/mcp/binary_qux.json", content: "{}" }] }], /\/etc\/mcp\/binary_qux\.json/);
    expectRejected([{ ...QUX, files: [{ to: "/etc/mcp/binary_qux.json", content: JSON.stringify({ ...JSON.parse(TOOL), command: "qux {bar}" }) }] }], /binary_qux\.json needs a "command" list: delo runs a tool with no shell/);
  });

  it("lists the tools an entry writes, named after their files", () => {
    const [entry] = parseDeloRegistry(validRegistryText([{ ...QUX, files: [...QUX.files, { to: "/etc/mcp/binary_qux.json", content: TOOL }] }])).entries;
    assert.deepEqual(deloToolFilesOf(entry as DeloPackage), [{ name: "binary_qux", ...JSON.parse(TOOL) }]);
    assert.deepEqual(parseDeloToolFile("/etc/mcp/pipeline_corge.json", TOOL).name, "pipeline_corge");
  });

  it("reads a pipeline that only uses binaries, and refuses a start", () => {
    const pipeline = { name: "corge", type: "pipeline", description: "corge", use: ["qux"] };
    assert.deepEqual(parseDeloRegistry(validRegistryText([QUX, pipeline])).entries[1], parsed(pipeline));
    expectRejected([{ ...pipeline, start: "qux" }, QUX], /entries\[0\] has unknown keys: start/);
  });

  it("knows the entry that writes dinit's boot service", () => {
    const dinit = { ...QUX, name: "dinit", files: [{ to: "/etc/dinit.d/boot", content: "" }] };
    const service = { name: "corge", type: "pipeline", description: "corge", use: ["dinit"], files: [{ to: "/etc/dinit.d/boot", content: "" }] };
    const entries = parseDeloRegistry(validRegistryText([dinit, service, QUX])).entries as DeloPackage[];
    assert.deepEqual(entries.map(deloBootsDinit), [true, true, false]);
  });

  it("rejects an entry with an unrecognized or missing key", () => {
    expectRejected([{ ...FOO, title: "x" }], /entries\[0\] must have exactly these keys: description, name, profile, type, vfs/);
    expectRejected([{ ...BAZ, vfs: FOO.vfs }], /entries\[0\] must have exactly these keys: description, name, type, url/);
    expectRejected([{ ...QUX, outputs: [] }], /entries\[0\] has unknown keys: outputs/);
    expectRejected([{ ...THEME, provide: [] }, QUX], /entries\[0\] has unknown keys: provide/);
    const { description: _, ...noDescription } = QUX;
    expectRejected([noDescription], /entries\[0\]\.description must be a non-empty string/);
  });

  it("rejects an image or app name that is not @scope/name", () => {
    for (const name of ["raytracer", "@foo", "@Foo/bar", "@a/b/c", "@a/", ""]) {
      expectRejected([{ ...FOO, name }], /entries\[0\]\.name must be a lowercase "@scope\/name"/);
      expectRejected([{ ...BAZ, name }], /entries\[0\]\.name must be a lowercase "@scope\/name"/);
    }
  });

  it("rejects a package name that is not a lowercase identifier", () => {
    for (const name of ["@foo/qux", "Qux", ""]) {
      expectRejected([{ ...QUX, name }], /entries\[0\]\.name must be a lowercase identifier/);
    }
  });

  it("rejects an empty description", () => {
    expectRejected([{ ...FOO, description: " " }], /entries\[0\]\.description must be a non-empty string/);
  });

  it("rejects a relative, non-HTTP, or fragment-carrying URL", () => {
    for (const vfs of ["/bar.vfs", "ftp://foo.test/bar.vfs", "not a url", 7]) {
      expectRejected([{ ...FOO, vfs }], /entries\[0\]\.vfs must be an absolute http\(s\) URL/);
    }
    expectRejected([{ ...FOO, vfs: `${FOO.vfs}#bar` }], /entries\[0\]\.vfs must not carry a fragment/);
    expectRejected([{ ...BAZ, url: "/baz" }], /entries\[0\]\.url must be an absolute http\(s\) URL/);
  });

  it("rejects a malformed profile id", () => {
    expectRejected([{ ...FOO, profile: "Foo Bar" }], /entries\[0\]\.profile must be a lowercase identifier/);
  });

  it("rejects a binary without files, and a list that is not an array", () => {
    const { files: _, ...noFiles } = QUX;
    expectRejected([noFiles], /entries\[0\]\.files must be a non-empty array/);
    expectRejected([{ ...QUX, files: [] }], /entries\[0\]\.files must be a non-empty array/);
    expectRejected([{ ...QUX, files: "qux" }], /entries\[0\]\.files must be a non-empty array/);
    expectRejected([{ ...QUX, use: "qux" }], /entries\[0\]\.use must be an array/);
  });

  it("accepts a remote file, an extracted archive, lazy files and a lazy archive", () => {
    const files = [
      { from: "https://foo.test/qux.wad", to: "/usr/share/qux.wad" },
      { type: "directory", from: "programs/wasm32/qux.zip", to: "/usr" },
      { from: "https://foo.test/quux.wad", to: "/usr/share/quux.wad", lazy: true },
      { from: "programs/wasm32/corge.wasm", to: "/usr/bin/corge", lazy: true, mode: "755" },
      { type: "directory", from: "programs/wasm32/grault.zip", to: "/usr", lazy: true },
    ];
    assert.deepEqual(quxWith(files), parsed({ ...QUX, files }));
  });

  it("accepts a tree copied from an image, and rejects a key an image copy does not take", () => {
    const files = [{ from: "programs/wasm32/qux.vfs.zst:/srv/qux", to: "/var/www/qux" }];
    assert.deepEqual(quxWith(files), parsed({ ...QUX, files }));
    expectRejected([{ ...QUX, files: [{ ...files[0], from: "programs/wasm32/qux.vfs.zst:srv/qux" }] }], /entries\[0\]\.files\[0\]\.from must be an absolute, normalized path/);
    expectRejected([{ ...QUX, files: [{ ...files[0], from: "../qux.vfs.zst:/srv/qux" }] }], /entries\[0\]\.files\[0\]\.from must be a relative, normalized path under the binaries root/);
    expectRejected([{ ...QUX, files: [{ ...files[0], mode: "755" }] }], /entries\[0\]\.files\[0\] has unknown keys: mode/);
    expectRejected([{ ...QUX, files: [{ ...files[0], lazy: true }] }], /entries\[0\]\.files\[0\] has unknown keys: lazy/);
    expectRejected([{ ...QUX, files: [{ ...files[0], type: "directory" }] }], /entries\[0\]\.files\[0\]\.from must be a relative, normalized path under the binaries root/);
  });

  it("drops the default type file, and rejects another type", () => {
    assert.deepEqual(quxWith([{ to: "/etc/qux", type: "file", content: "qux" }]), parsed({ ...QUX, files: [{ to: "/etc/qux", content: "qux" }] }));
    expectRejected([{ ...QUX, files: [{ to: "/home/qux", type: "folder" }] }], /entries\[0\]\.files\[0\]\.type must be one of file, directory, symlink/);
  });

  it("accepts a directory with an owner and a mode", () => {
    const files = [{ to: "/home/qux", type: "directory", owner: "1000:1000", mode: "700" }, { to: "/srv/qux", type: "directory" }];
    assert.deepEqual(quxWith(files), parsed({ ...QUX, files }));
  });

  it("rejects a malformed owner, or a key a directory does not take", () => {
    for (const owner of ["1000", "qux:qux", "01:1", 1000]) {
      expectRejected([{ ...QUX, files: [{ to: "/home/qux", type: "directory", owner }] }], /entries\[0\]\.files\[0\]\.owner must be a "uid:gid" string/);
    }
    expectRejected([{ ...QUX, files: [{ to: "/home/qux", type: "directory", sha256: "a".repeat(64) }] }], /entries\[0\]\.files\[0\] has unknown keys: sha256/);
  });

  it("rejects a regular file with more than one source or none", () => {
    expectRejected(
      [{ ...QUX, files: [{ to: "/bin/qux", from: "programs/wasm32/qux.wasm", content: "" }] }],
      /entries\[0\]\.files\[0\] must have exactly one of content, from/,
    );
    expectRejected(
      [{ ...QUX, files: [{ to: "/bin/qux" }] }],
      /entries\[0\]\.files\[0\] must have exactly one of content, from/,
    );
  });

  it("rejects a path that is not absolute and normalized", () => {
    for (const to of ["bin/qux", "/bin//qux", "/bin/../qux", "/bin/./qux", "/bin/qux/", "/"]) {
      expectRejected(
        [{ ...QUX, files: [{ from: "programs/wasm32/qux.wasm", to }] }],
        /entries\[0\]\.files\[0\]\.to must be an absolute, normalized path/,
      );
    }
    expectRejected([{ ...QUX, files: [{ to: "etc/qux", content: "" }] }], /entries\[0\]\.files\[0\]\.to must be an absolute, normalized path/);
    expectRejected([{ ...QUX, files: [{ to: "/srv/", type: "directory" }] }], /entries\[0\]\.files\[0\]\.to must be an absolute, normalized path/);
    expectRejected([{ ...QUX, files: [{ to: "/usr/bin/qux", type: "symlink", from: "bin/qux" }] }], /entries\[0\]\.files\[0\]\.from must be an absolute, normalized path/);
    expectRejected([{ ...QUX, files: [{ to: "/usr/bin/qux", type: "symlink", from: "/bin/qux", mode: "755" }] }], /entries\[0\]\.files\[0\] has unknown keys: mode/);
  });

  it("rejects a local source outside the binaries root", () => {
    for (const from of ["/programs/qux.wasm", "../qux.wasm", "programs//qux.wasm", 7]) {
      expectRejected(
        [{ ...QUX, files: [{ from, to: "/bin/qux" }] }],
        /entries\[0\]\.files\[0\]\.from must be a relative, normalized path under the binaries root/,
      );
    }
    expectRejected(
      [{ ...QUX, files: [{ type: "directory", from: "../qux.zip", to: "/usr" }] }],
      /entries\[0\]\.files\[0\]\.from must be a relative, normalized path under the binaries root/,
    );
  });

  it("rejects a remote source that is not https", () => {
    expectRejected(
      [{ ...QUX, files: [{ from: "http://foo.test/qux.wad", to: "/qux.wad" }] }],
      /entries\[0\]\.files\[0\]\.from must be an https URL/,
    );
  });

  it("refuses a sha256 or a size, which the build finds itself, and a lazy that is not true", () => {
    expectRejected(
      [{ ...QUX, files: [{ from: "https://foo.test/qux.wad", to: "/qux.wad", sha256: "a".repeat(64) }] }],
      /entries\[0\]\.files\[0\] has unknown keys: sha256/,
    );
    expectRejected(
      [{ ...QUX, files: [{ from: "programs/wasm32/qux.wasm", to: "/bin/qux", lazy: true, size: 3 }] }],
      /entries\[0\]\.files\[0\] has unknown keys: size/,
    );
    expectRejected(
      [{ ...QUX, files: [{ from: "programs/wasm32/qux.wasm", to: "/bin/qux", lazy: false }] }],
      /entries\[0\]\.files\[0\]\.lazy must be true when present/,
    );
  });

  it("rejects a mode on an extracted archive", () => {
    expectRejected([{ ...QUX, files: [{ type: "directory", from: "programs/wasm32/qux.zip", to: "/usr", mode: "755" }] }], /entries\[0\]\.files\[0\] has unknown keys: mode/);
  });

  it("rejects a malformed mode, a non-string content, or an unknown file key", () => {
    expectRejected(
      [{ ...QUX, files: [{ to: "/etc/qux", content: "", mode: "rw" }] }],
      /entries\[0\]\.files\[0\]\.mode must be an octal mode string/,
    );
    expectRejected(
      [{ ...QUX, files: [{ to: "/etc/qux", content: 7 }] }],
      /entries\[0\]\.files\[0\]\.content must be a string/,
    );
    expectRejected(
      [{ ...QUX, files: [{ to: "/etc/qux", content: "", owner: "0:0" }] }],
      /entries\[0\]\.files\[0\] has unknown keys: owner/,
    );
  });

  it("rejects a use of an entry the registry does not list, or of a pipeline", () => {
    expectRejected([{ ...QUUX, use: ["garply"] }, QUX], /binary "quux" uses "garply", which is not a registered binary/);
    expectRejected([{ ...QUUX, use: ["corge"] }, QUX, THEME, CORGE], /binary "quux" uses "corge", which is not a registered binary/);
    expectRejected([{ ...CORGE, name: "grault", use: ["corge"] }, QUX, THEME, CORGE], /pipeline "grault" uses "corge", which is not a registered binary/);
  });

  it("rejects a pipeline that enables an unknown option", () => {
    expectRejected([{ ...CORGE, enable: ["garply"] }, QUX], /pipeline "corge" enables "garply", which is not a registered option/);
  });

  it("rejects a need no registered binary or pipeline provides", () => {
    expectRejected([{ ...QUUX, need: ["init"] }, QUX], /binary "quux" needs "init", which no registered binary or pipeline provides/);
  });

  it("rejects an option's use or need the registry cannot resolve", () => {
    expectRejected([{ ...THEME, use: ["garply"] }, QUX], /option "theme" uses "garply", which is not a registered binary/);
    expectRejected([{ ...THEME, need: ["init"] }, QUX], /option "theme" needs "init", which no registered binary or pipeline provides/);
  });

  it("rejects a duplicate name across entry types", () => {
    expectRejected([FOO, { ...BAZ, name: FOO.name }], /entries\[1\] duplicates an earlier entry: name "@foo\/bar"/);
  });
});

describe("deloPipelineName", () => {
  it("names the pipeline after its computer, in the characters a registry name takes", () => {
    assert.equal(deloPipelineName("foo"), "foo-pipeline");
    assert.equal(deloPipelineName("Foo@Bar"), "foo-bar-pipeline");
    assert.equal(deloPipelineName("_foo"), "foo-pipeline");
    assert.equal(deloPipelineName("@@"), "pipeline");
    assert.equal(deloPipelineName("a".repeat(120)), `${"a".repeat(119)}-pipeline`);
    assert.equal(deloPipelineNameProblem(parseDeloRegistry(JSON.stringify({ schema: 1, entries: [QUX] })), deloPipelineName("a".repeat(120))), null);
  });
});

describe("deloPipelineNameProblem", () => {
  const registry = parseDeloRegistry(JSON.stringify({ schema: 1, entries: [QUX] }));
  it("takes a registry name that no entry holds", () => {
    assert.equal(deloPipelineNameProblem(registry, "foo-pipeline"), null);
    assert.equal(deloPipelineNameProblem(registry, "qux"), "qux is already the name of a registry entry");
    for (const name of ["", "Foo", "foo bar", "-foo", "a".repeat(129)]) assert.match(deloPipelineNameProblem(registry, name)!, /a pipeline name holds lowercase letters/);
  });
});

describe("findDeloImage", () => {
  it("returns the image a name refers to, and null for an app, a binary, an option or an unknown name", () => {
    const registry = parseDeloRegistry(validRegistryText([FOO, BAZ, QUX, THEME]));
    assert.deepEqual(findDeloImage(registry, FOO.name), FOO);
    assert.equal(findDeloImage(registry, BAZ.name), null);
    assert.equal(findDeloImage(registry, QUX.name), null);
    assert.equal(findDeloImage(registry, THEME.name), null);
    assert.equal(findDeloImage(registry, "@foo/garply"), null);
  });
});

describe("deloImages", () => {
  it("lists every image, and no app or binary", () => {
    const registry = parseDeloRegistry(validRegistryText([BAZ, QUX, FOO]));
    assert.deepEqual(deloImages(registry).map((entry) => entry.name), [FOO.name]);
  });
});

describe("deloLazyStorePaths", () => {
  it("lists each lazy file and lazy archive under the binaries root once, and no eager file or URL", () => {
    const registry = parseDeloRegistry(validRegistryText([
      { ...QUX, files: [
        { from: "programs/wasm32/qux.wasm", to: "/bin/qux", mode: "755" },
        { from: "programs/wasm32/foo.wasm", to: "/bin/foo", mode: "755", lazy: true },
        { from: "programs/wasm32/bar.zip", to: "/usr/share/bar", type: "directory", lazy: true },
        { from: "https://foo.test/baz.bin", to: "/usr/share/baz", lazy: true },
      ] },
      { ...QUUX, files: [{ from: "programs/wasm32/foo.wasm", to: "/bin/quux", mode: "755", lazy: true }] },
    ]));
    assert.deepEqual(deloLazyStorePaths(registry), ["programs/wasm32/foo.wasm", "programs/wasm32/bar.zip"]);
  });
});

describe("the tracked registry", () => {
  it("parses, runs the five images, and links the space.fast app", () => {
    const registry = parseDeloRegistry(readFileSync(new URL("../src/registry.json", import.meta.url), "utf8"));
    assert.deepEqual(deloImages(registry).map((entry) => entry.name), [
      "@mho22/raytracer",
      "@storytold/photocraft",
      "@storytold/vectorcraft",
      "@storytold/wordcraft",
      "@storytold/gridcraft",
    ]);
    assert.deepEqual(registry.entries.filter((entry) => entry.type === "app").map((entry) => entry.name), ["@mho22/raytracer-spacefast"]);
  });
});

describe("deloFileKind", () => {
  it("names the type, and for a regular file its one source", () => {
    assert.equal(deloFileKind({ type: "symlink" }), "symlink");
    assert.equal(deloFileKind({ type: "directory" }), "directory");
    assert.equal(deloFileKind({ type: "directory", from: "programs/wasm32/foo.zip" }), "archive");
    assert.equal(deloFileKind({ content: "foo" }), "content");
    assert.equal(deloFileKind({ content: "foo", from: "programs/wasm32/foo.wasm" }), undefined);
    assert.equal(deloFileKind({}), undefined);
  });
});

describe("deloImageSource", () => {
  it("splits an image and the path inside it, and refuses a store path or a URL", () => {
    assert.deepEqual(deloImageSource("programs/wasm32/foo.vfs.zst:/srv/foo"), { image: "programs/wasm32/foo.vfs.zst", path: "/srv/foo" });
    assert.equal(deloImageSource("programs/wasm32/foo.wasm"), null);
    assert.equal(deloImageSource("https://foo.test/bar"), null);
  });
});
