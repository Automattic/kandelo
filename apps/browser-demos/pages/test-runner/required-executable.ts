/** Load a required runner tool before advertising that the fixture is ready. */
export async function fetchRequiredExecutable(url: string): Promise<ArrayBuffer> {
  // WHY: fetch resolves on HTTP errors. Staging an HTML error body, or silently
  // omitting a shell tool, turns broken setup into misleading guest failures.
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Test-runner executable ${url}: HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4));
  if (header.length !== 4 || header[0] !== 0 || header[1] !== 0x61
      || header[2] !== 0x73 || header[3] !== 0x6d) {
    throw new Error(`Test-runner executable ${url}: missing WebAssembly header`);
  }
  // The ordinary loader still owns full module and ABI validation. This only
  // prevents transport/error-page bytes from masquerading as a fetched tool.
  return bytes;
}
