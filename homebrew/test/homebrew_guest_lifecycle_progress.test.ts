import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedHomebrewGuestProgress,
} from "./homebrew_guest_lifecycle_progress";

const encoder = new TextEncoder();

test("streams only complete lifecycle progress across byte chunks", () => {
  const output: string[] = [];
  const progress = new BoundedHomebrewGuestProgress(
    (text) => output.push(text),
  );

  progress.push(encoder.encode("Homebrew package noise\nhomebrew-guest-life"));
  progress.push(encoder.encode(
    "cycle: tapping core\r\n" +
      "KANDELO_HOMEBREW_GUEST_CORE_SHIPPING_PROOF_OK\n",
  ));

  assert.deepEqual(output, [
    "homebrew_guest_lifecycle_node: progress: " +
      "homebrew-guest-lifecycle: tapping core\n",
    "homebrew_guest_lifecycle_node: progress: " +
      "KANDELO_HOMEBREW_GUEST_CORE_SHIPPING_PROOF_OK\n",
  ]);
});

test("bounds progress line length and emitted line count", () => {
  const output: string[] = [];
  const progress = new BoundedHomebrewGuestProgress(
    (text) => output.push(text),
    { maximumLines: 1, maximumLineCharacters: 48 },
  );

  progress.push(encoder.encode(
    `homebrew-guest-lifecycle: ${"x".repeat(80)}\n` +
      "homebrew-guest-lifecycle: first\n" +
      "homebrew-guest-lifecycle-reboot: second\n" +
      "homebrew-guest-lifecycle: third\n",
  ));

  assert.deepEqual(output, [
    "homebrew_guest_lifecycle_node: progress: " +
      "homebrew-guest-lifecycle: first\n",
    "homebrew_guest_lifecycle_node: progress: output limit reached\n",
  ]);
});

test("rejects invalid progress bounds", () => {
  assert.throws(
    () => new BoundedHomebrewGuestProgress(() => {}, { maximumLines: 0 }),
    /positive integers/,
  );
  assert.throws(
    () =>
      new BoundedHomebrewGuestProgress(
        () => {},
        { maximumLineCharacters: 1.5 },
      ),
    /positive integers/,
  );
});
