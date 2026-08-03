export interface PlaywrightTestTargetEnvironment {
  KANDELO_TEST_BASE_URL?: string;
}

/**
 * Return the external deployment root used by browser acceptance tests.
 *
 * A trailing slash is significant for a GitHub Pages project URL: resolving
 * `?demo=shell` against `/kandelo/` must stay below that project path.
 */
export function configuredPlaywrightTestBaseUrl(
  env: PlaywrightTestTargetEnvironment,
): string | undefined {
  const raw = env.KANDELO_TEST_BASE_URL;
  if (raw === undefined) return undefined;
  if (raw.trim() !== raw || raw.length === 0) {
    throw new Error("KANDELO_TEST_BASE_URL must not be empty or padded");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("KANDELO_TEST_BASE_URL must be an absolute HTTP URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== ""
  ) {
    throw new Error(
      "KANDELO_TEST_BASE_URL must be an HTTP(S) deployment root without " +
        "credentials, query parameters, or a fragment",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function usesManagedPlaywrightServer(
  configuredBaseUrl: string | undefined,
  port: number,
): boolean {
  if (configuredBaseUrl === undefined) return true;
  const url = new URL(configuredBaseUrl);
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    Number(url.port || "80") === port
  );
}
