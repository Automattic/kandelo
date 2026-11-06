import { parseShortcutConfig, type DemoGuideConfig } from "./demo-config";

export interface ComputerService {
  id: string;
  title: string;
  port: number;
  shortcuts?: DemoGuideConfig;
}

export type ComputerServiceState = "running" | "starting" | "stopping" | "stopped" | "failed" | "skipped" | "not-loaded" | "unknown";
export type ComputerServiceAction = "start" | "stop" | "enable" | "disable";
export interface ComputerServiceStatus extends ComputerService {
  state: ComputerServiceState;
  enabled: boolean;
}

export interface ComputerServiceController {
  list(): Promise<ComputerServiceStatus[]>;
  change(action: ComputerServiceAction, id: string): Promise<void>;
}

export const COMPUTER_SERVICES_PATH = "/etc/kandelo/services.json";
export const MAX_COMPUTER_SERVICES_BYTES = 65_536;

export class ServiceSupervisorStartingError extends Error {
  constructor() { super("The service supervisor is still starting"); this.name = "ServiceSupervisorStartingError"; }
}

export function previewServiceNotice(services: readonly ComputerServiceStatus[], destination: { hostname: string; port: number } | undefined): string | null {
  if (!destination || !["localhost", "127.0.0.1"].includes(destination.hostname)) return null;
  const matching = services.filter(service => service.port === destination.port);
  if (matching.some(service => ["running", "starting", "stopping", "unknown"].includes(service.state))) return null;
  if (matching.some(service => service.state === "failed")) return "Service failed · Last loaded page";
  return matching.some(service => service.state === "stopped") ? "Service stopped · Last loaded page" : null;
}

export function parseComputerServices(text: string): ComputerService[] {
  if (new TextEncoder().encode(text).byteLength > MAX_COMPUTER_SERVICES_BYTES) throw new Error("Service declarations exceed 65536 bytes");
  const value = JSON.parse(text);
  if (!value || value.version !== 1 || !Array.isArray(value.services) || value.services.length > 64) throw new Error("Unsupported computer service declarations");
  for (const key of Object.keys(value)) if (!["version", "services"].includes(key)) throw new Error(`Unsupported service catalog field: ${key}`);
  const seen = new Set<string>();
  return value.services.map((service: unknown) => {
    if (!service || typeof service !== "object") throw new Error("Invalid computer service");
    const entry = service as Record<string, unknown>;
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) || seen.has(entry.id)) throw new Error("Invalid or duplicate service identifier");
    if (typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > 120) throw new Error("Invalid service title");
    if (typeof entry.port !== "number" || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) throw new Error("Invalid service port");
    for (const key of Object.keys(entry)) if (!["id", "title", "port", "shortcuts"].includes(key)) throw new Error(`Unsupported service field: ${key}`);
    seen.add(entry.id);
    return { id: entry.id, title: entry.title, port: entry.port, ...(entry.shortcuts === undefined ? {} : { shortcuts: parseShortcutConfig(entry.shortcuts) }) };
  });
}

export function parseComputerServiceStatus(text: string, services: readonly ComputerService[]): ComputerServiceStatus[] {
  if (text.length > 16_384) throw new Error("Service status exceeds its display limit");
  const [header, ...lines] = text.trimEnd().split("\n");
  if (header !== "KANDELO_SERVICES\t1") throw new Error("Unsupported service status format");
  const states = new Set(["running", "starting", "stopping", "stopped", "failed", "skipped", "not-loaded", "unknown"]);
  const found = new Map<string, { state: ComputerServiceState; enabled: boolean }>();
  for (const line of lines) {
    const [id, state, enabled, extra] = line.split("\t");
    if (!id || !state || !states.has(state) || !["enabled", "disabled"].includes(enabled ?? "") || extra !== undefined || found.has(id) || !services.some(service => service.id === id)) throw new Error("Invalid service status record");
    found.set(id, { state: state as ComputerServiceState, enabled: enabled === "enabled" });
  }
  return services.map(service => {
    const status = found.get(service.id);
    if (!status) throw new Error(`Missing service status: ${service.id}`);
    return { ...service, ...status };
  });
}

export function runningServiceShortcuts(services: readonly ComputerServiceStatus[]): ComputerServiceStatus[] {
  return services.filter(service => service.state === "running" && service.shortcuts &&
    (service.shortcuts.groups?.some(group => group.actions.length > 0) || service.shortcuts.script || service.shortcuts.companion));
}
