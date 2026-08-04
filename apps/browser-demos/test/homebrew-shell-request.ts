export function isLegacyShellProgramFetch(
  resourceType: string,
  url: string,
): boolean {
  // WHY: Vite's `?import&url` module discovery names the shell asset but does
  // not download it as a legacy runtime fallback.
  return resourceType === "fetch" &&
    /\/(?:bash|dash)\.wasm(?:\?|$)/.test(url) &&
    !url.includes("?import&url");
}
