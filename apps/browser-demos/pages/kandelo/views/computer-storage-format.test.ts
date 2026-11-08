import assert from "node:assert/strict";
import { test } from "node:test";
import { assertComputerStorageFormat, computerStorageFormatLabel, JOURNALED_OPFS_IMAGE_STORAGE_FORMAT } from "../../../../../web-libs/kandelo-session/src/computer-library";

test("journaled OPFS image storage has a stable versioned identifier and label", () => {
  assert.equal(JOURNALED_OPFS_IMAGE_STORAGE_FORMAT, "kandelo-opfs-image-v1");
  assert.doesNotThrow(() => assertComputerStorageFormat(JOURNALED_OPFS_IMAGE_STORAGE_FORMAT));
  assert.equal(computerStorageFormatLabel(JOURNALED_OPFS_IMAGE_STORAGE_FORMAT), "Journaled OPFS image");
});

for (const format of [undefined, null, "", "opfs", "kandelo-opfs-image-v2", "kandelo-opfs-files-v1", { format: JOURNALED_OPFS_IMAGE_STORAGE_FORMAT }, "x".repeat(129)]) {
  test(`unsupported computer storage format is refused: ${JSON.stringify(format)}`, () => {
    assert.throws(() => assertComputerStorageFormat(format), /Unsupported computer storage format/);
    assert.throws(() => computerStorageFormatLabel(format as never), /Unsupported computer storage format/);
  });
}
