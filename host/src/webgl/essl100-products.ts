import { glslTokens } from "./glsl-tokens.js";

const TYPES = new Set(["float", "vec2", "vec3", "vec4"]);
const PRECISIONS = new Set(["lowp", "mediump", "highp"]);
const PREFIX_TERMS = 128;

/** Decompose a long flat product for a native retry or ES300 translation,
 * without reassociating it.
 * Every temporary is a left-fold prefix with the operands' explicit type
 * and precision. These are decomposition sizes, never guest shader limits.
 * Native ES100 validation still checks the complete resulting program. */
export function lowerLongProducts(source: string): string {
  // Macro expansion could change operand types or introduce side effects.
  // Keep that uncertainty visible instead of guessing from unexpanded names.
  const directiveTokens = glslTokens(source.replace(/\\\r?\n/g, ""), true);
  if (directiveTokens.some((token, i) => token.directive && token.text === "#" &&
    ["define", "undef"].includes(directiveTokens[i + 1]?.text))) return source;
  const tokens = glslTokens(source, false);
  const identifiers = new Set(source.match(/[A-Za-z_]\w*/g) ?? []);
  const declarations = new Map<string, { type: string; precision: string; count: number }>();
  for (let i = 0; i < tokens.length; i++) {
    if (!TYPES.has(tokens[i].text) || !/^[A-Za-z_]\w*$/.test(tokens[i + 1]?.text ?? "") || tokens[i + 2]?.text === "(") continue;
    const name = tokens[i + 1].text, old = declarations.get(name);
    declarations.set(name, { type: tokens[i].text,
      precision: PRECISIONS.has(tokens[i - 1]?.text) ? tokens[i - 1].text : "", count: (old?.count ?? 0) + 1 });
  }
  const edits: { start: number; end: number; text: string }[] = [];
  const braces: ("function" | "block" | "unknown")[] = [];
  let parentheses = 0, brackets = 0, counter = 0;
  for (let i = 0; i < tokens.length; i++) {
    const type = tokens[i].text;
    if (type === "(") { parentheses++; continue; }
    if (type === ")") { parentheses--; continue; }
    if (type === "[") { brackets++; continue; }
    if (type === "]") { brackets--; continue; }
    if (type === "{") {
      const previous = tokens[i - 1]?.text, parent = braces.at(-1);
      let kind: "function" | "block" | "unknown" = "unknown";
      if (!braces.length && previous === ")") {
        let open = i - 2, nesting = 1;
        for (; open >= 0; open--) {
          if (tokens[open].text === ")") nesting++;
          else if (tokens[open].text === "(" && --nesting === 0) break;
        }
        if (/^[A-Za-z_]\w*$/.test(tokens[open - 1]?.text ?? "") &&
          /^[A-Za-z_]\w*$/.test(tokens[open - 2]?.text ?? "") &&
          !["if", "for", "while", "switch"].includes(tokens[open - 1].text)) kind = "function";
      } else if ((parent === "function" || parent === "block") &&
        [")", "else", "do", "{", ";", "}"].includes(previous)) kind = "block";
      braces.push(kind); continue;
    }
    if (type === "}") { braces.pop(); continue; }
    // Splitting a const declaration must preserve its readonly binding and
    // constant-expression uses. This mutable-local decomposition grants no
    // authority over those separate rules.
    // Several declarations cannot replace one for-header expression or one
    // unbraced controlled statement. Prove a standalone declaration in a
    // function compound block before introducing any prefix statements.
    if (!["function", "block"].includes(braces.at(-1) ?? "") || parentheses || brackets ||
      !["{", ";", "}"].includes(tokens[i - 2]?.text) ||
      !TYPES.has(type) || !PRECISIONS.has(tokens[i - 1]?.text) ||
      tokens[i - 2]?.text === "const" || tokens[i + 2]?.text !== "=") continue;
    const precision = tokens[i - 1].text, name = tokens[i + 1].text;
    let end = i + 3;
    while (end < tokens.length && tokens[end].text !== ";" && tokens[end].text !== "}") end++;
    if (tokens[end]?.text !== ";") continue;
    // Directives have effects beyond line numbering. A multiline initializer
    // containing one must remain intact; padding its newlines cannot restore
    // a removed #line, #pragma or conditional directive.
    if (source.slice(tokens[i - 1].start, tokens[end].end).includes("#")) continue;
    const terms: string[] = [];
    let valid = true;
    for (let p = i + 3; p < end; p++) {
      const text = tokens[p].text;
      if ((p - i - 3) % 2) { if (text !== "*") valid = false; continue; }
      const declaration = declarations.get(text);
      // A name declared more than once needs lexical binding resolution;
      // its spelling cannot prove type or precision. Self-shadowing initializers
      // also read a different binding until the declaration is complete.
      if (!declaration || declaration.count !== 1 || declaration.type !== type ||
        declaration.precision !== precision || text === name) valid = false;
      terms.push(text);
    }
    if (!valid || terms.length < 513 || (end - i - 3) % 2 === 0) continue;
    let prefix = "", text = "";
    for (let start = 0; start < terms.length; start += PREFIX_TERMS) {
      let temporary: string;
      do { temporary = `kandelo_product_${counter++}`; } while (identifiers.has(temporary));
      identifiers.add(temporary);
      // Put the completed prefix FIRST. Multiplying it by a separately
      // evaluated chunk would change the original left-associative evaluation.
      const expression = [...(prefix ? [prefix] : []), ...terms.slice(start, start + PREFIX_TERMS)].join("*");
      text += `${precision} ${type} ${temporary}=${expression};`;
      prefix = temporary;
    }
    text += `${precision} ${type} ${name}=${prefix};`;
    // No term is a builtin macro or a call, and later guest lines keep their
    // original positions even when the product used several physical lines.
    text += "\n".repeat((source.slice(tokens[i - 1].start, tokens[end].end).match(/\n/g) ?? []).length);
    edits.push({ start: tokens[i - 1].start, end: tokens[end].end, text });
    i = end;
  }
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}
