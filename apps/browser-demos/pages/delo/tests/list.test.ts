import assert from "node:assert/strict";
import test from "node:test";

import { DELO_LIST_TABS, isDeloListTab } from "../src/list";

test("knows the five tabs, and opens on the pipelines", () => {
  assert.deepEqual(DELO_LIST_TABS.filter(isDeloListTab), ["pipelines", "binaries", "options", "images", "apps"]);
  assert.equal(DELO_LIST_TABS[0], "pipelines");
  for (const word of ["binary", "", "Images"]) assert.equal(isDeloListTab(word), false);
});
