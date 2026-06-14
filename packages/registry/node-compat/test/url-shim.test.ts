import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import querystring from "node:querystring";
import path from "node:path";
import util from "node:util";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bootstrapPath = join(__dirname, "../bootstrap.js");

function loadUrlShim() {
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const start = bootstrap.indexOf("const url = (() => {");
  const end = bootstrap.indexOf("// ============================================================\n// querystring module", start);
  if (start === -1 || end === -1) {
    throw new Error("could not locate node-compat URL module");
  }
  const source = `${bootstrap.slice(start, end)}\nurl;`;
  return vm.runInNewContext(source, {
    path: path.posix,
    querystring,
    util,
    TextEncoder,
    TextDecoder,
    URL: undefined,
    URLSearchParams: undefined,
  });
}

describe("node-compat URL shim", () => {
  const shim = loadUrlShim();
  const { URL, URLSearchParams, urlToHttpOptions } = shim;

  it("exposes URL.canParse and urlToHttpOptions with Node-compatible shapes", () => {
    expect(URL.canParse("https://example.org")).toBe(true);
    expect(URL.canParse("/", "http://n")).toBe(true);
    expect(URL.canParse("/")).toBe(false);
    expect(() => URL.canParse()).toThrowError(
      expect.objectContaining({ code: "ERR_MISSING_ARGS" }),
    );

    const opts = urlToHttpOptions(new URL("http://user:pass@foo.bar.com:21/aaa/zzz?l=24#test"));
    expect(opts).toMatchObject({
      protocol: "http:",
      auth: "user:pass",
      hostname: "foo.bar.com",
      port: 21,
      path: "/aaa/zzz?l=24",
      pathname: "/aaa/zzz",
      search: "?l=24",
      hash: "#test",
    });
    expect(urlToHttpOptions(new URL("http://[::1]:21")).hostname).toBe("::1");

    const copied = { ...new URL("http://user:pass@foo.bar.com:21/aaa/zzz?l=24#test") };
    expect(urlToHttpOptions(copied)).toMatchObject({
      protocol: undefined,
      auth: undefined,
      hostname: undefined,
      port: Number.NaN,
      path: "",
      pathname: undefined,
      search: undefined,
      hash: undefined,
      href: undefined,
    });
  });

  it("exports the legacy resolveObject helper", () => {
    expect(shim.resolveObject("", "foo")).toBe("foo");
    expect(shim.resolveObject("/foo/bar", "baz")).toMatchObject({
      pathname: "/foo/baz",
      path: "/foo/baz",
      href: "/foo/baz",
    });
  });

  it("keeps WHATWG URL properties on the prototype and setters synchronized", () => {
    const url = new URL("http://user:pass@foo.bar.com:21/aaa/zzz?l=24#test");
    const props: string[] = [];
    for (const prop in url) props.push(prop);
    expect(props).toEqual([
      "toString",
      "href",
      "origin",
      "protocol",
      "username",
      "password",
      "host",
      "hostname",
      "port",
      "pathname",
      "search",
      "searchParams",
      "hash",
      "toJSON",
    ]);
    expect(Object.keys(url)).toEqual([]);

    const oldParams = url.searchParams;
    url.href = "http://example.org/?a=1";
    expect(url.searchParams).toBe(oldParams);
    expect(String(url.searchParams)).toBe("a=1");

    url.protocol = "https:";
    url.username = "user2";
    url.password = "pass2";
    url.host = "foo.bar.net:22";
    url.hostname = "foo.bar.org";
    url.port = "23";
    url.pathname = "/aaa/bbb";
    url.search = "?k=99";
    url.hash = "#abcd";

    expect(url.href).toBe("https://user2:pass2@foo.bar.org:23/aaa/bbb?k=99#abcd");
    expect(url.origin).toBe("https://foo.bar.org:23");
    expect(String(url.searchParams)).toBe("k=99");
    expect(util.inspect(url)).toBe(`URL {
  href: 'https://user2:pass2@foo.bar.org:23/aaa/bbb?k=99#abcd',
  origin: 'https://foo.bar.org:23',
  protocol: 'https:',
  username: 'user2',
  password: 'pass2',
  host: 'foo.bar.org:23',
  hostname: 'foo.bar.org',
  port: '23',
  pathname: '/aaa/bbb',
  search: '?k=99',
  searchParams: URLSearchParams { 'k' => '99' },
  hash: '#abcd'
}`);
    expect(delete (url as { href?: string }).href).toBe(true);
    expect(url.href).toBe("https://user2:pass2@foo.bar.org:23/aaa/bbb?k=99#abcd");
  });

  it("uses internal URL state for stringification even when subclasses override accessors", () => {
    const url = new (class extends URL {
      get hostname() {
        return "bar.com";
      }
    })("http://foo.com/");

    expect(url.href).toBe("http://foo.com/");
    expect(url.toString()).toBe("http://foo.com/");
    expect(url.toJSON()).toBe("http://foo.com/");
    expect(url.host).toBe("foo.com");
    expect(url.hostname).toBe("bar.com");
    expect(url.origin).toBe("http://foo.com");
  });

  it("preserves duplicate URLSearchParams pairs and implements constructors, sort, and inspect", () => {
    expect(Object.keys(URLSearchParams.prototype)).toEqual([
      "size",
      "append",
      "delete",
      "get",
      "getAll",
      "has",
      "set",
      "sort",
      "entries",
      "forEach",
      "keys",
      "values",
      "toString",
    ]);

    const params = new URLSearchParams("?a=a&b=b&b=c");
    expect(params.get("b")).toBe("b");
    expect(params.getAll("b")).toEqual(["b", "c"]);
    expect(Array.from(params)).toEqual([
      ["a", "a"],
      ["b", "b"],
      ["b", "c"],
    ]);
    expect(params[Symbol.iterator]).toBe(params.entries);
    expect(util.inspect(params)).toBe("URLSearchParams { 'a' => 'a', 'b' => 'b', 'b' => 'c' }");
    expect(util.inspect(params.keys())).toBe("URLSearchParams Iterator { 'a', 'b', 'b' }");

    params.append("a", "2");
    params.set("b", "z");
    expect(Array.from(params)).toEqual([
      ["a", "a"],
      ["b", "z"],
      ["a", "2"],
    ]);
    params.sort();
    expect(Array.from(params)).toEqual([
      ["a", "a"],
      ["a", "2"],
      ["b", "z"],
    ]);

    expect(new URLSearchParams({ hasOwnProperty: 1 }).toString()).toBe("hasOwnProperty=1");
    expect(new URLSearchParams([["key", "val"], ["key2", "val2"]]).toString()).toBe("key=val&key2=val2");
    expect(() => new URLSearchParams([[1]])).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_TUPLE" }),
    );
    expect(() => new URLSearchParams({ [Symbol("test")]: 42 })).toThrow(
      /Cannot convert a Symbol value to a string/,
    );
    expect(() => params.get()).toThrowError(
      expect.objectContaining({ code: "ERR_MISSING_ARGS" }),
    );
    expect(() => params.append("a")).toThrowError(
      expect.objectContaining({ code: "ERR_MISSING_ARGS" }),
    );
    expect(() => params.entries.call(undefined).next()).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_THIS" }),
    );
    expect(() => params.keys().next.call(undefined)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_THIS" }),
    );
  });

  it("keeps URLSearchParams mutations linked to their owning URL", () => {
    const url = new URL("http://example.org");
    url.searchParams.append("a", "a");
    url.searchParams.append("a", 1);
    url.searchParams.append("space", "x y");
    expect(url.href).toBe("http://example.org/?a=a&a=1&space=x+y");
    url.search = "";
    expect(url.href).toBe("http://example.org/");
    expect(url.searchParams.size).toBe(0);
  });
});
