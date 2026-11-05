/** DOM `buttons` and Kandelo's PS/2 mask use left=1, right=2, middle=4. */
export function pointerButtons(
  current: number,
  event: { buttons?: number; button: number },
  phase: "down" | "move" | "up",
  allowPresses: boolean,
): number {
  // Chorded presses/releases arrive as pointermove. The complete snapshot
  // also repairs a missed release without inventing presses on hover entry.
  if (typeof event.buttons === "number") {
    const next = event.buttons & 7;
    return allowPresses ? next : current & next;
  }
  // Keep callers without a snapshot (e.g. older embedders) usable.
  const bit = event.button === 0 ? 1 : event.button === 2 ? 2 : event.button === 1 ? 4 : 0;
  return phase === "down" && allowPresses ? current | bit
    : phase === "up" ? current & ~bit : current;
}
