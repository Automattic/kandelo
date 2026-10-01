// Machine names — three plain words joined by dashes, drawn at random.
//
// A saved machine needs a name before the person has one for it, and an id
// is not a name anyone tells a friend. Three words are easy to say, easy to
// tell apart in a list, and enough combinations that two machines in one
// browser rarely collide; the caller redraws when they do.

const ADJECTIVES = [
  "amber", "bold", "brave", "bright", "calm", "clever", "cool", "crisp",
  "eager", "early", "fair", "fast", "fine", "fresh", "gentle", "glad",
  "golden", "grand", "green", "happy", "humble", "jolly", "keen", "kind",
  "light", "lively", "lucky", "merry", "mild", "neat", "noble", "plain",
  "proud", "quick", "quiet", "rapid", "ready", "royal", "shy", "silver",
  "smart", "smooth", "soft", "solid", "steady", "sunny", "swift", "warm",
];

const NOUNS = [
  "anchor", "apple", "arrow", "badger", "beacon", "birch", "bridge", "brook",
  "canyon", "cedar", "cloud", "comet", "coral", "crane", "delta", "ember",
  "falcon", "fern", "forest", "garden", "glacier", "harbor", "heron", "island",
  "lantern", "lemon", "maple", "meadow", "meteor", "mirror", "oak", "orbit",
  "otter", "pebble", "pine", "planet", "prairie", "raven", "river", "saddle",
  "shore", "spruce", "summit", "thistle", "tiger", "valley", "willow", "zephyr",
];

export const MACHINE_NAME_MAX_LENGTH = 64;

/** Draw one name from three random bytes; the same bytes give the same name. */
export function machineNameFrom(bytes: Uint8Array): string {
  if (bytes.byteLength < 3) {
    throw new Error("a machine name needs three random bytes");
  }
  const adjective = ADJECTIVES[bytes[0]! % ADJECTIVES.length]!;
  const first = bytes[1]! % NOUNS.length;
  const second = (first + 1 + (bytes[2]! % (NOUNS.length - 1))) % NOUNS.length;
  return `${adjective}-${NOUNS[first]}-${NOUNS[second]}`;
}

/** Draw a name that none of `taken` already uses. */
export function randomMachineName(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const bytes = new Uint8Array(3);
  for (;;) {
    crypto.getRandomValues(bytes);
    const name = machineNameFrom(bytes);
    if (!used.has(name)) return name;
  }
}

/**
 * One name fit to keep: surrounding space off, control characters out, one
 * to {@link MACHINE_NAME_MAX_LENGTH} characters. Null when nothing is left.
 */
export function presentableMachineName(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MACHINE_NAME_MAX_LENGTH);
  return cleaned === "" ? null : cleaned;
}
