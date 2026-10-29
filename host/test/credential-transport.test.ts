import { describe, expect, it } from "vitest";
import {
  browserCredentialTransport,
  directCredentialTransport,
} from "../src/credential-transport";

// What a credential prompt says about the path each credentialed request
// takes (`CredentialRequest.transport`): the intermediary that can read the
// credentials, computed from the same proxy configuration the kernel
// worker's `BrowserCorsProxy` and the development relay use.

const OPENAI = ["https://auth.openai.com", "https://chatgpt.com", "https://api.openai.com"];

function proxyConfig(url: string, relay?: { url: string; allowedOrigins: string[] }) {
  return {
    url,
    allowedRequestHeaderNames: [],
    allowAnonymousGetHeaderOmission: true,
    ...(relay === undefined ? {} : { credentialRelay: relay }),
  };
}

describe("credential transport", () => {
  it("names a configured proxy's origin and path for every destination", () => {
    const plan = browserCredentialTransport(
      proxyConfig("https://kandelo-codex-test.space.fast/cors-proxy?url="),
    );
    expect(plan(OPENAI)).toEqual([{
      kind: "proxy",
      via: "https://kandelo-codex-test.space.fast/cors-proxy",
      destinations: OPENAI,
    }]);
  });

  it("names a proxy at the root of its origin by its origin, without its query or user info", () => {
    expect(browserCredentialTransport(
      proxyConfig("https://user:secret@wordpress-playground-cors-proxy.net/?"),
    )(["https://chatgpt.com"])).toEqual([{
      kind: "proxy",
      via: "https://wordpress-playground-cors-proxy.net",
      destinations: ["https://chatgpt.com"],
    }]);
  });

  it("splits destinations between the development relay and the proxy", () => {
    const plan = browserCredentialTransport(proxyConfig("http://127.0.0.1:5481/__kandelo_cors_proxy?url=", {
      url: "http://127.0.0.1:5481/__kandelo_credential_relay",
      allowedOrigins: ["https://chatgpt.com", "https://api.openai.com"],
    }));
    expect(plan(["https://auth.openai.com", "https://chatgpt.com", "https://example.test", "https://api.openai.com"]))
      .toEqual([
        {
          kind: "proxy",
          via: "http://127.0.0.1:5481/__kandelo_cors_proxy",
          destinations: ["https://auth.openai.com", "https://example.test"],
        },
        {
          kind: "relay",
          via: "http://127.0.0.1:5481/__kandelo_credential_relay",
          destinations: ["https://chatgpt.com", "https://api.openai.com"],
        },
      ]);
  });

  it("names only the relay when it carries every destination", () => {
    const plan = browserCredentialTransport(proxyConfig("https://proxy.test/?", {
      url: "http://localhost:5499/__kandelo_credential_relay",
      allowedOrigins: OPENAI,
    }));
    expect(plan(OPENAI)).toEqual([{
      kind: "relay",
      via: "http://localhost:5499/__kandelo_credential_relay",
      destinations: OPENAI,
    }]);
  });

  it("says a browser with no proxy cannot send credentials at all", () => {
    expect(browserCredentialTransport(undefined)(OPENAI)).toEqual([
      { kind: "none", destinations: OPENAI },
    ]);
  });

  it("says a Node program connects directly", () => {
    expect(directCredentialTransport(OPENAI)).toEqual([
      { kind: "direct", destinations: OPENAI },
    ]);
  });

  it("validates the configuration it describes, as the proxy does", () => {
    expect(() => browserCredentialTransport(proxyConfig("not a url"))).toThrow(TypeError);
  });

  it("returns fresh arrays, so a prompt cannot change another's", () => {
    const plan = browserCredentialTransport(proxyConfig("https://proxy.test/p?url="));
    const first = plan(OPENAI);
    expect(first[0].destinations).not.toBe(OPENAI);
    expect(plan(OPENAI)).not.toBe(first);
  });
});
