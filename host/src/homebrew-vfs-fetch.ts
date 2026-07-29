export class HomebrewBottleFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomebrewBottleFetchError";
  }
}

import { VFS_DEFERRED_TREE_LIMITS } from "./vfs/deferred-tree-limits";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface BearerChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

export async function fetchHomebrewBottleBytes(
  url: string,
  options: {
    fetchImpl?: FetchLike;
    /** Exact public metadata size; bounds a hostile or corrupted response. */
    expectedBytes?: number;
  } = {},
): Promise<Uint8Array> {
  if (
    options.expectedBytes !== undefined &&
    (!Number.isSafeInteger(options.expectedBytes) ||
      options.expectedBytes <= 0 ||
      options.expectedBytes > VFS_DEFERRED_TREE_LIMITS.maxArchiveBytes)
  ) {
    throw new HomebrewBottleFetchError(
      `expected bottle byte count must be in 1..` +
        `${VFS_DEFERRED_TREE_LIMITS.maxArchiveBytes}`,
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let response = await fetchImpl(url);

  if (response.status === 401) {
    const challenge = parseBearerChallenge(
      response.headers.get("www-authenticate"),
    );
    if (challenge) {
      const token = await fetchBearerToken(challenge, fetchImpl);
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  }

  if (!response.ok) {
    throw new HomebrewBottleFetchError(
      `fetch ${url} failed: HTTP ${response.status}`,
    );
  }

  return readBottleResponse(response, url, options.expectedBytes);
}

async function readBottleResponse(
  response: Response,
  url: string,
  expectedBytes: number | undefined,
): Promise<Uint8Array> {
  if (expectedBytes === undefined) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new HomebrewBottleFetchError(
        `fetch ${url} returned an invalid Content-Length`,
      );
    }
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared !== expectedBytes) {
      throw new HomebrewBottleFetchError(
        `fetch ${url} declared ${contentLength} bytes, expected ` +
          `${expectedBytes}`,
      );
    }
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== expectedBytes) {
      throw new HomebrewBottleFetchError(
        `fetch ${url} returned ${bytes.byteLength} bytes, expected ` +
          `${expectedBytes}`,
      );
    }
    return bytes;
  }

  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.byteLength > expectedBytes - offset) {
      try {
        await reader.cancel("Homebrew bottle exceeds its declared size");
      } catch {
        // Preserve the size-contract failure when cancellation itself races
        // with a broken or already-failed response stream.
      }
      throw new HomebrewBottleFetchError(
        `fetch ${url} returned more than the expected ${expectedBytes} bytes`,
      );
    }
    output.set(value, offset);
    offset += value.byteLength;
  }
  if (offset !== expectedBytes) {
    throw new HomebrewBottleFetchError(
      `fetch ${url} returned ${offset} bytes, expected ${expectedBytes}`,
    );
  }
  return output;
}

function parseBearerChallenge(header: string | null): BearerChallenge | null {
  if (!header) return null;
  const match = /^\s*Bearer\s+(.+)\s*$/i.exec(header);
  if (!match) return null;

  const params = new Map<string, string>();
  const paramPattern =
    /([A-Za-z][A-Za-z0-9_-]*)=(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g;
  for (const param of match[1].matchAll(paramPattern)) {
    const rawValue = param[2] ?? param[3] ?? "";
    params.set(param[1].toLowerCase(), rawValue.replace(/\\(["\\])/g, "$1"));
  }

  const realm = params.get("realm");
  if (!realm) return null;
  return {
    realm,
    service: params.get("service"),
    scope: params.get("scope"),
  };
}

async function fetchBearerToken(
  challenge: BearerChallenge,
  fetchImpl: FetchLike,
): Promise<string> {
  let tokenUrl: URL;
  try {
    tokenUrl = new URL(challenge.realm);
  } catch {
    throw new HomebrewBottleFetchError(
      `invalid registry auth realm: ${challenge.realm}`,
    );
  }

  if (challenge.service)
    tokenUrl.searchParams.set("service", challenge.service);
  if (challenge.scope) tokenUrl.searchParams.set("scope", challenge.scope);

  const response = await fetchImpl(tokenUrl);
  if (!response.ok) {
    throw new HomebrewBottleFetchError(
      `fetch ${tokenUrl.toString()} for registry token failed: HTTP ${response.status}`,
    );
  }

  const body = (await response.json()) as {
    token?: unknown;
    access_token?: unknown;
  };
  const token =
    typeof body.token === "string"
      ? body.token
      : typeof body.access_token === "string"
        ? body.access_token
        : "";
  if (!token) {
    throw new HomebrewBottleFetchError(
      `registry token response did not include a token`,
    );
  }
  return token;
}
