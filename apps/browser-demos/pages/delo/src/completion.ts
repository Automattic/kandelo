// Tab completion for the delo command line, one word at a time: the word
// `delo`, then a verb, then an argument from that verb's own list, then, for
// a change verb, the computers that change applies to. `delo write` takes a
// path no list holds, so a path that no candidate extends goes on to the
// computers, then its flags. A value is never completed. Kept pure so the
// completion rules are testable without a DOM.

import { DELO_VERBS, isDeloChangeVerb, isDeloVerb, parseDeloCommand, type DeloChangeVerb, type DeloFlag, type DeloVerb } from "./command";
import { DELO_FLAGS_ALONE } from "./write";

interface DeloCompletion {
  /** The line after completion; unchanged when nothing completes. */
  line: string;
  /** The line up to the word being completed. A candidate the visitor picks
   *  replaces everything after it. */
  prefix: string;
  /** Every candidate the typed word matches when more than one does, or when
   *  the word is empty, so the page can offer them. Empty otherwise. */
  candidates: string[];
}

const COMMAND = "delo";

/** Every argument each verb can take, in the order the dropdown shows. */
export type DeloArguments = Record<DeloVerb, readonly string[]>;

/** Every computer a change verb can apply `thing` to. */
export type DeloComputers = (verb: DeloChangeVerb, thing: string) => readonly string[];

/** Every flag `delo write` can take next on `path` of `computer`, after `flags`. */
export type DeloWriteFlags = (path: string, computer: string, flags: readonly DeloFlag[]) => readonly string[];

export function completeDeloLine(
  line: string,
  argumentsByVerb: DeloArguments,
  computersFor: DeloComputers,
  flagsFor: DeloWriteFlags,
): DeloCompletion {
  const words = line.trimStart().split(/\s+/);
  if (words.length === 1 && words[0] !== COMMAND) {
    const completes = COMMAND.startsWith(words[0]);
    return { line: completes ? `${COMMAND} ` : line, prefix: "", candidates: [] };
  }
  if (words[0] !== COMMAND) return unchanged(line);
  if (words.length === 1) words.push("");
  const verb = words[1];
  if (words.length === 2 && isDeloVerb(verb)) words.push("");
  if (words.length === 2) return complete(line, `${COMMAND} `, DELO_VERBS, verb);
  if (words.length === 3 && isDeloChangeVerb(verb) && (argumentsByVerb[verb].includes(words[2]) || newPath(verb, argumentsByVerb.write, words[2]))) words.push("");
  if (words.length === 3 && isDeloVerb(verb)) {
    return complete(line, `${COMMAND} ${verb} `, argumentsByVerb[verb], words[2]);
  }
  if (words.length === 4 && isDeloChangeVerb(verb)) {
    return complete(line, `${COMMAND} ${verb} ${words[2]} `, computersFor(verb, words[2]), words[3]);
  }
  if (words.length > 4 && verb === "write") return completeFlag(line, flagsFor);
  return unchanged(line);
}

/** Complete the flag the line ends in, or offer every flag after a space. A
 *  word that is no flag, or that follows a flag waiting for its value, stays. */
function completeFlag(line: string, flagsFor: DeloWriteFlags): DeloCompletion {
  const prefix = line.slice(0, line.search(/\S*$/));
  const partial = line.slice(prefix.length);
  if (partial !== "" && !partial.startsWith("--")) return unchanged(line);
  let command: ReturnType<typeof parseDeloCommand>;
  try {
    command = parseDeloCommand(prefix);
  } catch {
    return unchanged(line);
  }
  const last = command.flags.at(-1);
  if (last !== undefined && last.value === null && !DELO_FLAGS_ALONE.includes(last.key)) return unchanged(line);
  const flags = flagsFor(command.name!, command.computer!, command.flags).map((key) => `--${key}`);
  return complete(line, prefix, flags, partial);
}

/** Whether `word` is a path `delo write` makes, which no written path extends. */
const newPath = (verb: DeloChangeVerb, written: readonly string[], word: string) =>
  verb === "write" && word.startsWith("/") && !written.some((path) => path.startsWith(word));

function complete(
  line: string,
  prefix: string,
  options: readonly string[],
  partial: string,
): DeloCompletion {
  const matches = options.filter((option) => option.startsWith(partial));
  if (matches.length === 0) return unchanged(line);
  if (partial === "") return { line: prefix, prefix, candidates: matches };
  if (matches.length === 1) {
    return { line: `${prefix}${matches[0]}`, prefix, candidates: [] };
  }
  return { line: `${prefix}${commonPrefix(matches)}`, prefix, candidates: matches };
}

function unchanged(line: string): DeloCompletion {
  return { line, prefix: "", candidates: [] };
}

function commonPrefix(words: readonly string[]): string {
  let prefix = words[0];
  for (const word of words.slice(1)) {
    while (!word.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}
