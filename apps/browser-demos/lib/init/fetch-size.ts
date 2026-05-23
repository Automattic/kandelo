function parsePositiveInteger(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseContentRangeTotal(value: string | null): number {
  if (!value) return 0;
  const match = value.match(/\/(\d+)$/);
  return match ? parsePositiveInteger(match[1]) : 0;
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
    const ranged = await fetch(url, { headers: { Range: "bytes=0-0" } });
    const size = parseContentRangeTotal(ranged.headers.get("content-range"))
      || parsePositiveInteger(ranged.headers.get("content-length"));
    await cancelBody(ranged);
    return ranged.ok ? size : 0;
  } catch {
    return 0;
  }
}
