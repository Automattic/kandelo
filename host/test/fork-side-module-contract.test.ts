import { describe, expect, it } from "vitest";
import {
  checkSideModuleForkContract,
  parseForkSideModuleContract,
} from "../src/fork-side-module-contract";

const traced = parseForkSideModuleContract(
  "v1\nmode\ttraced-entries\naddress-taken\t0\nfork-returning\tfork\nfork-returning\tdaemon\n",
);

describe("fork side-module contract", () => {
  it("lets a side module that imports no fork-returning function load", () => {
    expect(() =>
      checkSideModuleForkContract(
        "libplain.so",
        [
          { module: "env", name: "posix_spawn", kind: "function" },
          { module: "GOT.mem", name: "environ", kind: "global" },
        ],
        traced,
      )
    ).not.toThrow();
  });

  it("refuses a side module that imports a fork-returning function", () => {
    expect(() =>
      checkSideModuleForkContract(
        "libforks.so",
        [{ module: "env", name: "fork", kind: "function" }],
        traced,
      )
    ).toThrow(/libforks\.so: refused .* imports fork/);
    expect(() =>
      checkSideModuleForkContract(
        "libptr.so",
        [{ module: "GOT.func", name: "daemon", kind: "global" }],
        traced,
      )
    ).toThrow(/imports daemon/);
  });

  it("refuses every side module when a fork-returning function is address-taken", () => {
    const contract = parseForkSideModuleContract(
      "v1\nmode\ttraced-entries\naddress-taken\t1\n",
    );
    expect(() => checkSideModuleForkContract("libany.so", [], contract))
      .toThrow(/address-taken/);
  });

  it("imposes nothing in assume-all mode or without a contract", () => {
    const all = parseForkSideModuleContract(
      "v1\nmode\tassume-all-entries-fork-returning\naddress-taken\t1\nfork-returning\tfork\n",
    );
    const forking = [{ module: "env", name: "fork", kind: "function" as const }];
    expect(() => checkSideModuleForkContract("lib.so", forking, all)).not.toThrow();
    expect(() => checkSideModuleForkContract("lib.so", forking, undefined)).not.toThrow();
  });

  it("rejects malformed contracts loudly", () => {
    expect(() => parseForkSideModuleContract("v2\n")).toThrow(/unsupported version/);
    expect(() => parseForkSideModuleContract("v1\nmode\tsometimes\naddress-taken\t0\n"))
      .toThrow(/unknown mode/);
    expect(() => parseForkSideModuleContract("v1\nmode\ttraced-entries\n"))
      .toThrow(/missing/);
  });
});
