// The byte size of a lazy file's source, read from a HEAD answer's
// Content-Length, so the build writes it without downloading the bytes. A
// compressed answer's length is not the file's, so it is refused, as is an
// answer without a length.

export async function fetchSourceSize(url: string): Promise<number> {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding !== "identity") throw new Error(`${url}: the server compresses it (${encoding}), so its size is unknown`);
  const length = response.headers.get("content-length");
  const size = length === null || length === "" ? NaN : Number(length);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${url}: the server gives no size for it`);
  return size;
}
