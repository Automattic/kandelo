import { describe, expect, it } from "vitest";

import { parseSavedMachineMessage, SavedMachineMessageError } from "../src/saved-machine-message";

const OWNER = { mode: 0o644, uid: 1000, gid: 1000 };
const DIGEST = "a".repeat(64);

describe("parseSavedMachineMessage", () => {
  it("reads an offer with its states", () => {
    const offer = {
      type: "offer",
      name: "foo-bar-baz",
      home: "/home/maker",
      states: [
        ["foo", { ...OWNER, kind: "directory" }],
        ["foo/bar", { ...OWNER, kind: "file", mtimeMs: 1, digest: DIGEST }],
        ["foo/baz", { ...OWNER, kind: "symlink", target: "bar" }],
      ],
    };
    expect(parseSavedMachineMessage(offer)).toEqual(offer);
  });

  it("reads changes with the bytes of every file", () => {
    const bytes = new TextEncoder().encode("qux");
    const changes = {
      type: "changes",
      seq: 3,
      put: [{ ...OWNER, path: "foo/bar", kind: "file", mtimeMs: 1, bytes }],
      remove: ["foo/baz"],
    };
    expect(parseSavedMachineMessage(changes)).toEqual(changes);
  });

  it("reads a modification, which carries nothing but its type", () => {
    expect(parseSavedMachineMessage({ type: "modified", path: "foo" })).toEqual({ type: "modified" });
  });

  it("caps the reason of a failure", () => {
    const failed = parseSavedMachineMessage({ type: "failed", seq: 0, reason: "x".repeat(600) });
    expect(failed.type === "failed" && failed.reason.length).toBe(500);
  });

  it.each(["", "/etc/passwd", "..", "foo/../../etc", "./foo", "foo//bar", "foo/", "foo\\bar", "foo\0bar"])(
    "refuses an entry at %j, which is not a path under the home directory",
    (path) => {
      const changes = { type: "changes", seq: 0, put: [{ ...OWNER, path, kind: "directory" }], remove: [] };
      expect(() => parseSavedMachineMessage(changes)).toThrow(SavedMachineMessageError);
      expect(() => parseSavedMachineMessage({ type: "changes", seq: 0, put: [], remove: [path] }))
        .toThrow(SavedMachineMessageError);
    },
  );

  it.each(["accept", "modified", "stopped"])("reads %j, which carries nothing but its type", (type) => {
    expect(parseSavedMachineMessage({ type, seq: 1 })).toEqual({ type });
  });

  it("reads an answer by its sequence number", () => {
    expect(parseSavedMachineMessage({ type: "saved", seq: 7 })).toEqual({ type: "saved", seq: 7 });
  });

  it.each([-1, 1.5, "1"])("refuses the sequence number %j", (seq) => {
    expect(() => parseSavedMachineMessage({ type: "saved", seq })).toThrow("no sequence number");
  });

  it("refuses an offer state outside the home, of the wrong shape, or of an unknown kind", () => {
    const offer = (states: unknown) => ({ type: "offer", name: "foo", home: "/home/maker", states });
    expect(() => parseSavedMachineMessage(offer([["../x", { ...OWNER, kind: "directory" }]])))
      .toThrow("not a path under the home directory");
    expect(() => parseSavedMachineMessage(offer([["foo", { ...OWNER, kind: "directory" }, "bar"]])))
      .toThrow("not a path and a state");
    expect(() => parseSavedMachineMessage(offer([["foo", { ...OWNER, kind: "fifo" }]])))
      .toThrow("unknown state kind");
  });

  it("refuses an entry of an unknown kind, an empty or NUL symlink target, and a time that is not finite", () => {
    const changes = (entry: Record<string, unknown>) => ({
      type: "changes", seq: 0, put: [{ ...OWNER, path: "foo", ...entry }], remove: [],
    });
    expect(() => parseSavedMachineMessage(changes({ kind: "fifo" }))).toThrow("unknown entry kind");
    for (const target of ["", "a\0b"]) {
      expect(() => parseSavedMachineMessage(changes({ kind: "symlink", target }))).toThrow("no target");
    }
    for (const mtimeMs of [NaN, Infinity]) {
      expect(() => parseSavedMachineMessage(changes({ kind: "file", mtimeMs, bytes: new Uint8Array() })))
        .toThrow("no modification time");
    }
  });

  it("refuses an offer named with blanks only, and strips control characters from a name", () => {
    expect(() => parseSavedMachineMessage({ type: "offer", name: "   ", home: "/home/maker", states: [] }))
      .toThrow("offer names no machine");
    expect(parseSavedMachineMessage({ type: "offer", name: "foo\u0007bar", home: "/home/maker", states: [] }))
      .toMatchObject({ name: "foobar" });
  });

  it("refuses a file with no bytes, a state with no digest, and an offer with no home", () => {
    expect(() => parseSavedMachineMessage({
      type: "changes", seq: 0, put: [{ ...OWNER, path: "foo", kind: "file", mtimeMs: 1, bytes: "foo" }], remove: [],
    })).toThrow("file foo has no bytes");
    expect(() => parseSavedMachineMessage({
      type: "offer", name: "foo", home: "/home/maker", states: [["foo", { ...OWNER, kind: "file", mtimeMs: 1, digest: "foo" }]],
    })).toThrow("no SHA-256 digest");
    expect(() => parseSavedMachineMessage({ type: "offer", name: "foo", home: "/", states: [] }))
      .toThrow("no home directory");
  });

  it("refuses a negative owner, an unknown type, and a message that is not an object", () => {
    expect(() => parseSavedMachineMessage({
      type: "changes", seq: 0, put: [{ ...OWNER, uid: -1, path: "foo", kind: "directory" }], remove: [],
    })).toThrow("uid is not a non-negative integer");
    expect(() => parseSavedMachineMessage({ type: "garply" })).toThrow("unknown message type");
    expect(() => parseSavedMachineMessage(null)).toThrow("message is not an object");
  });
});
