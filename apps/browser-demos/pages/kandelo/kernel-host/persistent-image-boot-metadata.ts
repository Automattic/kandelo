import type { BrowserKernel } from "@host/browser-kernel-host";
import {
  KANDELO_DEMO_CONFIG_PATH,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  resolveDemoInit,
  validateKandeloDemoConfig,
  type KandeloDemoConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import { MAX_DINIT_SERVICE_CLOSURE, MAX_DINIT_SERVICE_FILE_BYTES, parseDinitBootTargets } from "../../../../../web-libs/kandelo-session/src/dinit-boot-targets";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
  MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES,
  parseExperimentalTerminalSession,
} from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import type { FixedPersistenceImageHandle } from "./fixed-persistence-image";

export async function assertPersistentImageBootMetadata(
  kernel: Pick<BrowserKernel, "readFileRangeFromVfs">,
  composition: FixedPersistenceImageHandle["composition"],
): Promise<void> {
  const configBytes = await kernel.readFileRangeFromVfs(KANDELO_DEMO_CONFIG_PATH, 0, MAX_KANDELO_DEMO_CONFIG_BYTES + 1);
  if (configBytes === null || configBytes.byteLength > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error("persistent image boot configuration changed after composition");
  }
  const config = parseKandeloDemoConfig(new TextDecoder("utf-8", { fatal: true }).decode(configBytes));
  if (config === null) throw new Error("persistent image boot configuration is unsupported");
  validateKandeloDemoConfig(config);
  if (JSON.stringify(config) !== JSON.stringify(composition.imageConfig)) {
    throw new Error("persistent image boot configuration changed after composition");
  }
  const sessionBytes = await kernel.readFileRangeFromVfs(EXPERIMENTAL_TERMINAL_SESSION_PATH, 0, MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES + 1);
  if (sessionBytes === null || sessionBytes.byteLength > MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES) {
    throw new Error("persistent image terminal session changed after composition");
  }
  const session = parseExperimentalTerminalSession(
    new TextDecoder("utf-8", { fatal: true }).decode(sessionBytes),
  );
  if (JSON.stringify(session) !== JSON.stringify(composition.terminalSession)) {
    throw new Error("persistent image terminal session changed after composition");
  }
  const services = await persistentImageServices(kernel, config, composition.profileId);
  if (JSON.stringify(services) !== JSON.stringify(composition.requiredServices)) {
    throw new Error("persistent image dinit service closure changed after composition");
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
