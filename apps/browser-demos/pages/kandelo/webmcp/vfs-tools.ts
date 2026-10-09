// Tool definitions live in two directories: /etc/mcp ships with the image and
// /home/maker/mcp belongs to the maker; on a name clash the maker's file wins.
// One JSON file per tool, named after the tool: `{ description, inputSchema,
// command }`. The command is typed into the machine's visible shell; it may
// carry `{param}` placeholders filled from the call arguments.

export const VFS_TOOLS_DIRS = ["/etc/mcp", "/home/maker/mcp"];

export interface VfsTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  command: string;
}

const TOOL_NAME = /^[a-z][a-z0-9_-]*$/;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function vfsToolName(fileName: string): string | null {
  if (!fileName.endsWith(".json")) return null;
  const name = fileName.slice(0, -".json".length);
  return TOOL_NAME.test(name) ? name : null;
}

export function parseVfsTool(file: string, text: string): VfsTool {
  const name = vfsToolName(file.slice(file.lastIndexOf("/") + 1));
  if (!name) throw new Error(`${file} is not named after a tool`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new Error(`${file} must hold a JSON object`);
  const { description, inputSchema, command } = raw;
  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`${file} needs a non-empty "description" string`);
  }
  if (!isRecord(inputSchema)) throw new Error(`${file} needs an "inputSchema" object`);
  if (typeof command !== "string" || command.length === 0) {
    throw new Error(`${file} needs a non-empty "command" string`);
  }
  return { name, description, inputSchema, command };
}

export function substituteCommand(command: string, args: Record<string, unknown>): string {
  return command.replace(PLACEHOLDER, (match, key: string) => {
    if (!Object.hasOwn(args, key)) return match;
    const value = args[key];
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
