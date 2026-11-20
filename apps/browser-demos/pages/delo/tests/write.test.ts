import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDeloCommand } from "../src/command";
import { EMPTY_DELO_PIPELINE } from "../src/draft";
import type { DeloFile } from "../src/registry";
import { deloEditedFile, deloEditorFields, deloPipelineFile, deloWriteEdits, deloWriteOffers, deloWrittenFile, type DeloEditorFields } from "../src/write";

const flags = (line: string) => parseDeloCommand(`delo write /etc/foo bar ${line}`).flags;

const written = (existing: DeloFile | undefined, line: string) => deloWrittenFile(existing, "/etc/foo", flags(line));

describe("deloWrittenFile", () => {
  it("makes a new path an empty file unless a flag names a source or another type", () => {
    assert.deepEqual(deloWrittenFile(undefined, "/etc/foo", []).file, { to: "/etc/foo", content: "" });
    assert.deepEqual(written(undefined, "--mode 600").file, { to: "/etc/foo", content: "", mode: "600" });
    assert.deepEqual(written(undefined, "--type file").file, { to: "/etc/foo", content: "" });
    assert.deepEqual(written(undefined, "--type symlink --from /etc/bar").file, { to: "/etc/foo", type: "symlink", from: "/etc/bar" });
    assert.deepEqual(written(undefined, "--type directory --owner 1000:1000").file, { to: "/etc/foo", type: "directory", owner: "1000:1000" });
    assert.deepEqual(written(undefined, "--from https://example.com/foo --lazy").file, { to: "/etc/foo", from: "https://example.com/foo", lazy: true });
  });

  it("refuses a relative path, and names the absolute one", () => {
    assert.throws(() => deloWrittenFile(undefined, "foo", []), { message: "foo is not an absolute path. Did you mean /foo?" });
  });
});

describe("deloWriteEdits", () => {
  const edits = (line: string) => deloWriteEdits(flags(line));

  it("opens the editor when the line gives no source", () => {
    assert.equal(edits(""), true);
    assert.equal(edits("--mode 600"), true);
    assert.equal(edits("--type directory"), true);
    assert.equal(edits("--type symlink"), true);
  });

  it("writes from the flags when the line gives a source", () => {
    assert.equal(edits("--content foo"), false);
    assert.equal(edits("--from https://example.com/foo"), false);
    assert.equal(edits("--type symlink --from /etc/bar"), false);
  });

  it("merges only the given flags into the file at the path", () => {
    const existing: DeloFile = { to: "/etc/foo", content: "foo", mode: "600" };
    assert.deepEqual(written(existing, "--mode 755"), { file: { to: "/etc/foo", content: "foo", mode: "755" }, replaces: false });
    assert.deepEqual(written(existing, "--content bar").file, { to: "/etc/foo", content: "bar", mode: "600" });
  });

  it("replaces a file of another type, or of another source, with exactly the given flags", () => {
    assert.deepEqual(written({ to: "/etc/foo", content: "foo", mode: "755" }, "--from https://example.com/foo"), {
      file: { to: "/etc/foo", from: "https://example.com/foo" },
      replaces: true,
    });
    assert.deepEqual(written({ to: "/etc/foo", type: "symlink", from: "/etc/bar" }, "--type directory").file, { to: "/etc/foo", type: "directory" });
    assert.equal(written({ to: "/etc/foo", type: "symlink", from: "/etc/bar" }, "--from /etc/baz").replaces, false);
    assert.equal(written({ to: "/etc/foo", content: "foo" }, "--type file --mode 600").replaces, false);
  });

  it("refuses a rerun with no flag, an unknown flag, and a flag with the wrong value", () => {
    assert.throws(() => written({ to: "/etc/foo", content: "foo" }, ""), { message: "the pipeline already writes /etc/foo. Give a flag to change it." });
    assert.throws(() => written(undefined, "--to /etc/bar"), /--to is not a flag of delo write: --type --content --from --lazy --mode --owner/);
    assert.throws(() => written(undefined, "--sha256 abc"), /--sha256 is not a flag of delo write/);
    assert.throws(() => written(undefined, "--size 3"), /--size is not a flag of delo write/);
    assert.throws(() => written(undefined, "--lazy yes"), { message: "--lazy takes no value" });
    assert.throws(() => written(undefined, "--mode"), { message: "--mode takes a value" });
  });

  it("refuses a file the parser refuses", () => {
    assert.throws(() => written(undefined, "--mode 9"), /\/etc\/foo\.mode must be an octal mode string/);
    assert.throws(() => written(undefined, "--content foo --from programs/wasm32/foo.wasm"), /\/etc\/foo must have exactly one of content, from/);
  });
});

describe("deloPipelineFile", () => {
  it("finds the one file at a path, and refuses a path with several", () => {
    const pipeline = { ...EMPTY_DELO_PIPELINE, files: [{ to: "/etc/foo", content: "foo" }, { to: "/etc/bar", content: "bar" }, { to: "/etc/bar", content: "baz" }] };
    assert.deepEqual(deloPipelineFile(pipeline, "/etc/foo"), { to: "/etc/foo", content: "foo" });
    assert.equal(deloPipelineFile(pipeline, "/etc/qux"), undefined);
    assert.throws(() => deloPipelineFile(pipeline, "/etc/bar"), { message: "the pipeline has 2 files at /etc/bar. Remove them with delo remove /etc/bar, then write one." });
  });
});

describe("deloEditorFields", () => {
  const empty: DeloEditorFields = { type: "file", content: "", from: "", lazy: false, mode: "", owner: "" };
  const fields = (existing: DeloFile | undefined, line: string) => deloEditorFields(existing, flags(line));

  it("fills the options from the file at the path, then from the line", () => {
    assert.deepEqual(fields(undefined, ""), empty);
    assert.deepEqual(fields({ to: "/etc/foo", content: "foo", mode: "600" }, "--mode 640"), { ...empty, content: "foo", mode: "640" });
    assert.deepEqual(fields({ to: "/etc/foo", from: "https://example.com/foo", lazy: true }, ""), { ...empty, from: "https://example.com/foo", lazy: true });
  });

  it("drops the file at the path when the line changes its type", () => {
    assert.deepEqual(fields({ to: "/etc/foo", content: "foo", mode: "600" }, "--type directory --owner 1000:1000"), { ...empty, type: "directory", owner: "1000:1000" });
  });

  it("refuses an unknown type", () => {
    assert.throws(() => fields(undefined, "--type fifo"), { message: "--type must be one of file, directory, symlink" });
  });
});

describe("deloEditedFile", () => {
  const empty: DeloEditorFields = { type: "file", content: "", from: "", lazy: false, mode: "", owner: "" };
  const edited = (fields: Partial<DeloEditorFields>) => deloEditedFile("/etc/foo", { ...empty, ...fields });

  it("writes the options the type shows, and leaves out the empty ones", () => {
    assert.deepEqual(edited({}), { to: "/etc/foo", content: "" });
    assert.deepEqual(edited({ content: "foo\n", mode: "600" }), { to: "/etc/foo", content: "foo\n", mode: "600" });
    assert.deepEqual(edited({ from: "https://example.com/foo", lazy: true }), { to: "/etc/foo", from: "https://example.com/foo", lazy: true });
    assert.deepEqual(edited({ type: "directory", content: "foo", mode: "700", owner: "1000:1000" }), { to: "/etc/foo", type: "directory", mode: "700", owner: "1000:1000" });
    assert.deepEqual(edited({ type: "symlink", from: "/etc/bar", mode: "600" }), { to: "/etc/foo", type: "symlink", from: "/etc/bar" });
  });

  it("refuses what the registry parser refuses", () => {
    assert.throws(() => edited({ content: "foo", from: "https://example.com/foo" }), { message: "/etc/foo must have exactly one of content, from" });
    assert.throws(() => edited({ type: "symlink" }), /from/);
  });
});

describe("deloWriteOffers", () => {
  const offers = (existing: DeloFile | undefined, line: string) => deloWriteOffers(existing, flags(line));

  it("offers the flags that choose a kind on a new path, until a type or a source comes", () => {
    assert.deepEqual(offers(undefined, ""), ["type", "content", "from"]);
    assert.deepEqual(offers(undefined, "--mode 600"), ["type", "content", "from"]);
    assert.deepEqual(offers(undefined, "--type file"), ["content", "from"]);
  });

  it("offers the keys the kind takes that are not given yet", () => {
    assert.deepEqual(offers(undefined, "--content foo"), ["mode"]);
    assert.deepEqual(offers(undefined, "--from https://example.com/foo --lazy"), ["mode"]);
    assert.deepEqual(offers(undefined, "--from programs/wasm32/foo.vfs.zst:/srv/foo"), []);
    assert.deepEqual(offers(undefined, "--type directory"), ["from", "mode", "owner"]);
    assert.deepEqual(offers(undefined, "--type directory --from programs/wasm32/foo.zip"), ["lazy"]);
    assert.deepEqual(offers(undefined, "--type symlink"), ["from"]);
  });

  it("offers on a rerun the keys of the file's kind, and follows the given flags once they replace it", () => {
    assert.deepEqual(offers({ to: "/etc/foo", content: "foo" }, ""), ["content", "mode"]);
    assert.deepEqual(offers({ to: "/etc/foo", type: "directory" }, "--mode 700"), ["owner"]);
    assert.deepEqual(offers({ to: "/etc/foo", from: "programs/wasm32/foo.vfs.zst:/srv/foo", }, ""), ["from"]);
    assert.deepEqual(offers({ to: "/etc/foo", content: "foo" }, "--type symlink"), ["from"]);
  });
});
