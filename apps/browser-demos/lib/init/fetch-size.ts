import { fetchByteRange } from "../../../../host/src/networking/byte-range-fetch";

function parsePositiveInteger(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* best effort */
  }
}

export async function fetchSize(url: string): Promise<number> {
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (head.ok) {
      const size = parsePositiveInteger(head.headers.get("content-length"));
      if (size > 0) return size;
    }
  } catch {
    /* fall back below */
  }

  try {
    const probe = await fetchByteRange(url, { start: 0, end: 0 });
    if (probe.kind === "failed") return 0;
    await cancelBody(probe.response);
    // A 200 means the range was not applied, so Content-Length is the whole
    // entity's; a 206's Content-Length is only the one-byte slice.
    return probe.kind === "partial"
      ? probe.completeLength ?? 0
      : parsePositiveInteger(probe.response.headers.get("content-length"));
  } catch {
    return 0;
  }
}
