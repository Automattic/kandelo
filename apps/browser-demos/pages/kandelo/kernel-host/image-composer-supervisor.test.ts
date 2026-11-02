import assert from "node:assert/strict";
import test from "node:test";

import type { ComposeImageJob } from "./image-composer";
import type { ComposerToMainMessage } from "./image-composer-protocol";
import {
  COMPOSER_START_DEADLINE_MS,
  superviseComposerWorker,
  type ComposerWorkerLike,
} from "./image-composer-supervisor";

class FakeComposerWorker implements ComposerWorkerLike {
  onmessage: ((event: MessageEvent<ComposerToMainMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posted = 0;
  terminated = 0;
  postMessage(): void { this.posted++; }
  terminate(): void { this.terminated++; }
  send(data: ComposerToMainMessage): void {
    this.onmessage?.({ data } as MessageEvent<ComposerToMainMessage>);
  }
}

const job = { imageBytes: new Uint8Array(4) } as unknown as ComposeImageJob;
const options = {
  onTick: () => {},
  isCurrent: () => true,
  supersededError: () => new Error("superseded"),
};

test("a composer worker that never starts becomes a visible boot error", async () => {
  assert.equal(COMPOSER_START_DEADLINE_MS, 30_000);
  const worker = new FakeComposerWorker();
  const started = Date.now();
  await assert.rejects(
    superviseComposerWorker(worker, job, { ...options, startDeadlineMs: 50 }),
    /image composer worker did not start within 0.05 s/,
  );
  assert.ok(Date.now() - started >= 45);
  assert.equal(worker.posted, 1);
  assert.equal(worker.terminated, 1, "the never-started worker is terminated");
});

test("a started composer has no start deadline for the composition itself", async () => {
  const worker = new FakeComposerWorker();
  const ticks: string[] = [];
  const composed = superviseComposerWorker(worker, job, {
    ...options,
    onTick: (message) => ticks.push(message),
    startDeadlineMs: 50,
  });
  worker.send({ type: "started" });
  // Longer than the start deadline: composing may take as long as it takes.
  await new Promise((resolve) => setTimeout(resolve, 120));
  worker.send({ type: "tick", message: "composing" });
  worker.send({ type: "done", imageBytes: new Uint8Array(2) } as unknown as ComposerToMainMessage);
  const result = await composed;
  assert.equal((result as unknown as { imageBytes: Uint8Array }).imageBytes.byteLength, 2);
  assert.deepEqual(ticks, ["composing"]);
  assert.equal(worker.terminated, 1);
});

test("a worker error before it starts is reported, not left to the deadline", async () => {
  const worker = new FakeComposerWorker();
  const composed = superviseComposerWorker(worker, job, { ...options, startDeadlineMs: 10_000 });
  worker.onerror?.({ message: "SyntaxError in chunk" } as ErrorEvent);
  await assert.rejects(composed, /image composer worker error: SyntaxError in chunk/);
  assert.equal(worker.terminated, 1);
});
