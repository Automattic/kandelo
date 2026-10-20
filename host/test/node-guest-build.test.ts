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

describe("parseGuestBuildArgs", () => {
  it("parses the full flag set and the command after --", async () => {
    const { parseGuestBuildArgs } = await import("../../scripts/guest-build");
    expect(parseGuestBuildArgs([
      "--kernel", "/k.wasm",
      "--image", "/img.vfs.zst",
      "--workspace", "/w",
      "--input", "/deps/ncurses=/abs/ncurses",
      "--input", "/deps/zlib=/abs/zlib",
      "--env", "CC=cc",
      "--env", "CFLAGS=-O2 -g",
      "--timeout-ms", "900000",
      "--log", "/w/guest.log",
      "--source-date-epoch", "1704067200",
      "--", "/bin/sh", "-c", "make -j2",
    ])).toEqual({
      kernel: "/k.wasm",
      image: "/img.vfs.zst",
      log: "/w/guest.log",
      request: {
        workspace: "/w",
        inputs: [
          { guestPath: "/deps/ncurses", hostPath: "/abs/ncurses" },
          { guestPath: "/deps/zlib", hostPath: "/abs/zlib" },
        ],
        env: { CC: "cc", CFLAGS: "-O2 -g" },
        timeoutMs: 900000,
        sourceDateEpoch: 1704067200,
        argv: ["/bin/sh", "-c", "make -j2"],
      },
    });
  });

  it("refuses unknown flags, missing values, missing -- and missing required flags", async () => {
    const { parseGuestBuildArgs } = await import("../../scripts/guest-build");
    const required = [
      "--kernel", "/k", "--image", "/i", "--workspace", "/w",
      "--timeout-ms", "1000", "--source-date-epoch", "0",
    ];
    expect(() => parseGuestBuildArgs([...required, "--bogus", "x", "--", "/bin/sh"]))
      .toThrow(/--bogus/);
    expect(() => parseGuestBuildArgs([...required, "/bin/sh"])).toThrow(/--/);
    expect(() => parseGuestBuildArgs(["--kernel"])).toThrow(/--kernel/);
    expect(() => parseGuestBuildArgs(["--kernel", "/k", "--", "/bin/sh"]))
      .toThrow(/--image/);
    expect(() => parseGuestBuildArgs([...required, "--input", "nohost", "--", "/bin/sh"]))
      .toThrow(/--input/);
    expect(() => parseGuestBuildArgs([...required.slice(0, 6), "--timeout-ms", "soon",
      "--source-date-epoch", "0", "--", "/bin/sh"])).toThrow(/--timeout-ms/);
  });
});
