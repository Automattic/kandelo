import assert from "node:assert/strict";
import test from "node:test";
import { createDeloDraft } from "../src/draft";

test("a draft starts with an empty pipeline, with nothing to run", () => {
  assert.deepEqual(createDeloDraft("corge"), {
    name: "corge",
    pipeline: { name: "corge-pipeline", description: "", use: [], enable: [], provide: [], need: [], device: [], files: [] },
    firstProcess: null,
    added: [],
  });
});
