export interface FetchedWasmProgram {
  programUrl: string;
  argv: string[];
  timeoutMs: number;
  wasmByteDataFiles?: string[];
}

/**
 * This function is passed directly to Playwright's page.evaluate, so it must
 * remain self-contained and must not close over module-level helpers.
 */
export async function runFetchedWasmProgram({
  programUrl,
  argv,
  timeoutMs,
  wasmByteDataFiles = [],
}: FetchedWasmProgram) {
  const response = await fetch(programUrl);
  if (!response.ok) {
    throw new Error(
      `program fetch failed: ${response.status} ${response.statusText} ${response.url}`,
    );
  }

  const wasmBytes = await response.arrayBuffer();
  const prefix = new Uint8Array(wasmBytes, 0, Math.min(4, wasmBytes.byteLength));
  const hasWasmMagic =
    prefix.length === 4 &&
    prefix[0] === 0x00 &&
    prefix[1] === 0x61 &&
    prefix[2] === 0x73 &&
    prefix[3] === 0x6d;
  if (!hasWasmMagic) {
    const firstBytes = Array.from(prefix, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join(" ");
    throw new Error(
      "program fetch returned non-WebAssembly bytes" +
        `: status=${response.status}` +
        ` content-type=${response.headers.get("content-type") ?? "<missing>"}` +
        ` first-bytes=${firstBytes || "<empty>"}` +
        ` url=${response.url || programUrl}`,
    );
  }

  return (window as any).__runTest(
    wasmBytes,
    argv,
    timeoutMs,
    wasmByteDataFiles.length > 0
      ? {
          dataFiles: wasmByteDataFiles.map((path) => ({
            path,
            useWasmBytes: true,
          })),
        }
      : undefined,
  );
}
