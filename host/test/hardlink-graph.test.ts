import { describe, expect, it } from "vitest";
import {
  resolveHardlinkGraph,
  type HardlinkGraphNode,
} from "../src/vfs/hardlink-graph";

const FILE: HardlinkGraphNode = {
  path: "/runtime/tool",
  type: "file",
  mode: 0o755,
  size: 7,
  inodeGroup: "runtime:tool",
};

describe("hardlink graph resolution", () => {
  it("path-compresses a long valid chain to its canonical file", () => {
    const nodes: HardlinkGraphNode[] = [FILE];
    let target = FILE.path;
    for (let index = 0; index < 20_000; index += 1) {
      const path = `/runtime/link-${index.toString().padStart(5, "0")}`;
      nodes.push({
        path,
        type: "hardlink",
        mode: FILE.mode,
        size: FILE.size,
        inodeGroup: FILE.inodeGroup,
        target,
      });
      target = path;
    }

    const resolved = resolveHardlinkGraph(nodes, "Test tree");

    expect(resolved.canonicalTargetByPath.size).toBe(20_000);
    expect(resolved.canonicalTargetByPath.get(target)).toBe(FILE);
  });

  it("rejects a cycle reached through a non-cyclic tail", () => {
    const nodes: HardlinkGraphNode[] = [
      FILE,
      link("/runtime/tail", "/runtime/cycle-a"),
      link("/runtime/cycle-a", "/runtime/cycle-b"),
      link("/runtime/cycle-b", "/runtime/cycle-a"),
    ];

    expect(() => resolveHardlinkGraph(nodes, "Test tree"))
      .toThrow(/cycle reaches/);
  });

  it("rejects missing and cross-inode targets", () => {
    expect(() =>
      resolveHardlinkGraph([
        FILE,
        link("/runtime/missing", "/runtime/absent"),
      ], "Test tree")
    ).toThrow(/target .* is missing/);

    expect(() =>
      resolveHardlinkGraph([
        FILE,
        {
          path: "/runtime/other",
          type: "file",
          mode: FILE.mode,
          size: FILE.size,
          inodeGroup: "runtime:other",
        },
        link("/runtime/cross", "/runtime/other"),
      ], "Test tree")
    ).toThrow(/invalid target/);
  });
});

function link(path: string, target: string): HardlinkGraphNode {
  return {
    path,
    target,
    type: "hardlink",
    mode: FILE.mode,
    size: FILE.size,
    inodeGroup: FILE.inodeGroup,
  };
}
