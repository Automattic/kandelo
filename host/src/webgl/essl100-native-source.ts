import {hideStructLocals} from "./essl100-struct-scope.js";
import { glslTokens } from "./glsl-tokens.js";
import { macroDefinedConditionalSource } from "./essl-preprocessor.js";

/** [RUNTIME-WORKAROUND: WEBGL-ESSL100-PARAMETER-SCOPE] ES100 §4.2.2
 * gives a function body a child scope of its parameters. An extra compound
 * statement preserves that scope on native validators that combine them.
 * Keep every original token, directive and line: preprocessing or renaming
 * declarations here could accidentally repair an otherwise invalid shader. */
export function nestedFunctionBodySource(source: string): string {
  const tokens = glslTokens(source, false), edits: number[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].text;
    if (token === "}") { depth--; continue; }
    if (token !== "{") continue;
    if (depth++ !== 0 || tokens[i - 1]?.text !== ")") continue;
    let close = i + 1, nested = 1;
    for (; close < tokens.length; close++) {
      if (tokens[close].text === "{") nested++;
      else if (tokens[close].text === "}" && --nested === 0) break;
    }
    if (close === tokens.length) continue;
    edits.push(tokens[i].end, tokens[close].start);
  }
  // Insert from the end so no stored source offset changes underneath us.
  for (let i = edits.length - 1; i >= 0; i--)
    source = source.slice(0, edits[i]) + (i % 2 ? " } " : " { ") + source.slice(edits[i]);
  return source;
}

/** A failed native ES100 compile may meet a guest-language rule WebGL does
 * not implement. Normalize only these spellings, then let the SAME ES100
 * validator judge all remaining syntax/types before considering ES300. */
export function compatibleEssl100Source(source: string): string {
  return hideStructLocals(nestedFunctionBodySource(macroDefinedConditionalSource(source)));
}
