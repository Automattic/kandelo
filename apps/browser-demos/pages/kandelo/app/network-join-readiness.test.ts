import assert from "node:assert/strict";
import test from "node:test";
import { networkJoinReadiness } from "./network-join-readiness";

const ready = { running: true, ready: true, busy: false };

test("a failed peer join never presents green readiness", () => {
  assert.deepEqual(networkJoinReadiness({ ...ready, error: "peer connection failed" }), { tone: "error", message: "Couldn’t join. Try again." });
  assert.deepEqual(networkJoinReadiness({ ...ready, error: "activity rejected", busy: true, progress: "Connecting" }), { tone: "error", message: "Couldn’t join. Try again." });
});

test("readiness reflects real computer, catalog, transfer and retry state", () => {
  assert.deepEqual(networkJoinReadiness({ ...ready, failed: true }), { tone: "error", message: "Computer failed to start." });
  assert.deepEqual(networkJoinReadiness({ ...ready, running: false }), { tone: "working", message: "Starting computer…" });
  assert.deepEqual(networkJoinReadiness({ ...ready, ready: false }), { tone: "working", message: "Loading activity…" });
  assert.deepEqual(networkJoinReadiness({ ...ready, busy: true }), { tone: "working", message: "Connecting to host…" });
  assert.deepEqual(networkJoinReadiness({ ...ready, progress: "Receiving files" }), { tone: "working", message: "Receiving files" });
  assert.deepEqual(networkJoinReadiness(ready), { tone: "success", message: "Ready to join." });
});

test("an invalid activity remains a validation failure, not retryable readiness", () => {
  assert.deepEqual(networkJoinReadiness({ ...ready, invitationError: "Manifest mismatch" }), { tone: "error", message: "Cannot join this activity." });
});
