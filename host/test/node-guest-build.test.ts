import { describe, expect, it } from "vitest";

import { validateGuestBuildRequest } from "../src/node-guest-build";

const base = {
  workspace: "/abs/work",
  argv: ["/bin/sh", "-c", "true"],
  sourceDateEpoch: 1704067200,
  timeoutMs: 60_000,
};

describe("validateGuestBuildRequest", () => {
  it("mounts the workspace read-write at /build and runs there", () => {
    const plan = validateGuestBuildRequest(base);
    expect(plan.mounts).toEqual([
      { mountPoint: "/build", hostPath: "/abs/work", readonly: false },
    ]);
    expect(plan.cwd).toBe("/build");
  });

  it("mounts declared inputs read-only at their guest paths", () => {
    const plan = validateGuestBuildRequest({
      ...base,
      inputs: [{ guestPath: "/deps/ncurses", hostPath: "/abs/ncurses" }],
    });
    expect(plan.mounts).toContainEqual({
      mountPoint: "/deps/ncurses",
      hostPath: "/abs/ncurses",
      readonly: true,
    });
  });

  it("refuses mounts the in-kernel tmpfs would shadow", () => {
    for (const guestPath of ["/tmp", "/tmp/deps", "/root/x", "/var/log"]) {
      expect(() => validateGuestBuildRequest({
        ...base,
        inputs: [{ guestPath, hostPath: "/abs/deps" }],
      }), guestPath).toThrow(/tmpfs/);
    }
  });

  it("refuses relative, unnormalized and duplicate paths", () => {
    expect(() => validateGuestBuildRequest({ ...base, workspace: "rel" }))
      .toThrow(/absolute/);
    expect(() => validateGuestBuildRequest({
      ...base,
      inputs: [{ guestPath: "/deps/../etc", hostPath: "/abs/x" }],
    })).toThrow(/normalized/);
    expect(() => validateGuestBuildRequest({
      ...base,
      inputs: [{ guestPath: "/build", hostPath: "/abs/x" }],
    })).toThrow(/already mounted/);
    expect(() => validateGuestBuildRequest({
      ...base,
      inputs: [{ guestPath: "/build/sub", hostPath: "/abs/x" }],
    })).toThrow(/inside/);
  });

  it("builds the exact guest environment, base keys first", () => {
    expect(validateGuestBuildRequest({ ...base, env: { CC: "cc" } }).env)
      .toEqual([
        "PATH=/usr/bin:/bin",
        "HOME=/build/.home",
        "TMPDIR=/build/.tmp",
        "LC_ALL=C",
        "TZ=UTC0",
        "SOURCE_DATE_EPOCH=1704067200",
        "CC=cc",
      ]);
  });

  it("refuses an environment entry that would replace a base key", () => {
    expect(() => validateGuestBuildRequest({ ...base, env: { PATH: "/x" } }))
      .toThrow(/PATH/);
  });

  it("refuses an empty command, a bad epoch and a bad timeout", () => {
    expect(() => validateGuestBuildRequest({ ...base, argv: [] })).toThrow(/argv/);
    expect(() => validateGuestBuildRequest({ ...base, sourceDateEpoch: -1 }))
      .toThrow(/sourceDateEpoch/);
    expect(() => validateGuestBuildRequest({ ...base, timeoutMs: 0 }))
      .toThrow(/timeoutMs/);
  });
});
