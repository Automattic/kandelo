import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createDeloDraft, type DeloConfiguration } from "../src/draft";
import { parseDeloRegistry } from "../src/registry";
import { deloEnabledOptions, deloInstalled, planDeloAdd, planDeloDisable, planDeloEnable, planDeloRemove, planDeloWrite } from "../src/packages";

function pkg(name: string, fields: { use?: string[]; need?: string[]; provide?: string[] } = {}) {
  return { name, type: "binary", description: name, files: [{ to: `/etc/${name}`, content: name }], ...fields };
}

function option(name: string, fields: { use?: string[]; need?: string[] } = {}) {
  return { name, type: "option", description: name, ...fields };
}

const REGISTRY = parseDeloRegistry(JSON.stringify({
  schema: 1,
  entries: [
    pkg("foo", { provide: ["init", "shell"] }),
    pkg("bar", { provide: ["init", "shell"] }),
    pkg("baz", { provide: ["init"] }),
    pkg("qux"),
    { name: "fred", type: "pipeline", description: "fred", files: [{ to: "/etc/dinit.d/boot", content: "type = internal\n" }] },
    { name: "plugh", type: "pipeline", description: "plugh", use: ["foo"], enable: ["theme"], provide: ["user"], files: [{ to: "/plugh", type: "directory" }, { to: "/etc/foo", content: "plugh" }] },
    { name: "xyzzy", type: "pipeline", description: "xyzzy", need: ["user"], files: [{ to: "/plugh", content: "xyzzy" }] },
    { name: "thud", type: "pipeline", description: "thud", files: [{ to: "/etc/thud", content: "thud" }] },
    { name: "fum", type: "pipeline", description: "fum", files: [{ to: "/etc/qux", content: "fum" }] },
    pkg("quux", { use: ["qux"], need: ["shell"] }),
    pkg("corge", { use: ["quux"] }),
    pkg("grault", { use: ["qux"] }),
    option("theme", { use: ["qux"] }),
    option("internals", { need: ["shell"] }),
  ],
}));

const { name: _, ...EMPTY } = createDeloDraft("waldo");

const apply = (...steps: ((configuration: DeloConfiguration) => { configuration: DeloConfiguration })[]) =>
  steps.reduce((configuration, step) => step(configuration).configuration, EMPTY);

const add = (name: string) => (configuration: DeloConfiguration) => planDeloAdd(REGISTRY, configuration, name);
const enable = (name: string) => (configuration: DeloConfiguration) => planDeloEnable(REGISTRY, configuration, name);

const installed = (configuration: DeloConfiguration) => deloInstalled(REGISTRY, configuration).map((entry) => entry.name);

describe("deloInstalled", () => {
  it("installs each binary of a cycle once", () => {
    const registry = parseDeloRegistry(JSON.stringify({
      schema: 1,
      entries: [pkg("foo", { use: ["bar"] }), pkg("bar", { use: ["baz"] }), pkg("baz", { use: ["foo"] })],
    }));
    const names = (use: string) => deloInstalled(registry, { ...EMPTY, pipeline: { ...EMPTY.pipeline, use: [use] } }).map((entry) => entry.name);
    assert.deepEqual(names("foo"), ["baz", "bar", "foo"]);
    assert.deepEqual(names("bar"), ["foo", "baz", "bar"]);
  });

  it("refuses a use that is not a registered binary, and an enable that is not a registered option", () => {
    const using = (use: string) => () => deloInstalled(REGISTRY, { ...EMPTY, pipeline: { ...EMPTY.pipeline, use: [use] } });
    assert.throws(using("garply"), { message: "garply is not a registered binary" });
    assert.throws(using("thud"), { message: "thud is not a registered binary" });
    assert.throws(() => deloInstalled(REGISTRY, { ...EMPTY, pipeline: { ...EMPTY.pipeline, enable: ["garply"] } }), { message: "garply is not a registered option" });
  });
});

describe("planDeloAdd", () => {
  it("puts a binary in the pipeline, and makes the first binary that can be the first process start an empty computer", () => {
    const plan = planDeloAdd(REGISTRY, EMPTY, "foo");
    assert.deepEqual(plan.configuration, { pipeline: { ...EMPTY.pipeline, use: ["foo"] }, firstProcess: "foo", added: [] });
    assert.deepEqual(plan.installed, ["foo"]);
    assert.deepEqual(plan.warnings, []);
  });

  it("leaves the first process alone when the computer already has one", () => {
    assert.equal(planDeloAdd(REGISTRY, apply(add("foo")), "baz").configuration.firstProcess, "foo");
  });

  it("installs dependencies first, skips the installed ones, and uses only the named binary", () => {
    const plan = planDeloAdd(REGISTRY, apply(add("qux")), "corge");
    assert.deepEqual(plan.installed, ["quux", "corge"]);
    assert.deepEqual(installed(plan.configuration), ["qux", "quux", "corge"]);
    assert.deepEqual(plan.configuration.pipeline.use, ["qux", "corge"]);
  });

  it("uses a binary already installed as a dependency, and installs nothing", () => {
    const plan = planDeloAdd(REGISTRY, apply(add("corge")), "qux");
    assert.deepEqual(plan.installed, []);
    assert.deepEqual(installed(plan.configuration), ["qux", "quux", "corge"]);
    assert.deepEqual(plan.configuration.pipeline.use, ["corge", "qux"]);
  });

  it("warns about a need nothing fills, and names every package that fills it", () => {
    const plan = planDeloAdd(REGISTRY, EMPTY, "quux");
    assert.equal(plan.configuration.firstProcess, null);
    assert.deepEqual(plan.warnings, ["quux needs a shell. Add one: delo add foo or delo add bar"]);
    assert.deepEqual(planDeloAdd(REGISTRY, apply(add("foo")), "quux").warnings, []);
  });

  it("refuses an unknown name, a used binary and an added pipeline", () => {
    assert.throws(() => planDeloAdd(REGISTRY, EMPTY, "garply"), { message: "garply is not a registered binary or pipeline" });
    assert.throws(() => planDeloAdd(REGISTRY, apply(add("foo")), "foo"), { message: "foo is already installed" });
    assert.throws(() => planDeloAdd(REGISTRY, apply(add("plugh")), "plugh"), { message: "plugh is already added" });
  });
});

describe("a pipeline added to a computer", () => {
  it("is copied into the computer's pipeline, with its binaries and its options", () => {
    const plan = planDeloAdd(REGISTRY, apply(add("qux")), "plugh");
    assert.deepEqual(plan.configuration, {
      pipeline: { ...EMPTY.pipeline, use: ["qux", "foo"], enable: ["theme"], provide: ["user"], files: [{ to: "/plugh", type: "directory" }, { to: "/etc/foo", content: "plugh" }] },
      firstProcess: "foo",
      added: ["plugh"],
    });
    assert.deepEqual(plan.installed, ["foo"]);
    assert.deepEqual(plan.enabled, ["theme"]);
    assert.deepEqual(deloEnabledOptions(REGISTRY, plan.configuration), ["theme"]);
  });

  it("merges into what the computer has, and fills the needs of a later pipeline", () => {
    const plan = planDeloAdd(REGISTRY, apply(add("plugh")), "thud");
    assert.deepEqual(plan.configuration.pipeline.files.map((file) => file.to), ["/plugh", "/etc/foo", "/etc/thud"]);
    assert.deepEqual(plan.configuration.added, ["plugh", "thud"]);
    assert.deepEqual(planDeloAdd(REGISTRY, EMPTY, "xyzzy").warnings, ["xyzzy needs a user. Add one: delo add plugh"]);
  });

  it("refuses a pipeline that writes a path the computer has, by name, unless both write text there", () => {
    assert.throws(() => planDeloAdd(REGISTRY, apply(add("plugh")), "xyzzy"), { message: "xyzzy writes /plugh, which the computer already has" });
    assert.deepEqual(planDeloAdd(REGISTRY, apply(add("qux")), "fum").configuration.pipeline.files, [{ to: "/etc/qux", content: "fum" }]);
  });

  it("is not a unit: remove refuses it, its options are disabled one by one, and its appends keep their binary", () => {
    const plugh = apply(add("plugh"));
    assert.throws(() => planDeloRemove(REGISTRY, plugh, "plugh"), { message: "plugh is a pipeline the computer has a copy of. Remove its binaries one by one." });
    const plan = planDeloDisable(REGISTRY, plugh, "theme");
    assert.deepEqual(plan.removed, ["qux"]);
    assert.deepEqual(plan.disabled, ["theme"]);
    assert.throws(() => planDeloRemove(REGISTRY, plan.configuration, "foo"), { message: "The computer's pipeline adds to /etc/foo, which foo writes." });
  });
});

describe("planDeloRemove", () => {
  it("removes the binary and every dependency only it kept", () => {
    const plan = planDeloRemove(REGISTRY, apply(add("foo"), add("corge")), "corge");
    assert.deepEqual(plan.removed, ["qux", "quux", "corge"]);
    assert.deepEqual(plan.configuration, { pipeline: { ...EMPTY.pipeline, use: ["foo"] }, firstProcess: "foo", added: [] });
    assert.deepEqual(plan.warnings, []);
  });

  it("keeps a dependency that a used binary, another binary or an option still needs", () => {
    assert.deepEqual(planDeloRemove(REGISTRY, apply(add("qux"), add("grault")), "grault").removed, ["grault"]);
    assert.deepEqual(planDeloRemove(REGISTRY, apply(add("corge"), add("grault")), "grault").removed, ["grault"]);
    assert.deepEqual(planDeloRemove(REGISTRY, apply(enable("theme"), add("grault")), "grault").removed, ["grault"]);
  });

  it("refuses a binary that an installed binary or an enabled option depends on", () => {
    assert.throws(() => planDeloRemove(REGISTRY, apply(add("qux"), add("grault")), "qux"), { message: "grault depends on qux. Remove grault first." });
    assert.throws(() => planDeloRemove(REGISTRY, apply(add("qux"), enable("theme")), "qux"), { message: "theme depends on qux. Disable theme first." });
  });

  it("says only the terminal has nothing to run when the pipeline still starts the machine", () => {
    const plan = planDeloRemove(REGISTRY, apply(add("fred"), add("foo")), "foo");
    assert.deepEqual(plan.warnings, ["foo is the first process. The terminal will have nothing to run."]);
  });

  it("clears a removed first process and warns about it and about a need left unfilled", () => {
    const plan = planDeloRemove(REGISTRY, apply(add("foo"), add("quux")), "foo");
    assert.equal(plan.configuration.firstProcess, null);
    assert.deepEqual(plan.warnings, [
      "foo is the first process. The computer will have nothing to run.",
      "quux needs a shell. Add one: delo add foo or delo add bar",
    ]);
  });

  it("refuses a binary the computer does not have", () => {
    assert.throws(() => planDeloRemove(REGISTRY, apply(add("foo")), "qux"), { message: "qux is not installed" });
  });
});

describe("planDeloWrite and the removal of a path", () => {
  it("puts the file in the pipeline, replaces the file at its path, and remove deletes it", () => {
    const one = planDeloWrite(REGISTRY, EMPTY, { to: "/etc/waldo", content: "waldo" });
    assert.deepEqual(one.configuration.pipeline.files, [{ to: "/etc/waldo", content: "waldo" }]);
    const two = planDeloWrite(REGISTRY, one.configuration, { to: "/etc/waldo", type: "symlink", from: "/etc/garply" });
    assert.deepEqual(two.configuration.pipeline.files, [{ to: "/etc/waldo", type: "symlink", from: "/etc/garply" }]);
    assert.deepEqual(planDeloRemove(REGISTRY, two.configuration, "/etc/waldo").configuration, EMPTY);
  });

  it("edits the copy of an added pipeline, which stays named as added", () => {
    const plan = planDeloRemove(REGISTRY, apply(add("thud")), "/etc/thud");
    assert.deepEqual(plan.configuration, { ...EMPTY, added: ["thud"] });
  });

  it("adds text to a path a binary writes and refuses another file or a mode there, a tool file with another name, and a path the pipeline does not write", () => {
    const withFoo = apply(add("foo"));
    const plan = planDeloWrite(REGISTRY, withFoo, { to: "/etc/foo", content: "waldo" });
    assert.deepEqual(plan.configuration.pipeline.files, [{ to: "/etc/foo", content: "waldo" }]);
    assert.deepEqual(plan.warnings, ["foo writes /etc/foo: the content goes at the end of it."]);
    assert.deepEqual(planDeloWrite(REGISTRY, EMPTY, { to: "/etc/foo", content: "waldo" }).warnings, []);
    assert.throws(() => planDeloWrite(REGISTRY, withFoo, { to: "/etc/foo", from: "https://example.com/waldo" }), { message: "foo writes /etc/foo. Write another path, or remove foo." });
    assert.throws(() => planDeloWrite(REGISTRY, withFoo, { to: "/etc/foo", content: "waldo", mode: "600" }), { message: "foo writes /etc/foo, which keeps its mode. Write it without a mode." });
    assert.throws(() => planDeloWrite(REGISTRY, EMPTY, { to: "/etc/mcp/binary_waldo.json", content: "{}" }), /the pipeline writes \/etc\/mcp\/binary_waldo\.json, but a pipeline names its tool files/);
    assert.throws(() => planDeloRemove(REGISTRY, EMPTY, "/etc/waldo"), { message: "the pipeline writes no file at /etc/waldo" });
  });

  it("refuses text on a path a binary writes from a source", () => {
    const registry = parseDeloRegistry(JSON.stringify({
      schema: 1,
      entries: [
        { name: "foo", type: "binary", description: "foo", files: [{ to: "/usr/bin/foo", from: "programs/wasm32/foo.wasm" }] },
        { name: "bar", type: "pipeline", description: "bar", files: [{ to: "/usr/bin/foo", content: "bar" }] },
      ],
    }));
    const withFoo = planDeloAdd(registry, EMPTY, "foo").configuration;
    assert.throws(() => planDeloWrite(registry, withFoo, { to: "/usr/bin/foo", content: "waldo" }), { message: "foo writes /usr/bin/foo. Write another path, or remove foo." });
    assert.throws(() => planDeloAdd(registry, withFoo, "bar"), { message: "bar writes /usr/bin/foo, which the computer already has" });
  });

  it("refuses a pipeline that gives a mode to text a binary writes", () => {
    const registry = parseDeloRegistry(JSON.stringify({
      schema: 1,
      entries: [
        { name: "foo", type: "binary", description: "foo", files: [{ to: "/etc/foo", content: "foo" }] },
        { name: "bar", type: "pipeline", description: "bar", files: [{ to: "/etc/foo", content: "bar", mode: "600" }] },
        { name: "baz", type: "pipeline", description: "baz", use: ["foo"], files: [{ to: "/etc/foo", content: "baz", mode: "600" }] },
      ],
    }));
    const withFoo = planDeloAdd(registry, EMPTY, "foo").configuration;
    const message = (name: string) => ({ message: `${name} writes /etc/foo with a mode, but a binary writes it and it keeps its mode` });
    assert.throws(() => planDeloAdd(registry, withFoo, "bar"), message("bar"));
    assert.throws(() => planDeloAdd(registry, EMPTY, "baz"), message("baz"));
    assert.deepEqual(planDeloAdd(registry, EMPTY, "bar").configuration.pipeline.files, [{ to: "/etc/foo", content: "bar", mode: "600" }]);
  });
});

describe("planDeloEnable and planDeloDisable", () => {
  it("installs the option's dependencies, keeps the options in registry order, and never picks the first process", () => {
    const plan = planDeloEnable(REGISTRY, apply(enable("internals")), "theme");
    assert.deepEqual(plan.installed, ["qux"]);
    assert.deepEqual(plan.configuration, { pipeline: { ...EMPTY.pipeline, enable: ["theme", "internals"] }, firstProcess: null, added: [] });
    assert.deepEqual(planDeloEnable(REGISTRY, apply(add("foo")), "theme").configuration.firstProcess, "foo");
  });

  it("warns about a need of the option that nothing fills", () => {
    assert.deepEqual(planDeloEnable(REGISTRY, EMPTY, "internals").warnings, ["internals needs a shell. Add one: delo add foo or delo add bar"]);
  });

  it("removes the dependencies only the disabled option kept", () => {
    assert.deepEqual(planDeloDisable(REGISTRY, apply(enable("theme")), "theme").removed, ["qux"]);
    assert.deepEqual(planDeloDisable(REGISTRY, apply(add("grault"), enable("theme")), "theme").removed, []);
  });

  it("refuses an unknown option, an enabled option, and a disabled option", () => {
    assert.throws(() => planDeloEnable(REGISTRY, EMPTY, "library"), { message: "library is not an option. Options: theme, internals" });
    assert.throws(() => planDeloEnable(REGISTRY, apply(enable("theme")), "theme"), { message: "theme is already enabled" });
    assert.throws(() => planDeloDisable(REGISTRY, EMPTY, "theme"), { message: "theme is not enabled" });
  });
});

describe("the tracked registry", () => {
  const registry = parseDeloRegistry(readFileSync(new URL("../src/registry.json", import.meta.url), "utf8"));

  it("makes login the first process of an empty computer, and warns that it needs a shell and a user", () => {
    const plan = planDeloAdd(registry, EMPTY, "login");
    assert.deepEqual(plan.installed, ["login"]);
    assert.equal(plan.configuration.firstProcess, "login");
    assert.deepEqual(plan.warnings, ["login needs a shell. Add one: delo add bash or delo add dash", "login needs a user. Add one: delo add maker-account"]);
  });

  it("makes bash the first process of an empty computer", () => {
    assert.equal(planDeloAdd(registry, EMPTY, "bash").configuration.firstProcess, "bash");
  });

  it("refuses to remove base-files while maker-account's copy appends to its /etc/passwd", () => {
    const maker = planDeloAdd(registry, EMPTY, "maker-account").configuration;
    assert.deepEqual(maker.pipeline.use, ["base-files"]);
    assert.throws(() => planDeloRemove(registry, maker, "base-files"), { message: "The computer's pipeline adds to /etc/passwd /etc/group /etc/shadow, which base-files writes." });
  });
});
