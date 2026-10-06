/**
 * Browser-only CA trust for guest TLS clients.
 *
 * In the browser host every external HTTPS connection is terminated by the
 * TLS-MITM (see `TlsNetworkBackend`), which installs a per-session CA at
 * {@link BROWSER_MITM_CA_BUNDLE_PATH}. Standalone `curl` trusts it because its
 * libcurl falls through to `SSL_CERT_FILE` (which the demo image points at that
 * path). git's remote helper (`git-remote-http`) and some other libcurl guests
 * do NOT fall through — they use libcurl's compiled-in default CAfile — so
 * `git clone https://…` fails with "self-signed certificate in certificate
 * chain" unless they are pointed at the MITM bundle explicitly.
 *
 * These variables are injected into the guest process environment at launch by
 * the browser kernel worker, NOT baked into the VFS image, so the same image
 * still boots on the Node host, which does real end-to-end TLS and must keep its
 * own real-root CA path rather than a browser MITM bundle.
 */
export const BROWSER_MITM_CA_BUNDLE_PATH = "/etc/ssl/certs/ca-certificates.crt";

const BROWSER_MITM_CA_ENV = [
  `GIT_SSL_CAINFO=${BROWSER_MITM_CA_BUNDLE_PATH}`,
  `CURL_CA_BUNDLE=${BROWSER_MITM_CA_BUNDLE_PATH}`,
];

/**
 * Return `env` with the MITM CA variables added, unless the guest environment
 * already sets a variable of the same name (an explicit demo-provided value
 * wins). The launched root process receives these and fork/exec children
 * inherit them, which is what reaches git's separately-executed remote helper.
 */
export function withBrowserMitmCaEnv(env: readonly string[]): string[] {
  const additions = BROWSER_MITM_CA_ENV.filter((entry) => {
    const key = entry.slice(0, entry.indexOf("=") + 1);
    return !env.some((existing) => existing.startsWith(key));
  });
  return additions.length === 0 ? [...env] : [...env, ...additions];
}
