import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  prepareHomebrewDocTokens,
  rewriteHomebrewDocHref,
} from "./homebrew-doc-links.mjs";

const packagingPage = "reference/homebrew-packaging-system.md";
const publishingPage = "reference/homebrew-publishing.md";
const currentPublicationHeading =
  "Current ABI-42 shell publication (2026-08-11)";
const currentPublicationDocs = [
  "package-management.md",
  "binary-releases.md",
  "browser-support.md",
  "homebrew-publishing.md",
];

function currentPublicationSection(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex(
    (line) => line.replace(/^#{2,6} /, "") === currentPublicationHeading,
  );
  assert.notEqual(start, -1, `${name} must contain the dated current section`);
  const heading = /^(#{2,6}) /.exec(lines[start]);
  assert.ok(heading, `${name} current section must use a Markdown heading`);
  const level = heading[1].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = /^(#{1,6}) /.exec(lines[index]);
    if (next && next[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

test("documents the current canonical flat-shell publication contract", () => {
  for (const name of currentPublicationDocs) {
    const source = readFileSync(
      new URL(`../../docs/${name}`, import.meta.url),
      "utf8",
    );
    const current = currentPublicationSection(source, name);
    for (const contract of [
      "`homebrew/main-shell-flat-selection.json`",
      "canonical package release",
      "self-contained `/opt/kandelo/homebrew`",
      "post-activation Pages dispatch",
    ]) {
      assert.ok(
        current.includes(contract),
        `${name} current section must name ${contract}`,
      );
    }
    assert.doesNotMatch(
      current,
      /shell revision 23[^\n.]*(?:pending|unpublished)/i,
      `${name} must not describe shell revision 23 as pending`,
    );
    assert.doesNotMatch(
      current,
      /Pages[^\n.]*(?:lazy mirror|bottle mirror|mirror consumer)/i,
      `${name} must not describe Pages as a lazy-mirror consumer`,
    );
    assert.doesNotMatch(current, /--require-sealed-homebrew-selection/);
  }
});

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
