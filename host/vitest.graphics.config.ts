import { defineConfig } from "vitest/config";
import { readFileSync, readdirSync } from "node:fs";
import base from "./vitest.config.js";

const files = readdirSync(new URL("./test/", import.meta.url))
  .filter((name) => /^webgl-.*\.test\.ts$/.test(name))
  .map((name) => `test/${name}`);
files.push("test/kernel-public-scratch.test.ts");
files.push("test/dri-kms-gl-attach-ordering.test.ts");
const evidence = new Map(readFileSync(
  new URL("../scripts/ci-vitest-evidence-classes.tsv", import.meta.url), "utf8",
).split("\n").filter((line) => line && !line.startsWith("#"))
  .map((line) => line.split("\t") as [string, string]));
for (const file of files) {
  if (evidence.get(`host/${file}`) !== "source-only") {
    throw new Error(`Graphics source gate requires source-only evidence: ${file}`);
  }
}

// Pure command/state tests have no guest-artifact dependency. Guest-backed
// integration tests continue to use the ordinary config and its provisioning.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    globalSetup: [],
    include: files,
  },
});
