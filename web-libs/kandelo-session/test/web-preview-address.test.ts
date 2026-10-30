import { describe, expect, it } from "vitest";
import { parseWebPreviewAddress, validateWebPreviewTarget } from "../src/web-preview-address";

describe("guest web preview addresses", () => {
  it("accepts local and network guest services without image declarations", () => {
    expect(parseWebPreviewAddress("localhost:3000/notes?q=yes#post")).toEqual({ hostname: "localhost", port: 3000, path: "/notes?q=yes#post" });
    for (const hostname of ["127.0.0.1", "host", "peer-1", "peer-254", "10.89.0.254"]) {
      expect(parseWebPreviewAddress(`http://${hostname}:8080/`).hostname).toBe(hostname);
    }
    expect(parseWebPreviewAddress("http://localhost/").port).toBe(80);
  });

  it("refuses external destinations, invalid peers, credentials and other schemes", () => {
    for (const address of ["https://localhost/", "javascript:alert(1)", "file:///etc/passwd", "http://example.com/", "http://user:secret@localhost/", "http://peer-0/", "http://peer-255/", "http://10.89.0.999/", "http://localhost:0/", "http://localhost:65536/", "http://localhost/\n", "http://localhost/\\evil", "http://localhost//evil", "localhost/" + "a".repeat(4096)]) {
      expect(() => parseWebPreviewAddress(address), address).toThrow();
    }
  });

  it("validates direct callers as well as parsed addresses", () => {
    for (const port of [NaN, 0, 65536, 3.5]) expect(() => validateWebPreviewTarget({ hostname: "localhost", port })).toThrow();
    for (const path of ["relative", "//elsewhere", "/\u001b", "/\\evil"]) expect(() => validateWebPreviewTarget({ hostname: "localhost", port: 80, path })).toThrow();
  });
});
