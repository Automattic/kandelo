// Pure decision logic for pid 1's argv: which boot identity wins, the
// image's or a caller's. Factored out of `bootProfile` in the Kandelo app's
// `live-setup.ts` so it lives with the other reusable session contracts this
// package owns (demo-config, gallery-roster, ...) and has a real unit test —
// `live-setup.ts` touches `window`/`import.meta.env` at module scope and
// cannot be imported outside a real Vite + DOM environment.

/**
 * BOOT IDENTITY COMES FROM THE IMAGE.
 *
 * A caller-supplied descriptor (a pasted `#k1=` link, a gallery apply) can
 * carry an `argv`, because every link `ShareDialog` has ever produced
 * spreads the authoring machine's whole boot block. That argv is IGNORED
 * rather than rejected — so links already shared keep booting — but the
 * drop is announced with a visible dmesg line instead of silent. The
 * image's own declared init argv always wins.
 */
export function resolveInitArgv(
  requestedArgv: readonly string[],
  imageArgv: string[],
): { argv: string[]; ignoredMessage: string | null } {
  const ignored = requestedArgv.length > 0 && !sameArgv(requestedArgv, imageArgv);
  return {
    argv: imageArgv,
    ignoredMessage: ignored
      ? "ignoring the boot descriptor's init argv: this machine's pid 1"
        + ` comes from its image (${imageArgv.join(" ")})`
      : null,
  };
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}
