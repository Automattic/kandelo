/**
 * Ambient declarations for the Vite-style asset imports used by the host
 * runtime's `browser-kernel-assets` and `browser-kernel-default-artifacts`
 * modules. These let the `.d.ts` generation pass — which does not run the
 * build-time alias swap — typecheck the host browser graph. At runtime in the
 * published package these specifiers are never evaluated; the build aliases
 * both modules to package-local replacements.
 */
declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*?worker&url" {
  const url: string;
  export default url;
}
