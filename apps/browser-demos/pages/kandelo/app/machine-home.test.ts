import assert from "node:assert/strict";
import test from "node:test";

import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host.ts";
import { exchangeUser, machineHome, passwdHome } from "./machine-home.ts";

test("exchange.conf names its user after comments and blank lines", () => {
  assert.equal(exchangeUser("# foo\n\nuser bar  # baz\n"), "bar");
});

test("exchange.conf with another line or a second user names no one", () => {
  assert.equal(exchangeUser("user bar\nqux quux\n"), null);
  assert.equal(exchangeUser("user bar\nuser baz\n"), null);
  assert.equal(exchangeUser("user\n"), null);
  assert.equal(exchangeUser("# foo\n"), null);
});

test("passwd gives the home of the named user", () => {
  const passwd = "foo:x:0:0:foo:/root:/bin/sh\nbar:x:1000:1000:bar:/home/bar:/bin/sh\n";
  assert.equal(passwdHome(passwd, "bar"), "/home/bar");
  assert.equal(passwdHome(passwd, "baz"), null);
  assert.equal(passwdHome("bar:x:1000:1000:bar::/bin/sh\n", "bar"), null);
});

function host(files: Record<string, string>): KernelHost {
  return {
    readVfsFile: async (path: string) => (path in files ? new TextEncoder().encode(files[path]) : null),
  } as unknown as KernelHost;
}

test("the machine opens in the exchange account's home", async () => {
  assert.equal(await machineHome(host({
    "/etc/kandelo/exchange.conf": "user bar\n",
    "/etc/passwd": "bar:x:1000:1000:bar:/home/bar:/bin/sh\n",
  })), "/home/bar");
});

test("a machine without exchange.conf, passwd or the account opens at /", async () => {
  assert.equal(await machineHome(host({ "/etc/passwd": "bar:x:1000:1000:bar:/home/bar:/bin/sh\n" })), "/");
  assert.equal(await machineHome(host({ "/etc/kandelo/exchange.conf": "user bar\n" })), "/");
  assert.equal(await machineHome(host({
    "/etc/kandelo/exchange.conf": "user baz\n",
    "/etc/passwd": "bar:x:1000:1000:bar:/home/bar:/bin/sh\n",
  })), "/");
});
