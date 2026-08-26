import { describe, expect, it } from "vitest";

import {
  BROWSER_MITM_CA_BUNDLE_PATH,
  withBrowserMitmCaEnv,
} from "../src/networking/browser-mitm-ca-env";

const CAINFO = `GIT_SSL_CAINFO=${BROWSER_MITM_CA_BUNDLE_PATH}`;
const CA_BUNDLE = `CURL_CA_BUNDLE=${BROWSER_MITM_CA_BUNDLE_PATH}`;

describe("withBrowserMitmCaEnv", () => {
  it("appends the git and libcurl CA variables pointing at the MITM bundle", () => {
    expect(withBrowserMitmCaEnv(["PATH=/usr/bin", "HOME=/home/maker"])).toEqual([
      "PATH=/usr/bin",
      "HOME=/home/maker",
      CAINFO,
      CA_BUNDLE,
    ]);
  });

  it("returns a fresh array without mutating the input", () => {
    const input = ["PATH=/usr/bin"];
    const result = withBrowserMitmCaEnv(input);
    expect(result).not.toBe(input);
    expect(input).toEqual(["PATH=/usr/bin"]);
  });

  it("does not override a demo-provided value of the same name", () => {
    const input = [
      "GIT_SSL_CAINFO=/custom/git-ca.pem",
      "PATH=/usr/bin",
    ];
    const result = withBrowserMitmCaEnv(input);
    // The explicit GIT_SSL_CAINFO is preserved and not duplicated; only the
    // missing CURL_CA_BUNDLE is added.
    expect(result).toEqual([
      "GIT_SSL_CAINFO=/custom/git-ca.pem",
      "PATH=/usr/bin",
      CA_BUNDLE,
    ]);
    expect(result.filter((e) => e.startsWith("GIT_SSL_CAINFO="))).toHaveLength(1);
  });

  it("adds nothing when both variables are already present", () => {
    const input = [CA_BUNDLE, "PATH=/usr/bin", CAINFO];
    expect(withBrowserMitmCaEnv(input)).toEqual(input);
  });

  it("matches only on the exact NAME= prefix, not a substring", () => {
    // A variable whose value merely contains the name must not suppress it.
    const input = ["OTHER=GIT_SSL_CAINFO=x"];
    expect(withBrowserMitmCaEnv(input)).toEqual([
      "OTHER=GIT_SSL_CAINFO=x",
      CAINFO,
      CA_BUNDLE,
    ]);
  });
});
