import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DELO_USAGE, isDeloChangeVerb, isDeloVerb, parseDeloCommand } from "../src/command";

describe("parseDeloCommand", () => {
  it("parses every verb with its argument", () => {
    assert.deepEqual(parseDeloCommand("delo run @mho22/raytracer"), { verb: "run", name: "@mho22/raytracer", computer: null, flags: [] });
    assert.deepEqual(parseDeloCommand("delo run foo"), { verb: "run", name: "foo", computer: null, flags: [] });
    assert.deepEqual(parseDeloCommand("delo list binaries"), { verb: "list", name: "binaries", computer: null, flags: [] });
    assert.deepEqual(parseDeloCommand("delo init foo"), { verb: "init", name: "foo", computer: null, flags: [] });
    assert.deepEqual(parseDeloCommand("delo save foo"), { verb: "save", name: "foo", computer: null, flags: [] });
    assert.deepEqual(parseDeloCommand("delo config foo"), { verb: "config", name: "foo", computer: null, flags: [] });
    assert.deepEqual(parseDeloCommand("delo add bash foo"), { verb: "add", name: "bash", computer: "foo", flags: [] });
    assert.deepEqual(parseDeloCommand("delo remove bash foo"), { verb: "remove", name: "bash", computer: "foo", flags: [] });
    assert.deepEqual(parseDeloCommand("delo enable share foo"), { verb: "enable", name: "share", computer: "foo", flags: [] });
    assert.deepEqual(parseDeloCommand("delo disable share foo"), { verb: "disable", name: "share", computer: "foo", flags: [] });
    assert.deepEqual(parseDeloCommand("  delo   run   @foo/bar  "), { verb: "run", name: "@foo/bar", computer: null, flags: [] });
  });

  it("parses delo without its verb", () => {
    assert.deepEqual(parseDeloCommand("delo"), { verb: null, name: null, computer: null, flags: [] });
    assert.deepEqual(parseDeloCommand("  delo  "), { verb: null, name: null, computer: null, flags: [] });
  });

  it("parses a verb without its argument, and a change verb without its computer", () => {
    for (const verb of ["run", "list", "init", "config", "save", "destroy", "add", "remove", "write", "enable", "disable"]) {
      assert.deepEqual(parseDeloCommand(`delo ${verb}`), { verb, name: null, computer: null, flags: [] });
      assert.deepEqual(parseDeloCommand(`delo ${verb} `), { verb, name: null, computer: null, flags: [] });
    }
    assert.deepEqual(parseDeloCommand("delo add bash"), { verb: "add", name: "bash", computer: null, flags: [] });
  });

  it("parses delo write with its flags, a flag alone, and quoted values", () => {
    assert.deepEqual(parseDeloCommand("delo write /etc/foo bar"), { verb: "write", name: "/etc/foo", computer: "bar", flags: [] });
    assert.deepEqual(parseDeloCommand("delo write /etc/foo bar --mode 600 --lazy --owner"), {
      verb: "write",
      name: "/etc/foo",
      computer: "bar",
      flags: [{ key: "mode", value: "600" }, { key: "lazy", value: null }, { key: "owner", value: null }],
    });
    assert.deepEqual(parseDeloCommand('delo write /etc/foo bar --content "baz qux\\n\\"quux\\" \\\\" --append ""').flags, [
      { key: "content", value: 'baz qux\n"quux" \\' },
      { key: "append", value: "" },
    ]);
    assert.deepEqual(parseDeloCommand('delo write /etc/foo bar --content "--mode"').flags, [{ key: "content", value: "--mode" }]);
    assert.deepEqual(parseDeloCommand('delo run "foo"'), { verb: "run", name: "foo", computer: null, flags: [] });
  });

  it("refuses a quote left open, an unknown escape, a repeated flag and a word that is not a flag", () => {
    assert.throws(() => parseDeloCommand('delo write /etc/foo bar --content "baz'), { message: "a quote is not closed" });
    assert.throws(() => parseDeloCommand('delo write /etc/foo bar --content "\\t"'), { message: 'a backslash in quotes takes \\", \\\\ or \\n after it' });
    assert.throws(() => parseDeloCommand("delo write /etc/foo bar --mode 600 --mode 644"), { message: "--mode is given twice" });
    assert.throws(() => parseDeloCommand("delo write /etc/foo bar --mode 600 644"), { message: "644 is not a flag: a flag starts with --" });
  });

  it("rejects every other shape with the usage line", () => {
    for (const line of [
      "",
      "delo load foo",
      "delo list binaries foo",
      "Delo run",
      "delo @mho22/raytracer",
      "delo run @foo/bar now",
      "delo destroy foo bar",
      "delo config foo bar",
      "delo add bash foo bar",
      "delo add bash foo --mode 600",
      "delo write /etc/foo --mode 600",
      "delo --mode 600",
      "run @foo/bar",
      "@foo/bar",
    ]) {
      assert.throws(() => parseDeloCommand(line), { message: DELO_USAGE });
    }
  });

  it("names every verb in the usage line", () => {
    assert.equal(DELO_USAGE, "usage: delo run | list | config | init | save | destroy [name] · delo add | remove | enable | disable [thing] [computer] · delo write [path] [computer] [--key value]");
  });
});

describe("isDeloVerb and isDeloChangeVerb", () => {
  it("tell a verb, and a verb that changes a computer, from any other word", () => {
    assert.deepEqual([undefined, "foo", "run", "write"].map(isDeloVerb), [false, false, true, true]);
    assert.deepEqual([undefined, "foo", "run", "write"].map(isDeloChangeVerb), [false, false, false, true]);
  });
});
