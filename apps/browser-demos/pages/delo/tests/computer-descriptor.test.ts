import assert from "node:assert/strict";
import test from "node:test";

import { validateBootDescriptor } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import { hasOpfsRoot } from "../../../../../web-libs/kandelo-session/src/browser-computer-store";
import { deloComputerDescriptor } from "../src/computer-descriptor";

test("is a valid descriptor that mounts its root from OPFS", () => {
  const descriptor = deloComputerDescriptor("corge");
  validateBootDescriptor(descriptor);
  assert.equal(descriptor.title, "corge");
  assert.equal(hasOpfsRoot(descriptor), true);
});
