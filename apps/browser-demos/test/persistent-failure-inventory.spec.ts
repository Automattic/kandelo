import { expect } from "@playwright/test";
import { opfsTest as test } from "./support/opfs-page";
import { persistentFailureInventory } from "./support/persistent-failure-inventory";

test("failure capture includes only owned and control-referenced journal namespaces", async ({ page, baseURL }) => {
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const prefix = `wordpress-workload-${crypto.randomUUID()}`;
  const journals = Array.from({ length: 4 }, () => `j-${crypto.randomUUID()}`);
  const names = await page.evaluate(async ({ prefix, journals }) => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
    const entries = new Map<string, string>([
      [`${prefix}.base.json`, JSON.stringify({ format: "kandelo-fixed-rootfs-image-v5", journalName: journals[0] })],
      [`${prefix}.previous.base.json`, JSON.stringify({ format: "kandelo-fixed-rootfs-image-v4", journalName: "../unrelated" })],
      [`${prefix}.active.base.json`, JSON.stringify({ target: { format: "kandelo-fixed-rootfs-image-v5", journalName: journals[1] }, source: { format: "kandelo-fixed-rootfs-image-v5", journalName: journals[2] } })],
      [`${prefix}.base`, "base"],
      ["unrelated.base.json", JSON.stringify({ format: "kandelo-fixed-rootfs-image-v5", journalName: journals[3] })],
    ]);
    for (const journal of journals) {
      for (const suffix of ["journal", "g0.journal", "g0.index", "g0.seal", "activation0", "activation1", "unrelated"]) {
        entries.set(`${journal}.${suffix}`, suffix);
      }
    }
    for (const [name, bytes] of entries) {
      const writer = await (await directory.getFileHandle(name, { create: true })).createWritable();
      await writer.write(bytes);
      await writer.close();
    }
    return [...entries.keys()];
  }, { prefix, journals });
  try {
    const inventory = await persistentFailureInventory(page, prefix);
    expect(inventory.diagnostics).toEqual([]);
    const expected = names.filter(name => name.startsWith(`${prefix}.`)
      || journals.slice(0, 3).some(journal => name.startsWith(`${journal}.`) && !name.endsWith(".unrelated")));
    expect(inventory.files.map(file => file.name).sort()).toEqual(expected.sort());
    await expect(persistentFailureInventory(page, "unrelated")).rejects.toThrow("owned workload computer");
  } finally {
    await page.evaluate(async names => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
      for (const name of names) await directory.removeEntry(name);
    }, names);
  }
});
