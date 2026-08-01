import path from "node:path";

const repo = "https://github.com/Automattic/kandelo";

const canonicalDocByPage = new Map([
  [
    "reference/homebrew-packaging-system.md",
    "docs/homebrew-packaging-system.md",
  ],
  ["reference/homebrew-publishing.md", "docs/homebrew-publishing.md"],
]);

const pageByCanonicalDoc = new Map(
  [...canonicalDocByPage].map(([page, canonicalDoc]) => [canonicalDoc, page]),
);

/**
 * Resolve links as if included Homebrew Markdown still lived under docs/.
 *
 * VitePress resolves an included file's links from its wrapper page. Keep
 * links between the two published references inside the guide. Point links
 * to other repository documentation at its canonical GitHub source instead
 * of creating more wrappers or silently publishing broken routes.
 */
export function rewriteHomebrewDocHref(page, href) {
  const canonicalDoc = canonicalDocByPage.get(page);
  if (
    canonicalDoc === undefined ||
    href === "" ||
    href.startsWith("#") ||
    href.startsWith("/") ||
    href.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(href)
  ) {
    return href;
  }

  const match = href.match(/^([^?#]*)([?#].*)?$/);
  if (match === null || match[1] === "") {
    return href;
  }

  const target = path.posix.normalize(
    path.posix.join(path.posix.dirname(canonicalDoc), match[1]),
  );
  if (target.startsWith("../")) {
    return href;
  }

  const publishedPage = pageByCanonicalDoc.get(target);
  if (publishedPage !== undefined) {
    const relative = path.posix.relative(path.posix.dirname(page), publishedPage);
    return `${relative.startsWith(".") ? relative : `./${relative}`}${match[2] ?? ""}`;
  }

  return `${repo}/blob/main/${target}${match[2] ?? ""}`;
}

export function prepareHomebrewDocTokens(tokens, page) {
  for (const token of tokens) {
    if (token.type === "code_inline" && token.content.includes("{{")) {
      // WHY: GitHub Actions expressions use Vue's interpolation delimiters.
      // Protect only the affected inline code so VitePress can still collect
      // the surrounding document headings for its page outline.
      token.attrSet("v-pre", "");
    }
    if (token.type === "link_open") {
      const href = token.attrGet("href");
      if (href !== null) {
        token.attrSet("href", rewriteHomebrewDocHref(page, href));
      }
    }
    if (token.children !== null) {
      prepareHomebrewDocTokens(token.children, page);
    }
  }
}
