export class HomebrewBottleFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomebrewBottleFetchError";
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface BearerChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

export async function fetchHomebrewBottleBytes(
  url: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response = await fetchImpl(url);

  if (response.status === 401) {
    const challenge = parseBearerChallenge(response.headers.get("www-authenticate"));
    if (challenge) {
      const token = await fetchBearerToken(challenge, fetchImpl);
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  }

  if (!response.ok) {
    throw new HomebrewBottleFetchError(`fetch ${url} failed: HTTP ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function parseBearerChallenge(header: string | null): BearerChallenge | null {
  if (!header) return null;
  const match = /^\s*Bearer\s+(.+)\s*$/i.exec(header);
  if (!match) return null;

  const params = new Map<string, string>();
  const paramPattern = /([A-Za-z][A-Za-z0-9_-]*)=(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g;
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
    throw new HomebrewBottleFetchError(`invalid registry auth realm: ${challenge.realm}`);
  }

  if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
  if (challenge.scope) tokenUrl.searchParams.set("scope", challenge.scope);

  const response = await fetchImpl(tokenUrl);
  if (!response.ok) {
    throw new HomebrewBottleFetchError(
      `fetch ${tokenUrl.toString()} for registry token failed: HTTP ${response.status}`,
    );
  }

  const body = await response.json() as { token?: unknown; access_token?: unknown };
  const token = typeof body.token === "string"
    ? body.token
    : typeof body.access_token === "string"
      ? body.access_token
      : "";
  if (!token) {
    throw new HomebrewBottleFetchError(`registry token response did not include a token`);
  }
  return token;
}
