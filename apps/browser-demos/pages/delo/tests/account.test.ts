import assert from "node:assert/strict";
import test from "node:test";
import { deloAccountName } from "../src/account";
import type { DeloPackage } from "../src/registry";

const pkg = (files: DeloPackage["files"]): DeloPackage => ({
  name: "foo",
  type: "binary",
  description: "foo",
  files,
  use: [],
  enable: [],
  provide: [],
  need: [],
  device: [],
});

test("names a uid from the /etc/passwd an installed package adds", () => {
  const passwd = pkg([{ to: "/etc/passwd", content: "bar:x:0:0:bar:/root:/bin/sh\nbaz:x:1000:1000::/home/baz:/bin/sh\n" }]);
  assert.equal(deloAccountName([passwd], 0), "bar");
  assert.equal(deloAccountName([passwd], 1000), "baz");
});

test("gives the bare uid when no installed package names it", () => {
  assert.equal(deloAccountName([], 0), "uid 0");
  assert.equal(deloAccountName([pkg([{ to: "/etc/qux", content: "qux:x:0:0::/:/bin/sh\n" }])], 0), "uid 0");
});
