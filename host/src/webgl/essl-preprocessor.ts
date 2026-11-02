/**
 * The GLSL ES 1.00 preprocessor (section 3.4), for shaders the native ESSL
 * 1.00 compiler has already accepted.
 *
 * The ESSL 3.00 translation (essl3-translation.ts) works on the shader's
 * code after preprocessing, so that each decision it makes (which built-in
 * outputs a fragment shader statically uses, which functions it declares,
 * which globals have initializers) is about the code the compiler parsed,
 * not about text inside an inactive #if group or an unused macro body. Its
 * input has already been preprocessed and parsed without error by the
 * engine's own ESSL 1.00 front end (shader-source.ts compiles it first), so
 * this preprocessor implements the language's well-formed behavior and does
 * not diagnose: an ill-formed shader never reaches it.
 *
 * Behavior that must agree with the native ESSL 1.00 front end (ANGLE in
 * Chromium, Firefox and WebKit), each checked by the real-compiler harness
 * (tests/graphics/shader-rewrite-check):
 * - Predefined macros: GL_ES 1, __VERSION__ 100, __LINE__, __FILE__, and
 *   GL_FRAGMENT_PRECISION_HIGH 1 in both stages (ANGLE defines it for vertex
 *   shaders too). WebGL 2 enables no ESSL 1.00 extension, so no extension
 *   macro is predefined; the host's own extension layers define private
 *   macros in the source instead (external-texture.ts, essl3-translation.ts).
 * - #line N makes the following line N (ESSL 1.00 and 3.00 agree).
 * - A backslash-newline is a line continuation; each physical line still
 *   counts for __LINE__.
 * - A preprocessing number is C's, except that a sign continues only a
 *   decimal exponent (ESSL has no hex floats, so 0xe+1 is three tokens).
 * - Function-like macro arguments are macro-expanded before substitution
 *   and the result is rescanned; a macro is not re-expanded inside its own
 *   expansion (C's rule; ESSL has no # or ## operators).
 * - Undefined identifiers in #if evaluate to 0. ESSL 1.00 makes them errors,
 *   so in accepted input they occur only where || or && short-circuits.
 */

export type EsslToken = {
  text: string;
  kind: "id" | "num" | "op";
  /** Logical line (after #line) and source string number. */
  line: number;
  file: number;
  /** Whitespace (or a comment) preceded the token. */
  space: boolean;
  /** Macros that may not expand this token again (C's "hide set"). */
  hide?: ReadonlySet<string>;
};

/** A #pragma or #extension directive in an active group, positioned before
 * code token `at` of the output. */
export type EsslDirective = { kind: "pragma" | "extension"; tokens: string[]; line: number; file: number; at: number };

export type PreprocessedEssl = { tokens: EsslToken[]; directives: EsslDirective[] };

type Raw = { text: string; kind: EsslToken["kind"] | "nl"; line: number; space: boolean };

const PUNCTUATORS = ["<<=", ">>=", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "^^",
  "+=", "-=", "*=", "/=", "%=", "&=", "^=", "|="];

/** Preprocessing tokens and line ends ("nl"); comments and continuations
 * are whitespace, and a newline inside a block comment continues the
 * logical line (as in C, where a comment becomes one space first). */
function tokenize(source: string): Raw[] {
  const out: Raw[] = [];
  const n = source.length;
  let i = 0, line = 1, space = false;
  const identStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
  const digit = (c: string) => c >= "0" && c <= "9";
  const identPart = (c: string) => identStart(c) || digit(c);
  // Skip a line continuation at i, if any.
  const splice = () => {
    while (source[i] === "\\" && (source[i + 1] === "\n" || (source[i + 1] === "\r" && source[i + 2] === "\n"))) {
      i += source[i + 1] === "\n" ? 2 : 3; line++;
    }
  };
  // The character at i after continuations, without consuming it.
  const peek = (k = 0) => {
    let j = i, seen = 0;
    for (;;) {
      while (source[j] === "\\" && (source[j + 1] === "\n" || (source[j + 1] === "\r" && source[j + 2] === "\n")))
        j += source[j + 1] === "\n" ? 2 : 3;
      if (seen === k) return source[j] ?? "";
      j++; seen++;
    }
  };
  const take = () => { splice(); return source[i++]; };
  while (i < n) {
    splice();
    if (i >= n) break;
    const c = source[i];
    if (c === "\n") { out.push({ text: "\n", kind: "nl", line, space }); line++; i++; space = false; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") { i++; space = true; continue; }
    if (c === "/" && peek(1) === "/") {
      while (i < n && source[i] !== "\n") i++;
      space = true; continue;
    }
    if (c === "/" && peek(1) === "*") {
      take(); take();
      while (i < n && !(source[i] === "*" && peek(1) === "/")) { if (source[i] === "\n") line++; i++; }
      if (i < n) { take(); take(); }
      space = true; continue;
    }
    let text = "";
    const start = line;
    if (identStart(c)) {
      while (i < n && identPart(peek())) text += take();
      out.push({ text, kind: "id", line: start, space }); space = false; continue;
    }
    if (digit(c) || (c === "." && digit(peek(1)))) {
      // A C preprocessing number: digits, letters, '.', and an exponent sign.
      for (;;) {
        const d = peek();
        if (digit(d) || identStart(d) || d === ".") { text += take(); continue; }
        // A sign continues only a decimal exponent (1e-5), never hex 0xe+1.
        if ((d === "+" || d === "-") && /[eE]$/.test(text) && !/^0[xX]/.test(text)) { text += take(); continue; }
        break;
      }
      out.push({ text, kind: "num", line: start, space }); space = false; continue;
    }
    let match = c;
    for (const p of PUNCTUATORS) {
      let ok = true;
      for (let k = 0; k < p.length && ok; k++) ok = peek(k) === p[k];
      if (ok) { match = p; break; }
    }
    for (let k = 0; k < match.length; k++) take();
    out.push({ text: match, kind: "op", line: start, space }); space = false;
  }
  return out;
}

type Macro = { params: string[] | null; body: EsslToken[] };

/** The active code of an accepted ESSL 1.00 shader, macro-expanded. */
export function preprocessEssl100(source: string): PreprocessedEssl {
  const raw = tokenize(source);
  const macros = new Map<string, Macro>();
  const number = (value: number): EsslToken[] => [{ text: String(value), kind: "num", line: 0, file: 0, space: true }];
  macros.set("GL_ES", { params: null, body: number(1) });
  macros.set("__VERSION__", { params: null, body: number(100) });
  macros.set("GL_FRAGMENT_PRECISION_HIGH", { params: null, body: number(1) });
  const tokens: EsslToken[] = [], directives: EsslDirective[] = [];
  const groups: { active: boolean; taken: boolean; parent: boolean }[] = [];
  const active = () => groups.length === 0 || groups[groups.length - 1].active;
  let offset = 0, file = 0, pending: EsslToken[] = [];
  const flush = () => { if (pending.length) { tokens.push(...expand(pending)); pending = []; } };

  function expand(input: EsslToken[]): EsslToken[] {
    const out: EsslToken[] = [], queue = input.slice();
    let i = 0;
    while (i < queue.length) {
      const t = queue[i++];
      if (t.kind !== "id") { out.push(t); continue; }
      if (t.text === "__LINE__" || t.text === "__FILE__") {
        out.push({ ...t, kind: "num", text: String(t.text === "__LINE__" ? t.line : t.file), hide: undefined });
        continue;
      }
      const macro = macros.get(t.text);
      if (!macro || t.hide?.has(t.text)) { out.push(t); continue; }
      const hide = new Set(t.hide ?? []);
      hide.add(t.text);
      const place = (body: EsslToken): EsslToken => ({ ...body, line: t.line, file: t.file,
        hide: body.hide ? new Set([...hide, ...body.hide]) : hide });
      if (!macro.params) {
        const replacement = macro.body.map(place);
        if (replacement.length) replacement[0] = { ...replacement[0], space: t.space };
        queue.splice(i, 0, ...replacement);
        continue;
      }
      if (queue[i]?.text !== "(") { out.push(t); continue; }
      // Arguments: balanced parentheses, split at top-level commas.
      const args: EsslToken[][] = [[]];
      let depth = 0, j = i + 1;
      for (; j < queue.length; j++) {
        const a = queue[j];
        if (a.text === "(") depth++;
        else if (a.text === ")") { if (depth === 0) break; depth--; }
        else if (a.text === "," && depth === 0) { args.push([]); continue; }
        args[args.length - 1].push(a);
      }
      const expanded = args.map(arg => expand(arg));
      const replacement: EsslToken[] = [];
      for (const b of macro.body) {
        const k = b.kind === "id" ? macro.params.indexOf(b.text) : -1;
        if (k < 0) { replacement.push(place(b)); continue; }
        const arg = expanded[k] ?? [];
        arg.forEach((a, index) => replacement.push({ ...a, line: t.line, file: t.file, space: index === 0 ? b.space : a.space }));
      }
      if (replacement.length) replacement[0] = { ...replacement[0], space: t.space };
      queue.splice(i, j - i + 1, ...replacement);
    }
    return out;
  }

  function evaluate(expression: EsslToken[]): number {
    // `defined` applies before macro expansion.
    const resolved: EsslToken[] = [];
    for (let k = 0; k < expression.length; k++) {
      const t = expression[k];
      if (t.text !== "defined") { resolved.push(t); continue; }
      const paren = expression[k + 1]?.text === "(";
      const name = expression[k + (paren ? 2 : 1)]?.text ?? "";
      k += paren ? 3 : 1;
      resolved.push({ ...t, kind: "num", text: macros.has(name) ? "1" : "0" });
    }
    const list = expand(resolved);
    let p = 0;
    const PRECEDENCE: Record<string, number> = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6,
      "<": 7, ">": 7, "<=": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10 };
    const unary = (): number => {
      const t = list[p++];
      if (!t) return 0;
      if (t.text === "(") { const v = binary(0); p++; return v; }
      if (t.text === "-") return -unary() | 0;
      if (t.text === "+") return unary();
      if (t.text === "~") return ~unary();
      if (t.text === "!") return unary() ? 0 : 1;
      if (t.kind === "num") {
        const s = t.text.replace(/[uU]$/, "");
        return (/^0[xX]/.test(s) ? parseInt(s.slice(2), 16) : /^0[0-7]+$/.test(s) ? parseInt(s, 8) : parseInt(s, 10)) | 0;
      }
      return 0; // an undefined identifier (short-circuited in accepted input)
    };
    const binary = (min: number): number => {
      let left = unary();
      for (;;) {
        const op = list[p]?.text, prec = op === undefined ? undefined : PRECEDENCE[op];
        if (prec === undefined || prec <= min) return left;
        p++;
        const right = binary(prec);
        switch (op) {
          case "||": left = left || right ? 1 : 0; break;
          case "&&": left = left && right ? 1 : 0; break;
          case "|": left |= right; break;
          case "^": left ^= right; break;
          case "&": left &= right; break;
          case "==": left = left === right ? 1 : 0; break;
          case "!=": left = left !== right ? 1 : 0; break;
          case "<": left = left < right ? 1 : 0; break;
          case ">": left = left > right ? 1 : 0; break;
          case "<=": left = left <= right ? 1 : 0; break;
          case ">=": left = left >= right ? 1 : 0; break;
          case "<<": left <<= right; break;
          case ">>": left >>= right; break;
          case "+": left = (left + right) | 0; break;
          case "-": left = (left - right) | 0; break;
          case "*": left = Math.imul(left, right); break;
          case "/": left = right ? (left / right) | 0 : 0; break;
          case "%": left = right ? left % right : 0; break;
        }
      }
    };
    return binary(0);
  }

  let k = 0;
  while (k < raw.length) {
    // One logical line: raw tokens up to the next line end.
    let end = k;
    while (end < raw.length && raw[end].kind !== "nl") end++;
    const lineTokens: EsslToken[] = [];
    for (let m = k; m < end; m++) {
      const r = raw[m];
      lineTokens.push({ text: r.text, kind: r.kind as EsslToken["kind"], line: r.line + offset, file, space: r.space });
    }
    const nextPhysical = end < raw.length ? raw[end].line + 1 : 0;
    k = end + 1;
    if (lineTokens[0]?.text !== "#") {
      if (active()) pending.push(...lineTokens);
      continue;
    }
    const keyword = lineTokens[1]?.text ?? "";
    const rest = lineTokens.slice(2);
    if (keyword === "if" || keyword === "ifdef" || keyword === "ifndef") {
      const parent = active();
      const value = !parent ? false : keyword === "if" ? evaluate(rest) !== 0
        : macros.has(rest[0]?.text ?? "") === (keyword === "ifdef");
      groups.push({ active: parent && value, taken: value, parent });
      continue;
    }
    if (keyword === "elif") {
      const g = groups[groups.length - 1];
      if (!g) continue;
      if (!g.parent || g.taken) g.active = false;
      else { g.active = evaluate(rest) !== 0; g.taken = g.active; }
      continue;
    }
    if (keyword === "else") {
      const g = groups[groups.length - 1];
      if (g) { g.active = g.parent && !g.taken; g.taken = true; }
      continue;
    }
    if (keyword === "endif") { groups.pop(); continue; }
    if (!active()) continue;
    // Expand the code before a directive with the macros defined so far.
    flush();
    if (keyword === "define") {
      const name = rest[0]?.text;
      if (!name) continue;
      if (rest[1]?.text === "(" && !rest[1].space) {
        const close = rest.findIndex(t => t.text === ")");
        const params = rest.slice(2, close).filter(t => t.text !== ",").map(t => t.text);
        macros.set(name, { params, body: rest.slice(close + 1) });
      } else macros.set(name, { params: null, body: rest.slice(1) });
    } else if (keyword === "undef") {
      macros.delete(rest[0]?.text ?? "");
    } else if (keyword === "line") {
      const values = expand(rest).filter(t => t.kind === "num").map(t => Number.parseInt(t.text, 10));
      if (values.length && nextPhysical) offset = values[0] - nextPhysical;
      if (values.length > 1) file = values[1];
    } else if (keyword === "pragma" || keyword === "extension") {
      directives.push({ kind: keyword, tokens: rest.map(t => t.text), line: lineTokens[0].line, file, at: tokens.length });
    }
    // #version and #error have no effect on accepted code.
  }
  flush();
  return { tokens, directives };
}
