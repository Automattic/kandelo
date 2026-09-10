export const NICKNAME_MAX_LENGTH = 24;

/**
 * One name fit to show: control characters out, surrounding space off, length
 * capped, and nothing left means no name. Applied to both names — the peer's
 * because it is another computer's input, this person's before it crosses the
 * wire so a name that is only spaces travels as no name.
 */
export function presentableNickname(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, NICKNAME_MAX_LENGTH);
  return cleaned === "" ? null : cleaned;
}
