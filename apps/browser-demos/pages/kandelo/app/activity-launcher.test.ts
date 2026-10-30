import assert from "node:assert/strict";
import { test } from "node:test";
import { activityConflicts, activityPorts, canLaunchLocally, installedActivityChoices } from "./activity-launcher";
import type { InstalledPackageSessions, SessionOfferType } from "../../../../../web-libs/kandelo-session/src/package-sessions";

const program: SessionOfferType = {
  id: "app", title: "App", description: "An installed app", join: "client", attachExisting: true, fields: [],
  launch: { executable: "/usr/bin/app", args: [], cwd: "/", requires: [], surface: "terminal" },
};

test("independent terminal activities coexist, but the same instance or exclusive display conflicts", () => {
  assert.equal(activityConflicts({ identity: "chat", display: false }, { identity: "server", display: false }), false);
  assert.equal(activityConflicts({ identity: "chat", display: false }, { identity: "chat", display: false }), true);
  assert.equal(activityConflicts({ identity: "game", display: true }, { identity: "desktop", display: true }), true);
  assert.equal(activityConflicts({ identity: "database", display: false }, { identity: "desktop", display: true }), false);
  assert.equal(activityConflicts({ identity: "php", display: false, ports: [8080] }, { identity: "python", display: false, ports: [8080] }), true);
  assert.equal(activityConflicts({ identity: "php", display: false, ports: [8080] }, { identity: "database", display: false, ports: [3306] }), false);
});

test("local launching accepts declared terminal, display and localhost preview procedures", () => {
  assert.equal(canLaunchLocally(program), true);
  assert.equal(canLaunchLocally({ ...program, launch: { ...program.launch!, surface: "display" } as SessionOfferType["launch"] }), true);
  assert.equal(canLaunchLocally({ ...program, launch: { surface: "web", host: "localhost", port: 80, path: "/" } }), true);
});

test("a remote host reference or share-only service is not advertised as a local launch", () => {
  assert.equal(canLaunchLocally({ ...program, launch: undefined }), false);
  assert.equal(canLaunchLocally({ ...program, launch: { surface: "web", host: "network.host", port: 80, path: "/" } }), false);
  assert.equal(canLaunchLocally({ ...program, launch: { executable: "/usr/bin/app", args: [{ field: "network.host" }], cwd: "/", requires: [], surface: "terminal" } }), false);
});

test("the launcher excludes unavailable and client-only offers and orders installed declarations", () => {
  const entry: InstalledPackageSessions = { sha256: "digest", manifest: {
    kind: "kandelo-package-sessions", version: 1, package: "example", packageVersion: "1", joins: [],
    offers: [{ ...program, id: "zebra", title: "Zebra" }, { ...program, id: "alpha", title: "Alpha" }, { ...program, id: "absent", title: "Absent" }],
  }, unavailableOffers: ["absent"] };
  assert.deepEqual(installedActivityChoices([entry, { ...entry, clientOnly: true }]).map(choice => choice.key), ["example/alpha", "example/zebra"]);
  entry.manifest.joins = [{ id: "client", title: "Open", description: "Open service", fields: [], launch: { surface: "web", host: "network.host", port: 8080, path: "/" } }];
  assert.deepEqual(activityPorts(entry, program), [8080]);
});
