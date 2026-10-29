/**
 * Machine names, minted by the tab that owns the machine:
 * `<adjective>-<color>-<noun>-<t>`, where `t` commits to a 128-bit secret
 * only that tab holds (see MACHINE_NAME_PATTERN in ./protocol). The name is
 * the machine's shareable address, `<scope>computer/<name>/` on the app
 * origin (the viewer shell) and on the preview origin (the guest pages
 * themselves). The three words keep it readable; `t` makes it unique and is
 * what the preview service worker checks the owner's secret against.
 *
 * Keep each word list alphabetized, deduplicated, lowercase [a-z], and 2-12
 * letters long so every name matches MACHINE_NAME_PATTERN.
 */
import { MACHINE_NAME_PATTERN, machineNameCommitment } from "./protocol";

/** A machine's name and the secret it commits to. Never share the secret. */
export interface MachineIdentity {
  name: string;
  secret: string;
}

export const MACHINE_NAME_ADJECTIVES: readonly string[] = [
  "able", "active", "agile", "alert", "amused", "ardent", "artful", "awake",
  "balmy", "blithe", "bold", "bonny", "brave", "bright", "brisk", "bubbly",
  "busy", "calm", "canny", "cheery", "chipper", "civil", "classy", "clean",
  "clear", "clever", "cozy", "crafty", "crisp", "curious", "cute", "dapper",
  "daring", "dashing", "deft", "dreamy", "driven", "eager", "early", "earnest",
  "easy", "elated", "epic", "fair", "fancy", "festive", "fiery", "fleet",
  "fond", "frank", "free", "fresh", "frisky", "funny", "fuzzy", "gallant",
  "game", "genial", "gentle", "giddy", "gifted", "glad", "glossy", "golden",
  "good", "graceful", "grand", "grateful", "groovy", "handy", "happy", "hardy",
  "hearty", "helpful", "heroic", "honest", "hopeful", "humble", "ideal",
  "jaunty", "jazzy", "jolly", "jovial", "joyful", "joyous", "keen", "kind",
  "kindly", "lavish", "lean", "limber", "lithe", "lively", "lofty", "loyal",
  "lucid", "lucky", "lush", "magic", "mellow", "merry", "mighty", "mild",
  "mindful", "modest", "neat", "nice", "nimble", "noble", "plucky", "poised",
  "polite", "prime", "prompt", "proud", "pure", "quaint", "quick", "quiet",
  "quirky", "rapid", "ready", "regal", "robust", "rosy", "ruddy", "sage",
  "saucy", "savvy", "serene", "sharp", "shiny", "silky", "sleek", "smart",
  "snappy", "snazzy", "spry", "stable", "steady", "sturdy", "suave", "sunny",
  "super", "sweet", "swift", "tame", "tender", "tidy", "trusty", "upbeat",
  "urbane", "valiant", "vibrant", "vital", "vivid", "warm", "wily", "winning",
  "wise", "witty", "zany", "zesty",
];

export const MACHINE_NAME_COLORS: readonly string[] = [
  "amber", "amethyst", "apricot", "aqua", "ash", "auburn", "azure", "beige",
  "beryl", "black", "blond", "blue", "blush", "brass", "bronze", "brown",
  "buff", "burgundy", "canary", "caramel", "cardinal", "carmine", "celadon",
  "cerise", "cerulean", "charcoal", "cherry", "chestnut", "chocolate",
  "cinnamon", "citrine", "claret", "cobalt", "coffee", "copper", "coral",
  "cornflower", "cream", "crimson", "cyan", "denim", "ebony", "ecru",
  "emerald", "fawn", "flax", "fuchsia", "garnet", "ginger", "gold", "golden",
  "gray", "green", "heather", "henna", "honey", "indigo", "ivory", "jade",
  "jasmine", "jet", "khaki", "lavender", "lemon", "lilac", "lime", "magenta",
  "mahogany", "maize", "maroon", "mauve", "mint", "mocha", "mulberry",
  "mustard", "navy", "ochre", "olive", "onyx", "opal", "orange", "orchid",
  "peach", "pearl", "periwinkle", "pewter", "pine", "pink", "plum", "puce",
  "pumpkin", "purple", "quartz", "raisin", "red", "rose", "ruby", "russet",
  "rust", "saffron", "salmon", "sand", "sapphire", "scarlet", "sepia",
  "sienna", "silver", "slate", "snow", "steel", "straw", "sunset", "tan",
  "tangerine", "taupe", "teal", "terra", "topaz", "turquoise", "umber",
  "verdant", "vermilion", "violet", "viridian", "wheat", "white", "wine",
  "wisteria", "yellow",
];

export const MACHINE_NAME_NOUNS: readonly string[] = [
  "acorn", "alder", "almond", "antler", "arbor", "aspen", "badger", "bamboo",
  "basil", "beacon", "beaver", "birch", "bison", "bloom", "bluff", "bramble",
  "branch", "breeze", "brook", "buck", "cactus", "canyon", "cedar", "cliff",
  "clover", "comet", "cove", "crane", "creek", "crocus", "crow", "daisy",
  "dale", "dawn", "delta", "dingo", "dolphin", "dove", "dune", "dusk", "eagle",
  "egret", "elk", "ember", "falcon", "fawn", "fern", "finch", "fjord",
  "forest", "fox", "frost", "garden", "glacier", "glade", "grove", "gull",
  "harbor", "hare", "hawk", "hazel", "heath", "heron", "hollow", "holly",
  "ibis", "inlet", "iris", "island", "jay", "juniper", "kelp", "kestrel",
  "koala", "lagoon", "lake", "lark", "laurel", "leaf", "ledge", "lily",
  "linden", "lotus", "lynx", "magpie", "mallard", "maple", "marsh", "meadow",
  "mesa", "mist", "moose", "moss", "moth", "nectar", "nettle", "oak", "oasis",
  "ocean", "orchard", "osprey", "otter", "owl", "palm", "panther", "peak",
  "pebble", "petal", "pigeon", "plateau", "pond", "poppy", "prairie", "quail",
  "rabbit", "raven", "reed", "reef", "ridge", "river", "robin", "rowan",
  "sable", "sequoia", "shore", "sparrow", "spruce", "star", "stone", "storm",
  "stream", "summit", "swan", "teak", "thistle", "thorn", "thrush", "tiger",
  "timber", "tulip", "tundra", "valley", "vine", "vireo", "walnut", "warbler",
  "wave", "willow", "wolf", "wombat", "wren", "yarrow", "yew", "zephyr",
];

function pick(list: readonly string[], random: () => number): string {
  return list[random() % list.length]!;
}

function cryptoRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Three words, adjective-color-noun: the readable part of a name. */
export function mintMachineWords(random: () => number = cryptoRandom): string {
  return `${pick(MACHINE_NAME_ADJECTIVES, random)}-` +
    `${pick(MACHINE_NAME_COLORS, random)}-${pick(MACHINE_NAME_NOUNS, random)}`;
}

/** The identity for `words` and `secret`: `<words>-<commitment to secret>`. */
export async function machineIdentityFor(words: string, secret: string): Promise<MachineIdentity> {
  const name = `${words}-${await machineNameCommitment(secret)}`;
  if (!MACHINE_NAME_PATTERN.test(name)) {
    throw new Error(`machine name ${name} does not match the name pattern`);
  }
  return { name, secret };
}

/** A fresh machine identity: random words and a fresh 128-bit secret. */
export function mintMachineIdentity(random: () => number = cryptoRandom): Promise<MachineIdentity> {
  return machineIdentityFor(mintMachineWords(random), randomSecret());
}
