export type GlslToken = { text: string; start: number; end: number; directive: boolean };
/** GLSL ES tokens outside comments; `directives` keeps preprocessor lines
 * (marked), otherwise they are skipped. */
export function glslTokens(source: string, directives: boolean): GlslToken[] {
  const out: GlslToken[] = [];
  const n = source.length;
  let i = 0, lineStart = true, directive = false;
  const ident = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < n) {
    const c = source[i];
    if (c === "\n") { lineStart = true; directive = false; i++; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }
    if (c === "/" && source[i + 1] === "/") { while (i < n && source[i] !== "\n") i++; continue; }
    if (c === "/" && source[i + 1] === "*") { const e = source.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "#" && lineStart) {
      if (!directives) { while (i < n && source[i] !== "\n") i++; continue; }
      directive = true;
    }
    lineStart = false;
    const start = i;
    if (ident(c)) { while (i < n && (ident(source[i]) || (/[0-9]/.test(source[start]) && source[i] === "."))) i++; }
    else i++;
    out.push({ text: source.slice(start, i), start, end: i, directive });
  }
  return out;
}
