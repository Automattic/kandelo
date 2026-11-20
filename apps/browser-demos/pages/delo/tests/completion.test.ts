import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeDeloLine, type DeloArguments, type DeloComputers, type DeloWriteFlags } from "../src/completion";

const ARGUMENTS: DeloArguments = {
  run: ["@mho22/raytracer", "@mho22/paint", "@foo/bar"],
  list: ["pipelines", "binaries", "options", "images", "apps"],
  init: [],
  config: ["foo"],
  save: [],
  destroy: ["foo"],
  add: ["bash", "base-files", "dash"],
  remove: ["bash"],
  write: ["/etc/foo"],
  enable: ["share", "theme"],
  disable: [],
};

const COMPUTERS: DeloComputers = (verb, thing) => (verb === "add" && thing === "dash") || verb === "write" ? ["foo", "foobar", "qux"] : [];

const FLAGS: DeloWriteFlags = (path, computer, flags) =>
  path === "/etc/foo" && computer === "foo" ? ["type", "content", "from", "mode"].filter((key) => !flags.some((flag) => flag.key === key)) : [];

const VERBS = ["run", "list", "config", "init", "save", "destroy", "add", "remove", "write", "enable", "disable"];

describe("completeDeloLine", () => {
  it("completes the command word", () => {
    for (const line of ["", "de", "  de"]) {
      assert.deepEqual(completeDeloLine(line, ARGUMENTS, COMPUTERS, FLAGS), { line: "delo ", prefix: "", candidates: [] });
    }
  });

  it("offers the verbs after the command word", () => {
    for (const line of ["delo", "delo "]) {
      assert.deepEqual(completeDeloLine(line, ARGUMENTS, COMPUTERS, FLAGS), { line: "delo ", prefix: "delo ", candidates: VERBS });
    }
  });

  it("completes a unique verb, and offers the verbs a shared start matches", () => {
    assert.deepEqual(completeDeloLine("delo a", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo add", prefix: "delo ", candidates: [] });
    assert.deepEqual(completeDeloLine("delo r", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo r", prefix: "delo ", candidates: ["run", "remove"] });
    assert.deepEqual(completeDeloLine("delo w", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo write", prefix: "delo ", candidates: [] });
    assert.deepEqual(completeDeloLine("delo d", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo d", prefix: "delo ", candidates: ["destroy", "disable"] });
    assert.deepEqual(completeDeloLine("delo en", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo enable", prefix: "delo ", candidates: [] });
    assert.deepEqual(completeDeloLine("delo l", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo list", prefix: "delo ", candidates: [] });
  });

  it("offers each verb its own arguments", () => {
    for (const line of ["delo run", "delo run "]) {
      assert.deepEqual(completeDeloLine(line, ARGUMENTS, COMPUTERS, FLAGS), { line: "delo run ", prefix: "delo run ", candidates: ARGUMENTS.run });
    }
    assert.deepEqual(completeDeloLine("delo add", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo add ", prefix: "delo add ", candidates: ARGUMENTS.add });
    assert.deepEqual(completeDeloLine("delo enable", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo enable ", prefix: "delo enable ", candidates: ARGUMENTS.enable });
    assert.deepEqual(completeDeloLine("delo list", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo list ", prefix: "delo list ", candidates: ARGUMENTS.list });
    assert.deepEqual(completeDeloLine("delo list b", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo list binaries", prefix: "delo list ", candidates: [] });
  });

  it("completes a unique argument", () => {
    assert.deepEqual(completeDeloLine("delo run @f", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo run @foo/bar", prefix: "delo run ", candidates: [] });
    assert.deepEqual(completeDeloLine("delo add d", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo add dash", prefix: "delo add ", candidates: [] });
    assert.deepEqual(completeDeloLine("delo remove b", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo remove bash", prefix: "delo remove ", candidates: [] });
  });

  it("extends an ambiguous argument to the common part and offers every candidate", () => {
    assert.deepEqual(completeDeloLine("delo run @mho", ARGUMENTS, COMPUTERS, FLAGS), {
      line: "delo run @mho22/",
      prefix: "delo run ",
      candidates: ["@mho22/raytracer", "@mho22/paint"],
    });
    assert.deepEqual(completeDeloLine("delo add ba", ARGUMENTS, COMPUTERS, FLAGS), {
      line: "delo add bas",
      prefix: "delo add ",
      candidates: ["bash", "base-files"],
    });
  });

  it("offers the computers a change applies to after its thing", () => {
    for (const line of ["delo add dash", "delo add dash "]) {
      assert.deepEqual(completeDeloLine(line, ARGUMENTS, COMPUTERS, FLAGS), { line: "delo add dash ", prefix: "delo add dash ", candidates: ["foo", "foobar", "qux"] });
    }
    assert.deepEqual(completeDeloLine("delo add dash q", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo add dash qux", prefix: "delo add dash ", candidates: [] });
    assert.deepEqual(completeDeloLine("delo add dash f", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo add dash foo", prefix: "delo add dash ", candidates: ["foo", "foobar"] });
  });

  it("completes a written path, and offers the computers after a path no written path extends", () => {
    assert.deepEqual(completeDeloLine("delo write /etc/f", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo write /etc/foo", prefix: "delo write ", candidates: [] });
    for (const line of ["delo write /etc/foo", "delo write /etc/bar"]) {
      assert.deepEqual(completeDeloLine(line, ARGUMENTS, COMPUTERS, FLAGS), { line: `${line} `, prefix: `${line} `, candidates: ["foo", "foobar", "qux"] });
    }
  });

  it("offers the flags of delo write after its computer, completes a flag, and never a value", () => {
    assert.deepEqual(completeDeloLine("delo write /etc/foo foo ", ARGUMENTS, COMPUTERS, FLAGS), {
      line: "delo write /etc/foo foo ",
      prefix: "delo write /etc/foo foo ",
      candidates: ["--type", "--content", "--from", "--mode"],
    });
    assert.deepEqual(completeDeloLine("delo write /etc/foo foo --c", ARGUMENTS, COMPUTERS, FLAGS), { line: "delo write /etc/foo foo --content", prefix: "delo write /etc/foo foo ", candidates: [] });
    assert.deepEqual(completeDeloLine("delo write /etc/foo foo --content \"a b\" ", ARGUMENTS, COMPUTERS, FLAGS).candidates, ["--type", "--from", "--mode"]);
    for (const line of ["delo write /etc/foo foo --mode ", "delo write /etc/foo foo --mode 6", "delo write /etc/foo foo --content \"a b", "delo write /etc/foo foo bar", "delo write /etc/foo qux "]) {
      assert.deepEqual(completeDeloLine(line, ARGUMENTS, COMPUTERS, FLAGS), { line, prefix: "", candidates: [] });
    }
  });

  it("leaves a foreign command, an unknown word, an empty list, or an extra word alone", () => {
    for (const line of ["run", "run @mho", "delo @mho", "delo zzz", "delo q", "delo list zzz", "delo list binaries foo", "delo run @zzz", "delo init", "delo init foo", "delo disable", "delo run @foo/bar now", "delo add bash ", "delo add dash qux now", "delo destroy foo bar"]) {
      assert.deepEqual(completeDeloLine(line, ARGUMENTS, COMPUTERS, FLAGS), { line, prefix: "", candidates: [] });
    }
  });
});
