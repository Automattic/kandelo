import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseCredentialRequests } from "../src/credential-requests";

const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const valid = {
  program: "/usr/bin/codex",
  title: "Codex",
  destinations: ["https://auth.openai.com", "https://api.openai.com"],
  launch: "wait",
};
const files = (...entries: [string, unknown][]) => new Map(entries.map(([name, value]) => [name, encode(value)]));
const rejects = (declaration: unknown, message: RegExp | string = /codex\.json/) =>
  expect(() => parseCredentialRequests(files(["codex.json", declaration]))).toThrow(message);

describe("parseCredentialRequests", () => {
  it("parses a declaration and keys it by program path", () => {
    const parsed = parseCredentialRequests(files(["codex.json", valid]));
    expect([...parsed.keys()]).toEqual(["/usr/bin/codex"]);
    expect(parsed.get("/usr/bin/codex")).toEqual(valid);
  });

  it("accepts no files and the continue launch policy", () => {
    expect(parseCredentialRequests(new Map()).size).toBe(0);
    expect(parseCredentialRequests(files(["a.json", { ...valid, launch: "continue" }])).get("/usr/bin/codex")?.launch).toBe("continue");
  });

  it("parses the Codex declaration the package installs", () => {
    const bytes = new Uint8Array(readFileSync(new URL("../../packages/registry/codex/credential-requests.json", import.meta.url)));
    expect(parseCredentialRequests(new Map([["codex.json", bytes]])).get("/usr/bin/codex")).toEqual({
      program: "/usr/bin/codex",
      title: "Codex",
      destinations: ["https://auth.openai.com", "https://chatgpt.com", "https://api.openai.com"],
      launch: "wait",
    });
  });

  it.each([
    ["http://example.com", "plain HTTP"],
    ["ftp://example.com", "non-HTTP scheme"],
    ["https://example.com/", "trailing slash"],
    ["https://example.com/path", "path"],
    ["https://example.com?q=1", "query"],
    ["https://example.com#frag", "fragment"],
    ["https://user@example.com", "userinfo"],
    ["https://example.com:443", "explicit default port"],
    ["https://EXAMPLE.com", "non-normalized host"],
    ["example.com", "bare host"],
    ["", "empty string"],
    ["*", "wildcard"],
  ])("rejects destination %s (%s)", destination => {
    rejects({ ...valid, destinations: [destination] });
  });

  it("keeps a non-default port in an origin", () => {
    const parsed = parseCredentialRequests(files(["a.json", { ...valid, destinations: ["https://example.com:8443"] }]));
    expect(parsed.get("/usr/bin/codex")?.destinations).toEqual(["https://example.com:8443"]);
  });

  it.each([
    "codex", "./codex", "/usr/bin/", "/usr//bin/codex", "/usr/./bin/codex", "/usr/../bin/codex", "/", "",
  ])("rejects program path %j", program => {
    rejects({ ...valid, program });
  });

  it("rejects an empty or duplicated destination list", () => {
    rejects({ ...valid, destinations: [] });
    rejects({ ...valid, destinations: ["https://a.example", "https://a.example"] });
    rejects({ ...valid, destinations: "https://a.example" });
  });

  it("rejects an unknown launch policy, a bad title, and unknown keys", () => {
    rejects({ ...valid, launch: "never" });
    rejects({ ...valid, launch: undefined });
    rejects({ ...valid, title: "" });
    rejects({ ...valid, title: 7 });
    rejects({ ...valid, extra: true });
  });

  it("rejects a title that could disguise itself in the prompt", () => {
    // Bidirectional controls reorder what the user reads ("Codex" could be
    // made to display as another name), other format characters hide
    // text, and line or paragraph separators break the one-line title.
    for (const character of [
      "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
      "\u2066", "\u2067", "\u2068", "\u2069",
      "\u200e", "\u200f", "\u061c",
      "\u200b", "\u2060", "\ufeff", "\u00ad",
      "\u2028", "\u2029", "\u0085",
    ]) {
      rejects({ ...valid, title: `Co${character}dex` }, /title/);
    }
    // Ordinary non-ASCII text is a title like any other.
    expect(parseCredentialRequests(files(["codex.json", { ...valid, title: "Códex – 日本語" }]))
      .get("/usr/bin/codex")!.title).toBe("Códex – 日本語");
  });

  it("accepts the zero-width joiners that Persian, Indic scripts and emoji need", () => {
    // ZWNJ (U+200C) keeps Persian "می‌خواهد" from joining its letters;
    // ZWJ (U+200D) forms Devanagari half-forms and emoji sequences. They
    // are format characters, but they change how a word is drawn, not
    // which characters it holds, so a title may contain them.
    for (const title of [
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u062f",
      "\u0915\u094d\u200d\u0937",
      "Codex \u{1f469}\u200d\u{1f4bb}",
    ]) {
      expect(parseCredentialRequests(files(["codex.json", { ...valid, title }]))
        .get("/usr/bin/codex")!.title).toBe(title);
    }
  });

  it("rejects a title with nothing visible in it", () => {
    // Whitespace, and the blank filler letters (Hangul fillers U+3164,
    // U+FFA0, U+115F, U+1160 and the empty Braille pattern U+2800) draw
    // nothing, so the prompt would show no name at all.
    for (const title of [
      " ", "   ", "\t", "\u00a0", "\u3000",
      "\u3164", "\uffa0", "\u115f", "\u1160", "\u2800",
      " \u3164 \u2800 ", "\u200c", "\u200d\u200c",
    ]) {
      rejects({ ...valid, title }, /title/);
    }
    // Blank characters around a visible name are allowed; the name shows.
    expect(parseCredentialRequests(files(["codex.json", { ...valid, title: " Codex\u3164" }]))
      .get("/usr/bin/codex")!.title).toBe(" Codex\u3164");
  });

  it("rejects malformed JSON, non-objects, and invalid UTF-8 with the file name", () => {
    rejects("{");
    rejects("[]");
    rejects("null");
    expect(() => parseCredentialRequests(new Map([["bad.json", new Uint8Array([0xff, 0xfe])]]))).toThrow(/bad\.json/);
  });

  it("rejects the same program declared by two files and names both", () => {
    expect(() => parseCredentialRequests(files(["a.json", valid], ["b.json", valid]))).toThrow(/a\.json.*b\.json|b\.json.*a\.json/);
  });

  it("names the failing file among several", () => {
    expect(() => parseCredentialRequests(files(["good.json", valid], ["bad.json", { ...valid, program: "/other", launch: "x" }]))).toThrow(/bad\.json/);
  });

  it("rejects oversized files", () => {
    expect(() => parseCredentialRequests(new Map([["big.json", new Uint8Array(70_000)]]))).toThrow(/big\.json/);
  });
});
