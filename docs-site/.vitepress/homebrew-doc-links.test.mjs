import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareHomebrewDocTokens,
  rewriteHomebrewDocHref,
} from "./homebrew-doc-links.mjs";

const packagingPage = "reference/homebrew-packaging-system.md";
const publishingPage = "reference/homebrew-publishing.md";

test("keeps links between the published Homebrew references local", () => {
  assert.equal(
    rewriteHomebrewDocHref(packagingPage, "homebrew-publishing.md"),
    "./homebrew-publishing.md",
  );
  assert.equal(
    rewriteHomebrewDocHref(publishingPage, "homebrew-packaging-system.md"),
    "./homebrew-packaging-system.md",
  );
});

test("routes other repository docs to their canonical GitHub source", () => {
  assert.equal(
    rewriteHomebrewDocHref(
      packagingPage,
      "porting-guide.md#homebrew-formula-authoring",
    ),
    "https://github.com/Automattic/kandelo/blob/main/docs/porting-guide.md" +
      "#homebrew-formula-authoring",
  );
  assert.equal(
    rewriteHomebrewDocHref(
      publishingPage,
      "plans/2026-07-21-homebrew-migration-execution-plan.md",
    ),
    "https://github.com/Automattic/kandelo/blob/main/docs/plans/" +
      "2026-07-21-homebrew-migration-execution-plan.md",
  );
});

test("does not rewrite external, absolute, anchor, or unrelated links", () => {
  for (const href of [
    "https://example.com/reference",
    "mailto:maintainer@example.com",
    "/guide/current-ui",
    "#native-and-target-dependency-realms",
  ]) {
    assert.equal(rewriteHomebrewDocHref(packagingPage, href), href);
  }
  assert.equal(
    rewriteHomebrewDocHref("reference/api-stability.md", "other.md"),
    "other.md",
  );
});

test("protects GitHub Actions expressions without hiding document headings", () => {
  const attributes = new Map();
  const heading = {
    type: "heading_open",
    children: null,
  };
  const expression = {
    type: "code_inline",
    content: "${{ github.sha }}",
    children: null,
    attrSet(name, value) {
      attributes.set(name, value);
    },
  };

  prepareHomebrewDocTokens([heading, expression], publishingPage);

  assert.equal(attributes.get("v-pre"), "");
  assert.equal(heading.type, "heading_open");
});
