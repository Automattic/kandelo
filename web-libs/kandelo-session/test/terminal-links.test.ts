import { describe, expect, it } from "vitest";
import {
  classifyTerminalLink,
  type TerminalLinkContext,
} from "../src/terminal-links";

const PAGE = "https://kandelo.dev/kandelo/#k1=some-secret-boot-descriptor";

/** A machine whose HTTP bridge forwards port 8080 to /kandelo/computer/muscat/. */
const bridged: TerminalLinkContext = {
  pageUrl: PAGE,
  machine: { url: "/kandelo/computer/muscat/", port: 8080 },
};

/** The same page with no HTTP bridge running. */
const unbridged: TerminalLinkContext = { pageUrl: PAGE, machine: null };

describe("classifyTerminalLink", () => {
  describe("third-party links", () => {
    it("opens a cross-origin URL without a referrer", () => {
      expect(classifyTerminalLink("https://example.com/docs", bridged)).toEqual({
        kind: "external",
        href: "https://example.com/docs",
        sendReferrer: false,
      });
    });

    it("treats a different port on the page's host as cross-origin", () => {
      const target = classifyTerminalLink("https://kandelo.dev:8443/x", bridged);
      expect(target).toMatchObject({ kind: "external", sendReferrer: false });
    });

    it("treats a different scheme on the page's host as cross-origin", () => {
      const target = classifyTerminalLink("http://kandelo.dev/x", bridged);
      expect(target).toMatchObject({ kind: "external", sendReferrer: false });
    });

    it("still classifies when the page URL is unparseable", () => {
      const target = classifyTerminalLink("https://example.com/", {
        pageUrl: "not a url",
      });
      expect(target).toMatchObject({ kind: "external", sendReferrer: false });
    });
  });

  describe("the hosting site", () => {
    it("sends a referrer to a same-origin URL", () => {
      expect(classifyTerminalLink("https://kandelo.dev/gallery", bridged)).toEqual({
        kind: "machine",
        href: "https://kandelo.dev/gallery",
        sendReferrer: true,
      });
    });
  });

  describe("loopback URLs printed inside the machine", () => {
    it("rewrites the bridged port onto the machine's web surface", () => {
      expect(classifyTerminalLink("http://localhost:8080/wp-admin/", bridged)).toEqual({
        kind: "machine",
        href: "https://kandelo.dev/kandelo/computer/muscat/wp-admin/",
        sendReferrer: true,
      });
    });

    it("preserves query and fragment through the rewrite", () => {
      const target = classifyTerminalLink("http://127.0.0.1:8080/x?a=1&b=2#frag", bridged);
      expect(target).toEqual({
        kind: "machine",
        href: "https://kandelo.dev/kandelo/computer/muscat/x?a=1&b=2#frag",
        sendReferrer: true,
      });
    });

    it.each([
      "http://localhost:8080/",
      "http://127.0.0.1:8080/",
      "http://127.1.2.3:8080/",
      "http://0.0.0.0:8080/",
      "http://[::1]:8080/",
      "http://[::]:8080/",
      "http://LOCALHOST:8080/",
    ])("recognizes %s as the machine", (raw) => {
      expect(classifyTerminalLink(raw, bridged)).toMatchObject({ kind: "machine" });
    });

    it("uses the scheme default port when none is written", () => {
      const onPort80: TerminalLinkContext = {
        pageUrl: PAGE,
        machine: { url: "/kandelo/computer/muscat/", port: 80 },
      };
      expect(classifyTerminalLink("http://localhost/", onPort80)).toMatchObject({
        kind: "machine",
        href: "https://kandelo.dev/kandelo/computer/muscat/",
      });
    });

    it("refuses a loopback port the bridge does not forward", () => {
      const target = classifyTerminalLink("http://localhost:3000/", bridged);
      expect(target?.kind).toBe("unreachable");
      expect(target).toMatchObject({ reason: expect.stringContaining("8080") });
    });

    it("refuses any loopback URL when no bridge is running", () => {
      expect(classifyTerminalLink("http://localhost:8080/", unbridged)).toMatchObject({
        kind: "unreachable",
      });
      expect(classifyTerminalLink("http://localhost:8080/", { pageUrl: PAGE })).toMatchObject({
        kind: "unreachable",
      });
    });

    it("keeps the rewrite inside the surface root", () => {
      // URL parsing normalizes `..` before we see it, so this lands on
      // /kandelo/computer/muscat/etc/passwd rather than escaping the app prefix.
      const target = classifyTerminalLink("http://localhost:8080/../../etc/passwd", bridged);
      expect(target).toEqual({
        kind: "machine",
        href: "https://kandelo.dev/kandelo/computer/muscat/etc/passwd",
        sendReferrer: true,
      });
    });

    it("accepts a surface URL written without a trailing slash", () => {
      const target = classifyTerminalLink("http://localhost:8080/a", {
        pageUrl: PAGE,
        machine: { url: "/kandelo/computer/muscat", port: 8080 },
      });
      expect(target).toMatchObject({ href: "https://kandelo.dev/kandelo/computer/muscat/a" });
    });

    it("accepts an absolute surface URL", () => {
      const target = classifyTerminalLink("http://localhost:8080/a", {
        pageUrl: PAGE,
        machine: { url: "https://kandelo.dev/kandelo/computer/muscat/", port: 8080 },
      });
      expect(target).toMatchObject({ href: "https://kandelo.dev/kandelo/computer/muscat/a" });
    });
  });

  describe("non-links", () => {
    it.each([
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "mailto:someone@example.com",
      "not a url at all",
      "",
    ])("does not linkify %j", (raw) => {
      expect(classifyTerminalLink(raw, bridged)).toBeNull();
    });
  });
});
