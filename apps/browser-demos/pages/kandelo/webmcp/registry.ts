import { ToolError, validate, type Schema } from "./contract";
import type { ModelContext, ToolAnnotations } from "./model-context";

// Reserved for the tools this app ships. A booted image arrives from a URL a
// share link names, so an image-declared tool carrying this prefix would let
// untrusted input impersonate a built-in.
export const BUILT_IN_PREFIX = "kandelo_";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations: ToolAnnotations;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export function objectSchema(
  properties: Record<string, Schema>,
  required: readonly string[],
): Schema {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

export function builtInTool(
  name: string,
  description: string,
  readOnly: boolean,
  inputSchema: Schema,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name: `${BUILT_IN_PREFIX}${name}`,
    description,
    inputSchema,
    annotations: { readOnlyHint: readOnly, untrustedContentHint: true },
    execute,
  };
}

export function imageTool(
  name: string,
  description: string,
  inputSchema: Schema,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  if (name.startsWith(BUILT_IN_PREFIX)) {
    throw new ToolError("RESERVED_TOOL_NAME", `An image may not declare a tool named ${name}`);
  }
  return {
    name,
    description,
    inputSchema,
    // An image decides both the description and the command, and neither the
    // app nor the agent can tell a read from a write, so nothing is claimed
    // read-only here.
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute,
  };
}

export function registerTool(
  context: ModelContext,
  tool: ToolDefinition,
  signal: AbortSignal,
): Promise<void> | void {
  return context.registerTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
    annotations: tool.annotations,
    execute: async (args, options) => {
      try {
        validate(args, tool.inputSchema);
        return JSON.stringify({ ok: true, ...(await tool.execute(args, options?.signal)) });
      } catch (error) {
        return JSON.stringify({ ok: false, error: toolErrorOf(error) });
      }
    },
  }, { signal });
}

function toolErrorOf(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ToolError) return { code: error.code, message, ...error.details };
  const code = /no synchronous VFS surface|no writeFileToVfs/.test(message)
    ? "UNSUPPORTED_CAPABILITY"
    : /ENOENT/.test(message)
      ? "FILE_NOT_FOUND"
      : /Job capacity reached/.test(message)
        ? "LIMIT_EXCEEDED"
        : "OPERATION_FAILED";
  return { code, message };
}
