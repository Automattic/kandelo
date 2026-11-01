import type { BrowserKernel } from "@host/browser-kernel-host";
import { parseKandeloDemoConfig, resolveDemoInit, type KandeloDemoConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import { MAX_DINIT_SERVICE_CLOSURE, MAX_DINIT_SERVICE_FILE_BYTES, parseDinitBootTargets } from "../../../../../web-libs/kandelo-session/src/dinit-boot-targets";
import { parseExperimentalTerminalSession } from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import type { ComposeImageResult } from "./image-composer";

export type StoredComposition = Pick<
  ComposeImageResult,
  "imageConfig" | "profileId" | "terminalSession" | "requiredServices"
>;

export function parseStoredComposition(value: unknown, encode: (value: unknown) => string): StoredComposition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("experimental persistence base image composition is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    typeof record.profileId !== "string" || record.profileId.length > 128 ||
    !Array.isArray(record.requiredServices) ||
    record.requiredServices.length > 64 ||
    !record.requiredServices.every((service) => typeof service === "string" && service.length <= 4096)
  ) {
    throw new Error("experimental persistence base image composition is invalid");
  }
  try {
    const imageConfig = parseKandeloDemoConfig(encode(record.imageConfig));
    if (imageConfig === null) throw new Error("invalid demo config");
    const terminalSession = parseExperimentalTerminalSession(encode(record.terminalSession));
    return {
      imageConfig,
      profileId: record.profileId,
      terminalSession,
      requiredServices: record.requiredServices as string[],
    };
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ENOMEM") throw error;
    throw new Error("experimental persistence base image composition is invalid");
  }
}

export async function persistentImageServices(
  kernel: Pick<BrowserKernel, "readFileRangeFromVfs">,
  config: KandeloDemoConfig,
  profileId: string,
): Promise<string[]> {
  const init = resolveDemoInit(config, profileId);
  const pending = init !== null && "target" in init ? [init.target] : [];
  const seen = new Set<string>();
  const services: string[] = [];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    services.push(name);
    if (seen.size > MAX_DINIT_SERVICE_CLOSURE) {
      throw new Error(`persistent image dinit tree exceeds ${MAX_DINIT_SERVICE_CLOSURE} services`);
    }
    const bytes = await kernel.readFileRangeFromVfs(`/etc/dinit.d/${name}`, 0, MAX_DINIT_SERVICE_FILE_BYTES + 1);
    if (bytes === null) throw new Error(`persistent image dinit service is missing: ${name}`);
    for (const dependency of parseDinitBootTargets(bytes, name)) pending.push(dependency);
  }
  return services;
}
