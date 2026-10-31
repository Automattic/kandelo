import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { ProgramPolicyFixture } from "../pages/program-policy-test/main";

test("isolates Rust metadata allocation failure and recovers offline", async ({ page, context }) => {
  test.setTimeout(90_000);
  const diagnostics: string[] = [];
  page.on("requestfailed", request => diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on("pageerror", error => diagnostics.push(error.message));
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    const urls = new Set<string>();
    const state = { created: 0, pending: 0 };
    URL.createObjectURL = (value) => {
      const url = create(value);
      urls.add(url);
      state.created += 1;
      state.pending = urls.size;
      return url;
    };
    URL.revokeObjectURL = (url) => { urls.delete(url); state.pending = urls.size; revoke(url); };
    (window as Window & { __programPolicyUrls: typeof state }).__programPolicyUrls = state;
  });
  const source = Array.from(readFileSync(new URL("../../../abi/program-fixtures/v55/raw-fork.wasm", import.meta.url)));
  const run = (bytes: number[], changes = {}) => page.evaluate(async ({ bytes, changes }) => {
    return (window as Window & { __programPolicy: ProgramPolicyFixture }).__programPolicy.inspect(bytes, changes);
  }, { bytes, changes });
  await page.goto("/pages/program-policy-test/");
  await page.evaluate(async () => {
    await (window as Window & { __programPolicy: ProgramPolicyFixture }).__programPolicy.initialize();
  });
  const initial = await run(source);
  expect(initial.active).toEqual({ jobs: 0, workspace: 0 });
  expect(initial.record).toHaveLength(160);
  expect(Buffer.from(initial.record!.slice(24, 56)).toString("hex"))
    .toBe(createHash("sha256").update(Uint8Array.from(source)).digest("hex"));
  await context.setOffline(true);
  const malformed = [0, 97, 115, 109, 1, 0, 0, 0, 1, 1, 255];
  for (const [bytes, changes, reason] of [
    [malformed, { heapBytes: malformed.length }, "allocation"],
    [malformed, {}, "invalid"],
    [source, { metadataBytes: 1 }, "metadata-limit"],
    [source, { workItems: 1 }, "work-limit"],
    [source, { abort: true }, "aborted"],
  ] as const) {
    const result = await run([...bytes], changes);
    expect(result, JSON.stringify({ result, diagnostics })).toMatchObject({ reason, active: { jobs: 0, workspace: 0 } });
  }
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const result = await run(source);
    expect(result).toEqual(initial);
  }
  await page.evaluate(async () => {
    await (window as Window & { __programPolicy: ProgramPolicyFixture }).__programPolicy.close();
  });
  expect(await run(source)).toMatchObject({ reason: "closed", active: { jobs: 0, workspace: 0 } });
  expect(await page.evaluate(() => (window as Window & { __programPolicyUrls: { created: number; pending: number } }).__programPolicyUrls))
    .toEqual({ created: 1, pending: 0 });
});
