// Tool definitions live in two directories: /etc/mcp ships with the image and
// /home/maker/mcp belongs to the maker; on a name clash the maker's file wins.
// One JSON file per tool, named after the tool: `{ description, inputSchema,
// command }`. The command is typed into the machine's visible shell; it may
// carry `{param}` placeholders filled from the call arguments.

import type { Schema } from "./contract";

export const VFS_TOOLS_DIRS = ["/etc/mcp", "/home/maker/mcp"];

export interface VfsTool {
  name: string;
  description: string;
  inputSchema: Schema;
  command: string;
}

const TOOL_NAME = /^[a-z][a-z0-9_-]*$/;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Exactly the keywords `validate` in contract.ts enforces. A keyword it
// would ignore is refused here, so a tool never registers a promise its
// arguments are not checked against.
const SCHEMA_TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);
const SCHEMA_KEYS = new Set(["type", "description", "enum", "minimum", "maximum", "maxLength", "properties", "required", "additionalProperties"]);

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
  if (inputSchema.type !== "object") throw new Error(`${file} inputSchema must have "type": "object"`);
  validateToolSchema(inputSchema, `${file} inputSchema`);
  if (typeof command !== "string" || command.length === 0) {
    throw new Error(`${file} needs a non-empty "command" string`);
  }
  return { name, description, inputSchema: inputSchema as Schema, command };
}

/** Accept only what `validate` enforces; name the first keyword or value it would not. */
export function validateToolSchema(schema: Record<string, unknown>, where: string): void {
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) throw new Error(`${where} uses "${key}", which Kandelo does not enforce`);
  }
  const { type, description, enum: choices, minimum, maximum, maxLength, properties, required, additionalProperties } = schema;
  if (typeof type !== "string" || !SCHEMA_TYPES.has(type)) {
    throw new Error(`${where}.type must be one of ${[...SCHEMA_TYPES].join(", ")}`);
  }
  if (description !== undefined && typeof description !== "string") throw new Error(`${where}.description must be a string`);
  if (choices !== undefined && (type !== "string" || !Array.isArray(choices) || !choices.every(choice => typeof choice === "string"))) {
    throw new Error(`${where}.enum must be an array of strings on a string`);
  }
  for (const [key, bound] of [["minimum", minimum], ["maximum", maximum]] as const) {
    if (bound !== undefined && (type !== "integer" || typeof bound !== "number")) throw new Error(`${where}.${key} must be a number on an integer`);
  }
  if (maxLength !== undefined && (type !== "string" || typeof maxLength !== "number")) throw new Error(`${where}.maxLength must be a number on a string`);
  if (type !== "object") {
    for (const key of ["properties", "required", "additionalProperties"]) {
      if (schema[key] !== undefined) throw new Error(`${where}.${key} belongs on an object`);
    }
    return;
  }
  if (properties !== undefined && !isRecord(properties)) throw new Error(`${where}.properties must be an object`);
  const names = new Set(Object.keys(properties ?? {}));
  for (const [key, child] of Object.entries(properties ?? {})) {
    if (!isRecord(child)) throw new Error(`${where}.properties.${key} must be an object`);
    validateToolSchema(child, `${where}.properties.${key}`);
  }
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every(name => typeof name === "string" && names.has(name))) {
      throw new Error(`${where}.required must list names from properties`);
    }
  }
  if (additionalProperties === undefined || additionalProperties === false) return;
  if (!isRecord(additionalProperties)) throw new Error(`${where}.additionalProperties must be false or a schema`);
  validateToolSchema(additionalProperties, `${where}.additionalProperties`);
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
