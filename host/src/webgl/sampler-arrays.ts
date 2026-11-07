import type { EsslToken } from "./essl-preprocessor.js";

type ArrayBinding = { size: number; type: string; nativeParams?: string[] };
type Signature = { ret: string; params: string[]; directions?: string[]; suffixes?: string[] };
const precise = (type: string) => /^(float|int|vec[234]|ivec[234]|mat[234]|sampler2D|sampler2DArray)$/.test(type) ? `highp ${type}` : type;

/** Scalar integer constants used by sampler declarations. The real ES 1.00
 * compiler has already checked types and constant-expression legality. */
function integer(tokens: readonly EsslToken[], constants: ReadonlyMap<string, number>): number | undefined {
  let at = 0;
  const precedence: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3,
    "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
  const unary = (): number => {
    const token = tokens[at++];
    if (!token) return NaN;
    if (token.text === "(") { const value = binary(0); return tokens[at++]?.text === ")" ? value : NaN; }
    if (token.text === "-") return -unary();
    if (token.text === "+") return unary();
    if (token.text === "!") { const value = unary(); return Number.isNaN(value) ? NaN : Number(!value); }
    if (token.kind === "num") return /^0[0-7]+$/.test(token.text) ? parseInt(token.text, 8) : Number(token.text);
    return constants.get(token.text) ?? NaN;
  };
  const binary = (min: number): number => {
    let left = unary();
    while ((precedence[tokens[at]?.text] ?? 0) > min) {
      const op = tokens[at++].text, right = binary(precedence[op]);
      if (Number.isNaN(left) || Number.isNaN(right)) return NaN;
      switch (op) {
        case "+": left += right; break;
        case "-": left -= right; break;
        case "*": left *= right; break;
        case "/": left = Math.trunc(left / right); break;
        case "%": left %= right; break;
        case "==": left = Number(left === right); break;
        case "!=": left = Number(left !== right); break;
        case "<": left = Number(left < right); break;
        case "<=": left = Number(left <= right); break;
        case ">": left = Number(left > right); break;
        case ">=": left = Number(left >= right); break;
        case "&&": left = Number(!!left && !!right); break;
        case "||": left = Number(!!left || !!right); break;
      }
    }
    return left;
  };
  const value = binary(0);
  return at === tokens.length && Number.isSafeInteger(value) ? value : undefined;
}

/** ES 1.00 permits sampler-array loop indices; ES 3.00 requires
 * constant integral indices. Dispatch a lookup to statically indexed samplers without
 * duplicating evaluation of its coordinates or executing another case's
 * lookup. Shaders without an indexed sampler lookup acquire no helper. */
export function lowerSamplerArrayLookups(tokens: readonly EsslToken[], depth: Int32Array, out: string[],
    options: { prefix: string; signatures(name: string): Signature[] | null; declared: ReadonlySet<string> }): string[] {
  const at = (i: number) => tokens[i]?.text;
  const close = (open: number) => {
    const opening = at(open), closing = opening === "[" ? "]" : ")";
    for (let i = open, d = 0; i < tokens.length; i++) {
      if (at(i) === opening) d++;
      else if (at(i) === closing && --d === 0) return i;
    }
    return -1;
  };
  const constants = new Map<string, number>();
  const arrays = new Map<string, ArrayBinding>();
  for (let i = 0; i < tokens.length; i++) {
    if (depth[i] !== 0) continue;
    if (at(i) === "const" && at(i + 1) === "int") {
      for (let j = i + 2; j < tokens.length && at(j) !== ";"; j++) {
        if (tokens[j]?.kind !== "id" || at(j + 1) !== "=") continue;
        let end = j + 2, nest = 0;
        for (; end < tokens.length; end++) {
          if (at(end) === "(") nest++;
          else if (at(end) === ")") nest--;
          else if (nest === 0 && [",", ";"].includes(at(end)!)) break;
        }
        const value = integer(tokens.slice(j + 2, end), constants);
        if (value !== undefined) constants.set(at(j)!, value);
        j = end - 1;
      }
    }
    if (at(i) !== "uniform") continue;
    let typeAt = i + 1;
    while (["lowp", "mediump", "highp"].includes(at(typeAt)!)) typeAt++;
    if (!["sampler2D", "samplerCube"].includes(at(typeAt)!)) continue;
    let end = typeAt + 1;
    while (end < tokens.length && at(end) !== ";") end++;
    for (let name = typeAt + 1; name < end; name++) {
      if (tokens[name].kind !== "id" || at(name + 1) !== "[") continue;
      const bracket = close(name + 1);
      const size = integer(tokens.slice(name + 2, bracket), constants);
      if (size !== undefined && size > 0)
        arrays.set(at(name)!, { size, type: at(typeAt)! });
      name = bracket;
    }
  }
  if (!arrays.size && !tokens.some((token, i) => ["sampler2D", "samplerCube"].includes(token.text) && at(i + 2) === "[")) return [];
  type ArrayParam = { position: number; from: number; to: number; typeAt: number; root: number; binding: ArrayBinding };
  type FunctionScope = { nameAt: number; open: number; close: number; begin: number; end: number;
    arity: number; names: string[]; start: number; signature: Signature; native: string; arrays: ArrayParam[]; bindings: Map<string, ArrayBinding | null> };
  const scopes: FunctionScope[] = [];
  const split = (open: number, end: number): Array<[number, number]> => {
    const parts: Array<[number, number]> = [];
    let begin = open + 1;
    for (let j = begin, nested = 0; j < end; j++) {
      if (["(", "["].includes(at(j)!)) nested++;
      else if ([")", "]"].includes(at(j)!)) nested--;
      else if (at(j) === "," && nested === 0) { parts.push([begin, j]); begin = j + 1; }
    }
    if (begin < end && !(end === begin + 1 && at(begin) === "void")) parts.push([begin, end]);
    return parts;
  };
  for (let i = 0; i < tokens.length; i++) {
    if (depth[i] !== 0 || at(i) !== "(" || tokens[i - 1]?.kind !== "id" || tokens[i - 2]?.kind !== "id") continue;
    const end = close(i);
    if (end < 0 || !["{", ";"].includes(at(end + 1)!)) continue;
    let bodyEnd = end + 2;
    if (at(end + 1) === "{")
      while (bodyEnd < tokens.length && !(at(bodyEnd) === "}" && depth[bodyEnd] === 1)) bodyEnd++;
    const bindings = new Map<string, ArrayBinding | null>(), parameters = split(i, end), arrayParams: ArrayParam[] = [];
    for (const [position, [from, to]] of parameters.entries()) {
      const typeAt = tokens.findIndex((token, j) => j >= from && j < to && ["sampler2D", "samplerCube"].includes(token.text));
      if (typeAt < 0) continue;
      const root = typeAt + 1, name = at(root)!;
      const bound = at(root + 1) === "[" ? close(root + 1) : -1;
      const size = bound < 0 ? undefined : integer(tokens.slice(root + 2, bound), constants);
      const binding = size !== undefined && size > 0 ? { size, type: at(typeAt)!,
        nativeParams: Array.from({ length: size }, (_, k) => `${options.prefix}array_param_${position}_${k}`) } : null;
      bindings.set(name, binding);
      if (binding) arrayParams.push({ position, from, to, typeAt, root, binding });
    }
    const params: string[] = [], directions: string[] = [], suffixes: string[] = [], names: string[] = [];
    for (const [position, [from, to]] of parameters.entries()) {
      let typeAt = from;
      while (["const", "in", "out", "inout", "lowp", "mediump", "highp"].includes(at(typeAt)!)) typeAt++;
      if (tokens[typeAt + 1]?.kind === "id") names.push(at(typeAt + 1)!);
      const direction = tokens.slice(from, typeAt).map(t => t.text).find(t => t === "out" || t === "inout") ?? "in";
      const array = arrayParams.find(param => param.position === position);
      const count = array?.binding.size ?? 1;
      for (let k = 0; k < count; k++) {
        params.push(["sampler2D", "samplerCube"].includes(at(typeAt)!) ? at(typeAt)! : out[typeAt]);
        directions.push(direction);
        suffixes.push(array ? "" : out.slice(typeAt + 2, to).join(" "));
      }
    }
    let start = i - 2;
    while (["lowp", "mediump", "highp"].includes(at(start - 1)!)) start--;
    const signature = { ret: out[i - 2], params, directions, suffixes };
    const suffix = arrayParams.map(p => `${p.position}_${p.binding.type}_${p.binding.size}`).join("_");
    scopes.push({ nameAt: i - 1, open: i, close: end, begin: at(end + 1) === "{" ? end + 1 : -1,
      end: at(end + 1) === "{" ? bodyEnd : -1, arity: parameters.length, names, start, signature,
      native: arrayParams.length ? `${options.prefix}array_fn_${out[i - 1]}_${suffix}` : out[i - 1], arrays: arrayParams, bindings });
    i = end;
  }
  /** Local declarations may shadow a global integer constant. Resolve the
   * lexical environment before replacing an array parameter's constant index. */
  const constantsAt = (position: number): ReadonlyMap<string, number> => {
    const scope = scopes.find(scope => position > scope.begin && position < scope.end);
    if (!scope) return constants;
    const initial = new Map(constants);
    for (const name of scope.names) initial.delete(name);
    const frames = [initial];
    for (let i = scope.begin + 1; i < position; i++) {
      if (at(i) === "{") { frames.push(new Map(frames[frames.length - 1])); continue; }
      if (at(i) === "}") { if (frames.length > 1) frames.pop(); continue; }
      const constant = at(i) === "const";
      let typeAt = constant ? i + 1 : i;
      while (["highp", "mediump", "lowp"].includes(at(typeAt)!)) typeAt++;
      if (!["int", "float", "bool"].includes(at(typeAt)!) || tokens[typeAt + 1]?.kind !== "id") continue;
      for (let root = typeAt + 1; root < position;) {
        if (tokens[root]?.kind !== "id") break;
        let end = root + 1, nest = 0;
        for (; end < position; end++) {
          if (["(", "["].includes(at(end)!)) nest++;
          else if ([")", "]"].includes(at(end)!)) nest--;
          else if (nest === 0 && [",", ";"].includes(at(end)!)) break;
        }
        const env = frames[frames.length - 1];
        const value = constant && at(typeAt) === "int" && at(root + 1) === "="
          ? integer(tokens.slice(root + 2, end), env) : undefined;
        if (value === undefined) env.delete(at(root)!); else env.set(at(root)!, value);
        if (at(end) !== ",") { i = end; break; }
        root = end + 1;
      }
    }
    return frames[frames.length - 1];
  };
  const bindingAt = (root: number) => {
    const local = scopes.find(scope => root > scope.begin && root < scope.end)?.bindings;
    return local?.has(at(root)!) ? local.get(at(root)!) : arrays.get(at(root)!);
  };
  // [RUNTIME-WORKAROUND: FIREFOX-SAMPLER-ARRAY-DISPATCH-LINK-CRASH]
  // A guest's array parameter must be scalarized too: forwarding any of its
  // elements to a helper reaches the same independently reproduced link crash.
  for (const scope of scopes) if (scope.arrays.length) {
    out[scope.nameAt] = scope.native;
    for (const param of scope.arrays) {
      const qualifiers = out.slice(param.from, param.typeAt).join(" "), type = out[param.typeAt];
      out[param.from] = param.binding.nativeParams!.map(name => `${qualifiers} ${type} ${name}`).join(", ");
      for (let j = param.from + 1; j < param.to; j++) out[j] = "";
    }
  }
  const declarations = new Set(scopes.map(scope => scope.nameAt));
  for (let call = 0; call < tokens.length; call++) {
    if (at(call + 1) !== "(" || declarations.has(call)) continue;
    const end = close(call + 1);
    if (end < 0) continue;
    const args = split(call + 1, end);
    const callee = scopes.find(scope => scope.arrays.length && at(scope.nameAt) === at(call) && scope.arity === args.length
      && scope.arrays.every(param => {
        const actual = bindingAt(args[param.position][0]);
        return !actual || (actual.size === param.binding.size && actual.type === param.binding.type);
      }));
    if (!callee) continue;
    out[call] = callee.native;
    for (const param of callee.arrays) {
      const [from, to] = args[param.position], actual = bindingAt(from);
      const path = out.slice(from, to).join(" ");
      out[from] = actual?.nativeParams?.join(", ") ?? Array.from({ length: param.binding.size }, (_, k) => `${path}[${k}]`).join(", ");
      for (let j = from + 1; j < to; j++) out[j] = "";
    }
  }
  const helpers: string[] = [], prototypes = new Map<number, string[]>(), cached = new Map<string, string>();
  for (let call = 0; call < tokens.length; call++) {
    const name = at(call)!;
    if (at(call + 1) !== "(" || declarations.has(call)) continue;
    const originalEnd = close(call + 1);
    if (originalEnd < 0) continue;
    const trailingFlags = out[originalEnd] !== ")";
    const own = scopes.filter(scope => at(scope.nameAt) === name).map(scope => ({ ...scope.signature,
      params: [...scope.signature.params, ...(trailingFlags ? scope.signature.params.filter(t => ["sampler2D", "samplerCube"].includes(t)).map(() => "bool") : [])] }));
    const signatures = [...options.signatures(name) ?? [], ...own].filter(s => ["sampler2D", "samplerCube"].includes(s.params[0]));
    if (!signatures?.length) continue;
    const root = call + 2;
    const array = bindingAt(root);
    if (!array || at(root + 1) !== "[") continue;
    const bracket = close(root + 1);
    if (bracket < 0 || ![",", ")"].includes(at(bracket + 1)!) || integer(tokens.slice(root + 2, bracket), constantsAt(root)) !== undefined) continue;
    const nativeCall = out[call], flagged = out[call + 1] !== "(";
    const key = `${array.type}|${array.size}|${nativeCall}|${flagged}`;
    let helper = cached.get(key);
    if (!helper) {
      helper = `${options.prefix}sampler_array_${cached.size}`;
      cached.set(key, helper);
      const emitted = new Set<string>();
      for (const signature of signatures.filter(s => s.params[0] === array.type)) {
        const signatureKey = JSON.stringify([signature.ret, signature.params, signature.directions, signature.suffixes]);
        if (emitted.has(signatureKey)) continue;
        emitted.add(signatureKey);
        const parameters = signature.params.slice(1).map((type, i) =>
          `${signature.directions?.[i + 1] ?? "in"} ${precise(type === "samplerCube" ? "sampler2DArray" : type)} p${i}${signature.suffixes?.[i + 1] ?? ""}`);
        const samplerType = array.type === "samplerCube" ? "sampler2DArray" : "sampler2D";
        // [RUNTIME-WORKAROUND: FIREFOX-SAMPLER-ARRAY-DISPATCH-LINK-CRASH]
        // Scalar sampler parameters avoid the standalone-reproduced Firefox
        // link crash when switch cases pass elements of a sampler-array parameter.
        const samplers = Array.from({ length: array.size }, (_, k) => `highp ${samplerType} s${k}`);
        const declaration = `${precise(signature.ret)} ${helper}(${[...(flagged ? ["bool on"] : []), ...samplers, "int index", ...parameters].join(", ")})`;
        const invoke = (k: number) => `${nativeCall}(${[...(flagged ? ["on"] : []), `s${k}`, ...parameters.map((_, i) => `p${i}`)].join(", ")})`;
        const result = (k: number) => signature.ret === "void" ? `${invoke(k)}; return;` : `return ${invoke(k)};`;
        const cases = Array.from({ length: array.size }, (_, k) => `case ${k}: ${result(k)}`);
        helpers.push(`${declaration} { switch (index) { ${cases.join(" ")} } ${result(0)} }`);
        const position = scopes.find(scope => call > scope.begin && call < scope.end)?.start ?? 0;
        const previous = prototypes.get(position) ?? [];
        if (!previous.includes(`${declaration};`)) prototypes.set(position, [...previous, `${declaration};`]);
      }
    }
    out[call] = helper;
    out[root] = `${array.nativeParams?.join(", ") ?? Array.from({ length: array.size }, (_, k) => `${out[root]}[${k}]`).join(", ")}, int(${out.slice(root + 2, bracket).join(" ")})`;
    for (let i = root + 1; i <= bracket; i++) out[i] = "";
  }
  for (let root = 0; root < tokens.length; root++) {
    if (at(root + 1) !== "[") continue;
    const array = bindingAt(root), end = close(root + 1);
    if (!array?.nativeParams || end < 0) continue;
    const index = integer(tokens.slice(root + 2, end), constantsAt(root));
    if (index === undefined || index < 0 || index >= array.size) continue;
    out[root] = array.nativeParams[index];
    for (let j = root + 1; j <= end; j++) out[j] = "";
  }
  for (const [position, declarations] of prototypes) {
    const token = tokens[position];
    out[position] = `${declarations.join("\n")}\n#line ${token.line}${token.file ? ` ${token.file}` : ""}\n${out[position]}`;
  }
  return helpers;
}
