import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  POSIX_ARG_MAX_BYTES,
  POSIX_IOV_MAX,
  POSIX_PATH_MAX_BYTES,
  SPAWN_MAX_ACTION_COUNT,
  SPAWN_MAX_ARGV_COUNT,
  SPAWN_MAX_ENVP_COUNT,
  SPAWN_WIRE_ACTION_RECORD_BYTES,
  SPAWN_WIRE_HEADER_BYTES,
  SPAWN_WIRE_MAX_BYTES,
} from "../src/generated/abi";

const workerSource = readFileSync(
  new URL("../src/kernel-worker.ts", import.meta.url),
  "utf8",
);
const kernelSource = readFileSync(
  new URL("../src/kernel.ts", import.meta.url),
  "utf8",
);
const browserWorkerSource = readFileSync(
  new URL("../src/browser-kernel-worker-entry.ts", import.meta.url),
  "utf8",
);
const scratchSource = readFileSync(
  new URL("../src/kernel-scratch.ts", import.meta.url),
  "utf8",
);
const platformLimitsHeader = readFileSync(
  new URL(
    "../../libc/musl-overlay/include/bits/kandelo_limits.h",
    import.meta.url,
  ),
  "utf8",
);
const publicLimitsHeader = readFileSync(
  new URL("../../libc/musl-overlay/include/limits.h", import.meta.url),
  "utf8",
);
const spawnContractHeader = readFileSync(
  new URL(
    "../../libc/musl-overlay/src/process/wasm32posix/spawn_contract.h",
    import.meta.url,
  ),
  "utf8",
);
const buildMuslSource = readFileSync(
  new URL("../../scripts/build-musl.sh", import.meta.url),
  "utf8",
);
const epollDiagnosticSource = readFileSync(
  new URL("../../apps/browser-demos/test/epoll-repro.ts", import.meta.url),
  "utf8",
);
const opfsFixtureSource = readFileSync(
  new URL(
    "../../apps/browser-demos/test/fixtures/opfs-advisory-lock-client-worker.ts",
    import.meta.url,
  ),
  "utf8",
);

function enclosingMethodName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) && current.name) {
      return current.name.getText();
    }
  }
  return "<module>";
}

function rawMemoryViewMethods(
  source: string,
  memoryExpression: string,
): string[] {
  const file = ts.createSourceFile(
    "kernel-worker.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const methods: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node)
      && (
        node.expression.getText(file) === "Uint8Array"
        || node.expression.getText(file) === "DataView"
        || node.expression.getText(file) === "Int32Array"
      )
      && node.getText(file).includes(memoryExpression)
    ) {
      methods.push(enclosingMethodName(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return methods.sort();
}

function receiverCallMethods(
  source: string,
  receiver: string,
  method: string,
): string[] {
  const file = ts.createSourceFile(
    "kernel-memory-write.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const methods: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === method
      && node.expression.expression.getText(file) === receiver
    ) {
      methods.push(enclosingMethodName(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return methods.sort();
}

function bareScratchPointerMethods(source: string): string[] {
  const file = ts.createSourceFile(
    "kernel-worker.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const methods: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node)
      && node.expression.kind === ts.SyntaxKind.ThisKeyword
      && node.name.text === "scratchOffset"
    ) {
      methods.push(enclosingMethodName(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return methods.sort();
}

describe("kernel scratch static contract", () => {
  it("does not expose a bare main scratch pointer", () => {
    expect(bareScratchPointerMethods(workerSource)).toEqual([]);
  });

  it("does not construct raw kernel-memory views", () => {
    // A new variable-size transfer must use KernelScratchRegion/Lease. Adding
    // a raw typed view here requires an explicit review and allowlist.
    expect(rawMemoryViewMethods(workerSource, "this.kernelMemory")).toEqual([]);
    expect(rawMemoryViewMethods(browserWorkerSource, "kernelMemory")).toEqual([]);
    expect(workerSource).not.toMatch(/\bkernelMem\s*\.set\s*\(/);
    expect(workerSource).not.toMatch(/\bkernelBuf\s*\.set\s*\(/);
  });

  it("keeps native allocation views inside the checked lease implementation", () => {
    // These are the only methods allowed to construct a native view over an
    // allocator-owned region. Each obtains its range through ownedRange()
    // before creating the view.
    expect(
      rawMemoryViewMethods(scratchSource, "this.currentMemoryBuffer()"),
    ).toEqual([
      "copyFrom",
      "copyOut",
      "copyTo",
      "dataView",
      "fill",
    ]);
    expect(scratchSource).toContain(
      "private readonly pointer: number",
    );
    expect(scratchSource).toContain(
      "private readonly memory: WebAssembly.Memory",
    );
    expect(scratchSource).toContain(
      "dataView(offset: number, length: number): KernelScratchDataView",
    );
  });

  it("keeps separate scratch owners private and capacity-carrying", () => {
    expect(workerSource).not.toContain("tcpScratchOffset");
    expect(workerSource).not.toContain("largeSpawnScratchOffset");
    expect(browserWorkerSource).not.toContain("scratchOffset");
    expect(epollDiagnosticSource).not.toContain("scratchOffset");
    expect(opfsFixtureSource).not.toContain("scratchOffset");
    expect(rawMemoryViewMethods(epollDiagnosticSource, "km")).toEqual([]);
    expect(
      rawMemoryViewMethods(opfsFixtureSource, "scratchRegion.memory"),
    ).toEqual([]);
  });

  it("routes Rust-owned host-import destinations through checked helpers", () => {
    // This is deliberately separate from allocator-owned scratch. Rust owns
    // the destination slice and supplies pointer plus capacity for the one
    // synchronous host-import call.
    expect(receiverCallMethods(kernelSource, "destination", "set")).toEqual([
      "hostRead",
    ]);
    expect(
      receiverCallMethods(kernelSource, "this.getMemoryBuffer()", "set"),
    ).toEqual(["writeKernelBytes"]);
    expect(rawMemoryViewMethods(kernelSource, "this.memory")).toEqual([
      "getMemoryBuffer",
      "hostFutexWait",
      "hostFutexWake",
      "hostNetConnect",
      "hostNetSend",
      "kernelDestinationView",
    ]);
    expect(kernelSource).not.toMatch(/\bmem\s*\.set\s*\(/);
    expect(kernelSource).not.toMatch(/new DataView\s*\(\s*this\.memory/);
  });

  it("keeps generated platform and spawn contracts wired into musl", () => {
    expect(platformLimitsHeader).toContain(
      `#define KANDELO_POSIX_ARG_MAX_BYTES ${POSIX_ARG_MAX_BYTES}u`,
    );
    expect(platformLimitsHeader).toContain(
      `#define KANDELO_POSIX_PATH_MAX_BYTES ${POSIX_PATH_MAX_BYTES}u`,
    );
    expect(platformLimitsHeader).toContain(
      `#define KANDELO_POSIX_IOV_MAX ${POSIX_IOV_MAX}u`,
    );

    expect(publicLimitsHeader).toContain(
      "#include <bits/kandelo_limits.h>",
    );
    expect(publicLimitsHeader).toContain(
      "#define ARG_MAX KANDELO_POSIX_ARG_MAX_BYTES",
    );
    expect(publicLimitsHeader).toContain(
      "#define PATH_MAX KANDELO_POSIX_PATH_MAX_BYTES",
    );
    expect(publicLimitsHeader).toContain(
      "#define IOV_MAX KANDELO_POSIX_IOV_MAX",
    );

    expect(spawnContractHeader).toContain(
      "#include <bits/kandelo_limits.h>",
    );
    expect(spawnContractHeader).toContain(
      "#define WASM_POSIX_ARG_MAX_BYTES KANDELO_POSIX_ARG_MAX_BYTES",
    );
    expect(spawnContractHeader).toContain(
      "#define WASM_POSIX_PATH_MAX_BYTES KANDELO_POSIX_PATH_MAX_BYTES",
    );
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_HEADER_BYTES ${SPAWN_WIRE_HEADER_BYTES}u`,
    );
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_ACTION_RECORD_BYTES ${SPAWN_WIRE_ACTION_RECORD_BYTES}u`,
    );
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_MAX_ARGV_COUNT ${SPAWN_MAX_ARGV_COUNT}u`,
    );
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_MAX_ENVP_COUNT ${SPAWN_MAX_ENVP_COUNT}u`,
    );
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_MAX_ACTION_COUNT ${SPAWN_MAX_ACTION_COUNT}u`,
    );
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_WIRE_MAX_BYTES ${SPAWN_WIRE_MAX_BYTES}u`,
    );

    // WHY: musl compiles sysconf limits before overlay headers are installed,
    // so both generated public headers must be staged into its source tree.
    expect(buildMuslSource).toContain(
      'cp "$OVERLAY_DIR/include/limits.h" "$MUSL_DIR/include/limits.h"',
    );
    expect(buildMuslSource).toContain(
      'cp "$OVERLAY_DIR/include/bits/kandelo_limits.h" \\\n'
        + '    "$MUSL_DIR/include/bits/kandelo_limits.h"',
    );
  });
});
