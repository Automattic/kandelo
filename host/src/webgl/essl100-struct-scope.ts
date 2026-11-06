import { glslTokens } from "./glsl-tokens.js";

const BASIC = new Set(["void", "float", "int", "bool", "vec2", "vec3", "vec4", "ivec2", "ivec3", "ivec4",
  "bvec2", "bvec3", "bvec4", "mat2", "mat3", "mat4", "sampler2D", "samplerCube"]);
const QUALIFIERS = new Set(["const", "lowp", "mediump", "highp"]);

/** [RUNTIME-WORKAROUND: FIREFOX-ESSL100-STRUCT-HIDING] Preserve ES100
 * local/type hiding without making the native parser classify one spelling
 * as both a variable and constructor. Public type/interface names stay intact;
 * a local's initializer still sees its preceding binding. */
export function hideStructLocals(source: string): string {
  // These raw-token bindings do not prove which conditional declarations or
  // macro expansions reach the compiler. Do not publish a guessed rename.
  const directives = glslTokens(source.replace(/\\\r?\n/g, ""), true);
  if (directives.some((token, i) => token.directive && token.text === "#" &&
    ["define", "undef", "if", "ifdef", "ifndef", "else", "elif", "endif"].includes(directives[i + 1]?.text))) return source;
  const tokens = glslTokens(source, false), structures = new Set<string>();
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text === "struct") {
      if (depth) return source;
      if (tokens[i + 1] && tokens[i + 2]?.text === "{") structures.add(tokens[i + 1].text);
    }
    if (tokens[i].text === "{") depth++;
    else if (tokens[i].text === "}") depth--;
  }
  if (!structures.size || depth !== 0) return source;
  const scopes = [new Map<string, string>()], edits = new Map<number, string>();
  const identifiers = new Set(source.match(/[A-Za-z_]\w*/g) ?? []);
  let functionDepth = 0, counter = 0;
  depth = 0;
  const binding = (name: string) => {
    for (let k = scopes.length - 1; k >= 0; k--) {
      const renamed = scopes[k].get(name);
      if (renamed) return renamed;
    }
    return undefined;
  };
  const reference = (i: number) => {
    // A member has its structure's namespace, not the enclosing local scope.
    if (tokens[i - 1]?.text === ".") return;
    const renamed = binding(tokens[i].text);
    if (renamed) edits.set(i, renamed);
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].text;
    if (token === "{") {
      if (depth === 0 && tokens[i - 1]?.text === ")") {
        // A same-named parameter already hides the global type. Keep that
        // independent header binding intact rather than infer another type.
        let open = i - 2, nesting = 1;
        for (; open >= 0; open--) {
          if (tokens[open].text === ")") nesting++;
          else if (tokens[open].text === "(" && --nesting === 0) break;
        }
        for (let k = open + 1; k < i - 1; k++)
          if (structures.has(tokens[k].text) && [",", ")", "["].includes(tokens[k + 1]?.text)) return source;
        functionDepth = depth + 1;
      }
      depth++; scopes.push(new Map()); continue;
    }
    if (token === "}") {
      depth--; scopes.pop();
      if (functionDepth && depth < functionDepth) functionDepth = 0;
      continue;
    }
    if (!functionDepth) continue;
    if (["{", ";", "}"].includes(tokens[i - 1]?.text)) {
      let typeAt = i;
      while (QUALIFIERS.has(tokens[typeAt]?.text)) typeAt++;
      const type = tokens[typeAt]?.text;
      const isType = BASIC.has(type) || (structures.has(type) && !binding(type));
      if (isType && /^[A-Za-z_]\w*$/.test(tokens[typeAt + 1]?.text ?? "") && tokens[typeAt + 2]?.text !== "(") {
        let nameAt = typeAt + 1, completed = false;
        while (nameAt < tokens.length) {
          if (!/^[A-Za-z_]\w*$/.test(tokens[nameAt]?.text ?? "")) return source;
          const name = tokens[nameAt].text;
          let renamed: string | undefined;
          if (structures.has(name)) {
            if (tokens[nameAt + 1]?.text === "[") return source;
            // Reuse a same-scope binding: inventing another name would make
            // an invalid duplicate declaration compile successfully.
            renamed = scopes.at(-1)!.get(name);
            if (!renamed) {
              do { renamed = `kandelo_struct_local_${counter++}`; } while (identifiers.has(renamed));
              identifiers.add(renamed);
            }
            edits.set(nameAt, renamed);
          } else reference(nameAt);
          // The initializer sees the OLD binding; only a completed declarator
          // publishes its local name, including before the next comma item.
          let end = nameAt + 1, nesting = 0;
          for (; end < tokens.length; end++) {
            const text = tokens[end].text;
            if (!nesting && (text === "," || text === ";")) break;
            if (text === "{" || text === "}") return source;
            if (text === "(" || text === "[") nesting++;
            else if (text === ")" || text === "]") nesting--;
            reference(end);
          }
          // Discard all staged edits if an endpoint is unproven; a partial
          // rename could silently bind a later use to the public type again.
          if (end === tokens.length) return source;
          if (renamed) scopes.at(-1)!.set(name, renamed);
          if (tokens[end].text === ";") { i = end; completed = true; break; }
          nameAt = end + 1;
        }
        if (completed) continue;
      }
    }
    reference(i);
  }
  for (const [i, renamed] of [...edits].sort((a, b) => b[0] - a[0]))
    source = source.slice(0, tokens[i].start) + renamed + source.slice(tokens[i].end);
  return source;
}
