// Minimal typing for Chrome's imperative WebMCP API. The document exposes
// `modelContext` only behind a flag; every other browser gets `null` here.

export interface ModelContextTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, options: { signal: AbortSignal }): Promise<unknown>;
}

export interface ModelContext {
  registerTool(tool: ModelContextTool, options?: { signal: AbortSignal }): Promise<void> | void;
}

export function modelContextOf(doc: Document): ModelContext | null {
  const context = (doc as Document & { modelContext?: Partial<ModelContext> }).modelContext;
  return typeof context?.registerTool === "function" ? (context as ModelContext) : null;
}
