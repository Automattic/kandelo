/**
 * Service descriptor parser for the browser demo init system.
 *
 * Each service is described by a file in /etc/init.d/ with an INI-like
 * key=value format. The filename encodes sort order and service name:
 * "20-nginx" → order=20, name="nginx".
 */

export type ReadyCondition =
  | { kind: "port"; port: number }
  | { kind: "delay"; ms: number }
  | { kind: "exit" }
  | { kind: "stdin-consumed" };

export interface ServiceDescriptor {
  name: string;
  order: number;
  type: "daemon" | "oneshot" | "interactive";
  command: string[];
  env?: string[];
  cwd?: string;
  ready?: ReadyCondition;
  depends?: string[];
  bridge?: number;
  pty?: boolean;
  stdin?: string;
  terminate?: boolean;
}

/**
 * Parse a filename like "20-nginx" into { order, name }.
 * If there is no numeric prefix, order defaults to 50 and name is the
 * full filename.
 */
function parseFilename(filename: string): { order: number; name: string } {
  const match = filename.match(/^(\d+)-(.+)$/);
  if (match) {
    return { order: parseInt(match[1], 10), name: match[2] };
  }
  return { order: 50, name: filename };
}

/**
 * Parse a ready condition string.
 *
 *   port:8080  → { kind: "port", port: 8080 }
 *   delay:500  → { kind: "delay", ms: 500 }
 *   exit       → { kind: "exit" }
 *   stdin-consumed → { kind: "stdin-consumed" }
 */
function parseReady(value: string): ReadyCondition {
  if (value === "exit") {
    return { kind: "exit" };
  }
  if (value === "stdin-consumed") {
    return { kind: "stdin-consumed" };
  }
  const portMatch = value.match(/^port:(\d+)$/);
  if (portMatch) {
    return { kind: "port", port: parseInt(portMatch[1], 10) };
  }
  const delayMatch = value.match(/^delay:(\d+)$/);
  if (delayMatch) {
    return { kind: "delay", ms: parseInt(delayMatch[1], 10) };
  }
  throw new Error(`Unknown ready condition: ${value}`);
}

/**
 * Split a command string into argv, respecting double-quoted segments.
 *
 * "nginx -c \"/etc/nginx/nginx.conf\"" → ["nginx", "-c", "/etc/nginx/nginx.conf"]
 */
function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === " " && !inQuotes) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

/**
 * Parse a service descriptor file into a ServiceDescriptor.
 *
 * @param filename — The basename of the file (e.g. "20-nginx")
 * @param content  — The file contents (INI-like key=value lines)
 */
export function parseServiceDescriptor(
  filename: string,
  content: string,
): ServiceDescriptor {
  const { order, name } = parseFilename(filename);

  const descriptor: ServiceDescriptor = {
    name,
    order,
    type: "daemon",
    command: [],
  };

  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip blank lines and comments
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      continue; // Malformed line — skip silently
    }

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();

    switch (key) {
      case "type":
        if (
          value === "daemon" ||
          value === "oneshot" ||
          value === "interactive"
        ) {
          descriptor.type = value;
        } else {
          throw new Error(`Unknown service type: ${value}`);
        }
        break;

      case "command":
        descriptor.command = splitCommand(value);
        break;

      case "env":
        descriptor.env = value.split(/\s+/).filter((s) => s.length > 0);
        break;

      case "cwd":
        descriptor.cwd = value;
        break;

      case "ready":
        descriptor.ready = parseReady(value);
        break;

      case "depends":
        if (value === "none") {
          // Explicit "no dependencies" — don't set depends
        } else {
          descriptor.depends = value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
        break;

      case "bridge":
        descriptor.bridge = parseInt(value, 10);
        break;

      case "pty":
        descriptor.pty = value === "true";
        break;

      case "stdin":
        descriptor.stdin = value;
        break;

      case "terminate":
        descriptor.terminate = value === "true";
        break;

      // Unknown keys are silently ignored for forward compatibility
    }
  }

  if (descriptor.command.length === 0) {
    throw new Error(
      `Service descriptor "${filename}" is missing a command field`,
    );
  }

  return descriptor;
}
