import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Guard declared payloads; dynamic RPC values also need the browser probe. */
export function auditBrowserMessageTypes(candidate = "KernelToMainMessage | GlForwardMessage"): string[] {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const virtualFile = resolve(root, "__memory_boundary_type_probe.ts");
  const source = `
    import type { KernelToMainMessage } from "../../host/src/browser-kernel-protocol";
    import type { GlForwardMessage } from "../../host/src/webgl/main-forward";
    type Candidate = ${candidate};
    type GuestMemory = WebAssembly.Memory;
    type SharedBacking = SharedArrayBuffer;
  `;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, skipLibCheck: true, noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = file => file === virtualFile ? source : read(file);
  const program = ts.createProgram([virtualFile], options, host);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(virtualFile)!;
  const diagnostics = program.getSemanticDiagnostics(file);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }));
  const named = (name: string) => {
    const declaration = file.statements.find(node =>
      ts.isTypeAliasDeclaration(node) && node.name.text === name);
    if (!declaration || !ts.isTypeAliasDeclaration(declaration)) throw new Error(name);
    return checker.getTypeAtLocation(declaration);
  };
  const memory = named("GuestMemory"), shared = named("SharedBacking");
  const failures: string[] = [];
  const typedArrays = /^(?:(?:U?Int|Uint|Float|BigInt|BigUint)\d+|Uint8Clamped)Array$|^DataView$/;
  function visit(type: ts.Type, path: string, ancestors: Set<ts.Type>): void {
    if (ancestors.has(type)) return;
    const next = new Set(ancestors).add(type);
    if (type.isUnionOrIntersection()) {
      for (const member of type.types) visit(member, path, next);
      return;
    }
    if (!(type.flags & ts.TypeFlags.Object)) return;
    if (checker.isTypeAssignableTo(type, memory)) {
      failures.push(`${path}: WebAssembly.Memory is forbidden in browser-main payloads`);
      return;
    }
    if (checker.isTypeAssignableTo(type, shared)) {
      if (path !== "fb_bind.pixels" && path !== "gl_forward_query.mailbox"
          && path !== "gl_forward_create_context.mailbox"
          && path !== "gl_forward_make_current.mailbox"
          && path !== "gl_forward_create_surface.mailbox"
          && path !== "gl_forward_present.mailbox") {
        failures.push(`${path}: unreviewed SharedArrayBuffer payload`);
      }
      return;
    }
    const symbol = type.getSymbol();
    const libraryType = symbol?.declarations?.some(declaration =>
      /[/\\]lib\.[^/\\]+\.d\.ts$/.test(declaration.getSourceFile().fileName));
    if (libraryType) {
      // Byte views have broad ArrayBufferLike declarations today. Inspect
      // their actual backing with the runtime probe instead of claiming the
      // declaration proves that bytes were copied out of guest memory.
      if (!typedArrays.test(symbol!.name)) {
        for (const argument of checker.getTypeArguments(type as ts.TypeReference)) {
          visit(argument, `${path}[]`, next);
        }
      }
      return;
    }
    for (const property of checker.getPropertiesOfType(type)) {
      visit(checker.getTypeOfSymbolAtLocation(property, file), `${path}.${property.name}`, next);
    }
    for (const index of checker.getIndexInfosOfType(type)) visit(index.type, `${path}[]`, next);
  }
  const candidateType = named("Candidate");
  for (const message of candidateType.isUnion() ? candidateType.types : [candidateType]) {
    const discriminator = message.getProperty("type");
    const type = discriminator && checker.getTypeOfSymbolAtLocation(discriminator, file);
    const label = type?.isStringLiteral() ? type.value : "message";
    visit(message, label, new Set());
  }
  return failures;
}
