// The `delo` command line: what a visitor types into the delo landing page.
//
// `delo` is not a program inside a Kandelo machine. It is the one command the
// landing page understands. Parsing is kept pure so the accepted grammar is
// testable without a DOM; what a name refers to is the page's lookup, not the
// grammar's. Words split on spaces outside double quotes; inside them, `\"`,
// `\\` and `\n` stand for a quote, a backslash and a new line. Only
// `delo write` takes flags, after its computer: `--<key> [value]`, where the
// value is the next word unless that word is an unquoted flag.

export const DELO_VERBS = ["run", "list", "config", "init", "save", "destroy", "add", "remove", "write", "enable", "disable"] as const;

export type DeloVerb = typeof DELO_VERBS[number];

/** The verbs that change one thing on a named computer. */
const DELO_CHANGE_VERBS = ["add", "remove", "write", "enable", "disable"] as const;

export type DeloChangeVerb = typeof DELO_CHANGE_VERBS[number];

/** One `--<key> [value]` of `delo write`; `value` is null for a flag alone. */
export interface DeloFlag {
  key: string;
  value: string | null;
}

/** `verb` is null when `delo` came alone, `name` is null when the verb came
 *  without its argument, and `computer` is null when a change verb came
 *  without its computer: the page answers with the dropdown of everything
 *  that word can be. `computer` is always null for the other verbs, and
 *  `flags` is empty for every verb but write. */
interface DeloCommand {
  verb: DeloVerb | null;
  name: string | null;
  computer: string | null;
  flags: DeloFlag[];
}

export const DELO_USAGE = "usage: delo run | list | config | init | save | destroy [name] · delo add | remove | enable | disable [thing] [computer] · delo write [path] [computer] [--key value]";

/**
 * Parse one command line. Throws an Error whose message is what the page
 * shows the visitor: the usage line for a shape the grammar does not accept.
 * Whitespace around and between words is ignored; nothing else is.
 */
export function parseDeloCommand(line: string): DeloCommand {
  const words = wordsOf(line);
  const flagAt = words.findIndex(isFlag);
  const [command, verb, argument, computer, ...rest] = (flagAt === -1 ? words : words.slice(0, flagAt)).map((word) => word.text);
  if (command === "delo" && verb === undefined && flagAt === -1) return { verb: null, name: null, computer: null, flags: [] };
  if (command !== "delo" || rest.length > 0 || !isDeloVerb(verb)) throw new Error(DELO_USAGE);
  if (computer !== undefined && !isDeloChangeVerb(verb)) throw new Error(DELO_USAGE);
  if (flagAt !== -1 && (verb !== "write" || computer === undefined)) throw new Error(DELO_USAGE);
  return { verb, name: argument ?? null, computer: computer ?? null, flags: flagAt === -1 ? [] : flagsOf(words.slice(flagAt)) };
}

interface Word {
  text: string;
  quoted: boolean;
}

const isFlag = (word: Word) => !word.quoted && word.text.startsWith("--");

const ESCAPES: Record<string, string> = { "\"": "\"", "\\": "\\", n: "\n" };

function wordsOf(line: string): Word[] {
  const words: Word[] = [];
  let word: Word | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word ??= { text: "", quoted: false };
    if (char !== "\"") {
      word.text += char;
      continue;
    }
    word.quoted = true;
    for (index++; line[index] !== "\""; index++) {
      if (index >= line.length) throw new Error("a quote is not closed");
      if (line[index] !== "\\") {
        word.text += line[index];
        continue;
      }
      const escaped = ESCAPES[line[++index]];
      if (escaped === undefined) throw new Error("a backslash in quotes takes \\\", \\\\ or \\n after it");
      word.text += escaped;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

function flagsOf(words: Word[]): DeloFlag[] {
  const flags: DeloFlag[] = [];
  for (let index = 0; index < words.length; index++) {
    if (!isFlag(words[index])) throw new Error(`${words[index].text} is not a flag: a flag starts with --`);
    const key = words[index].text.slice(2);
    if (flags.some((flag) => flag.key === key)) throw new Error(`--${key} is given twice`);
    const next = words[index + 1];
    const value = next === undefined || isFlag(next) ? null : next.text;
    if (value !== null) index++;
    flags.push({ key, value });
  }
  return flags;
}

export function isDeloVerb(word: string | undefined): word is DeloVerb {
  return (DELO_VERBS as readonly string[]).includes(word ?? "");
}

export function isDeloChangeVerb(word: string | undefined): word is DeloChangeVerb {
  return (DELO_CHANGE_VERBS as readonly string[]).includes(word ?? "");
}
