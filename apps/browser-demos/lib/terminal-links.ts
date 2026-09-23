/**
 * Make URLs in terminal output clickable under the Kandelo link policy.
 *
 * Two kinds of link are wired here and both go through the same policy:
 *
 * - **Plain text URLs** a program printed, found by scanning the buffer
 *   (`registerLinkProvider`).
 * - **OSC 8 hyperlinks**, where a program explicitly marked a range of text as
 *   a link (`Terminal.options.linkHandler`). An OSC 8 link's visible text can
 *   differ from its destination, so following one to a third party keeps
 *   xterm's confirmation prompt; only the referrer behavior changes.
 *
 * Every link opens in a new tab. The `Referer` header is suppressed for
 * anything that is not the current machine or the site hosting it, because a
 * Kandelo page URL can carry machine state (`#k1=` boot descriptors, share
 * links) that a third-party site has no business seeing.
 *
 * The decision itself lives in `web-libs/kandelo-session/src/terminal-links.ts`
 * so it can be unit tested without a DOM; this file is the xterm.js and DOM
 * wiring.
 */
import type { IBufferCell, IDisposable, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import {
  classifyTerminalLink,
  type TerminalLinkContext,
  type TerminalLinkTarget,
} from "../../../web-libs/kandelo-session/src/terminal-links";

/**
 * Candidate URL runs in a line of terminal text. Deliberately greedy — the
 * trailing punctuation a URL is unlikely to own is trimmed afterwards, and
 * `classifyTerminalLink` has the final say on whether the result is a link at
 * all.
 */
const URL_PATTERN = /https?:\/\/[^\s"'`<>\\^{}|]+/gi;

/** Stop walking a wrapped logical line after this many rows. */
const MAX_WRAPPED_ROWS = 64;

/** Characters that end a sentence far more often than they end a URL. */
const TRAILING_PUNCTUATION = ".,;:!?'\"";

const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

function countChar(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/**
 * Drop trailing characters a URL probably does not own: sentence punctuation,
 * and closing brackets with no matching opener inside the match (so
 * `(see http://x/)` loses its `)` while `http://x/a_(b)` keeps its own).
 */
export function trimTrailingPunctuation(text: string): string {
  let end = text.length;
  while (end > 0) {
    const ch = text[end - 1];
    if (TRAILING_PUNCTUATION.includes(ch)) {
      end--;
      continue;
    }
    const opener = CLOSERS[ch];
    if (opener !== undefined) {
      const slice = text.slice(0, end);
      if (countChar(slice, ch) > countChar(slice, opener)) {
        end--;
        continue;
      }
    }
    break;
  }
  return text.slice(0, end);
}

/** The buffer cell a character of a logical line came from. */
interface CellOrigin {
  /** 0-based column. */
  readonly x: number;
  /** 0-based absolute buffer row. */
  readonly y: number;
  /** Cell width in columns (2 for full-width glyphs). */
  readonly width: number;
}

interface LogicalLine {
  readonly text: string;
  /** `origins[i]` is the cell that produced `text[i]`. */
  readonly origins: readonly CellOrigin[];
}

/**
 * Read the whole logical line containing `row`, following xterm's `isWrapped`
 * chain in both directions, and record which cell produced each character.
 *
 * Building the string cell by cell rather than via `translateToString` keeps
 * the character-index-to-column mapping exact when a line contains full-width
 * glyphs or combining marks, which a divide-by-`cols` mapping gets wrong.
 */
function readLogicalLine(term: Terminal, row: number): LogicalLine | null {
  const buffer = term.buffer.active;
  if (!buffer.getLine(row)) return null;

  let start = row;
  let walked = 0;
  while (start > 0 && buffer.getLine(start)?.isWrapped && walked < MAX_WRAPPED_ROWS) {
    start--;
    walked++;
  }

  let text = "";
  const origins: CellOrigin[] = [];
  const scratch: IBufferCell = buffer.getNullCell();
  for (let y = start; y < start + MAX_WRAPPED_ROWS; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x, scratch);
      if (!cell) continue;
      const width = cell.getWidth();
      // Width 0 is the trailing half of a full-width glyph; it contributes no
      // character of its own.
      if (width === 0) continue;
      const chars = cell.getChars() || " ";
      for (let k = 0; k < chars.length; k++) origins.push({ x, y, width });
      text += chars;
    }
    if (!buffer.getLine(y + 1)?.isWrapped) break;
  }

  return { text, origins };
}

/**
 * Open a classified link in a new tab.
 *
 * Uses a synthesized anchor click rather than `window.open`: `rel="noreferrer"`
 * on an anchor is the reliable cross-browser way to drop the `Referer` header,
 * whereas the `noreferrer` window feature is honored less consistently.
 * `noopener` is set either way — no destination needs a handle back to this
 * page.
 */
export function openTerminalLink(target: TerminalLinkTarget, doc: Document = document): void {
  if (target.kind === "unreachable") return;
  const anchor = doc.createElement("a");
  anchor.href = target.href;
  anchor.target = "_blank";
  anchor.rel = target.sendReferrer ? "noopener" : "noopener noreferrer";
  // Some browsers ignore clicks on detached elements; keep it in the document
  // for the duration of the dispatch only.
  anchor.style.display = "none";
  doc.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

/**
 * Ask before following an OSC 8 hyperlink to a third party, naming the real
 * destination rather than the text the program chose to show.
 */
function confirmExternalHyperlink(href: string): boolean {
  return window.confirm(
    `This terminal hyperlink goes to:\n\n${href}\n\n` +
      "The program that printed it chose both the text and the destination. Open it?",
  );
}

class KandeloLinkProvider implements ILinkProvider {
  constructor(
    private readonly term: Terminal,
    private readonly getContext: () => TerminalLinkContext,
  ) {}

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    // `bufferLineNumber` is 1-based over the whole buffer, scrollback included.
    const logical = readLogicalLine(this.term, bufferLineNumber - 1);
    if (!logical) {
      callback(undefined);
      return;
    }

    const context = this.getContext();
    const links: ILink[] = [];
    URL_PATTERN.lastIndex = 0;
    for (let match = URL_PATTERN.exec(logical.text); match; match = URL_PATTERN.exec(logical.text)) {
      const raw = trimTrailingPunctuation(match[0]);
      if (!raw) continue;
      const target = classifyTerminalLink(raw, context);
      // No link for non-http(s) text, and none for a URL this page cannot
      // reach: an underlined click that silently goes nowhere — or worse, to
      // the user's own computer — is not an honest affordance.
      if (!target || target.kind === "unreachable") continue;

      const first = logical.origins[match.index];
      const last = logical.origins[match.index + raw.length - 1];
      if (!first || !last) continue;

      links.push({
        text: raw,
        range: {
          start: { x: first.x + 1, y: first.y + 1 },
          end: { x: last.x + last.width, y: last.y + 1 },
        },
        activate: (event) => {
          event.preventDefault();
          openTerminalLink(target);
        },
      });
    }

    callback(links.length > 0 ? links : undefined);
  }
}

/**
 * Wire link handling into `term`. `getContext` is read on every hover so the
 * policy tracks the machine's current web-bridge state rather than a snapshot
 * taken at attach time.
 */
export function registerTerminalLinks(
  term: Terminal,
  getContext: () => TerminalLinkContext,
): IDisposable {
  const providerDisposable = term.registerLinkProvider(
    new KandeloLinkProvider(term, getContext),
  );

  const previousLinkHandler = term.options.linkHandler ?? null;
  term.options.linkHandler = {
    // OSC 8 lets a program name any URL for a span of text, so unlike a plain
    // text URL the visible text can lie about where the link goes. xterm.js
    // confirms before following one; without a `linkHandler` it then navigates
    // with `window.open` + `location.href`, which sends this page's URL as the
    // `Referer`. Keep the confirmation and fix the referrer — do not trade a
    // safety prompt for convenience.
    //
    // `allowNonHttpProtocols` stays off (the default), so xterm never offers us
    // a `javascript:` URL a program wrote.
    activate: (event, text) => {
      const target = classifyTerminalLink(text, getContext());
      if (!target || target.kind === "unreachable") return;
      event.preventDefault();
      if (target.kind === "external" && !confirmExternalHyperlink(target.href)) {
        return;
      }
      openTerminalLink(target);
    },
  };

  return {
    dispose: () => {
      providerDisposable.dispose();
      term.options.linkHandler = previousLinkHandler;
    },
  };
}

export type { TerminalLinkContext, TerminalLinkTarget };
