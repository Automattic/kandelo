import {
  genericDemoPresentation, resolveDemoAssets, resolveDemoDockActions, resolveDemoExchange,
  resolveDemoGuide, resolveDemoIdentity, resolveDemoInit, resolveDemoPresentation,
  resolveDemoRuntime, resolveDemoWeb, resolveDemoActivity, type KandeloDemoConfig,
} from "./demo-config";
import type { SessionLaunch } from "./package-sessions";

export interface ImageActivity {
  id: string;
  title: string;
  summary: string;
  command: string;
  launch: SessionLaunch;
  unavailable?: string;
}

export interface ImageActivityController {
  list(): Promise<ImageActivity[]>;
  prepare(id: string, progress: (message: string) => void, assertCurrent: () => void): Promise<ImageActivity>;
}

export function imageActivity(config: KandeloDemoConfig, id: string, bootProfileId: string): ImageActivity {
  if (!Object.hasOwn(config.profiles ?? {}, id)) throw new Error(`Unknown image activity: ${id}`);
  const identity = resolveDemoIdentity(config, id);
  const init = resolveDemoInit(config, id);
  const runtime = resolveDemoRuntime(config, id);
  const web = resolveDemoWeb(config, id);
  const declaredActivity = resolveDemoActivity(config, id);
  const display = runtime.features.includes("kms") ? "kms" : runtime.features.includes("framebuffer") ? "framebuffer" : undefined;
  const presentation = resolveDemoPresentation(config, id);
  const activity: ImageActivity = {
    id, title: identity?.title ?? id, summary: identity?.summary ?? "",
    command: declaredActivity?.shellCommand ?? (init !== null && "shellCommand" in init ? init.shellCommand : ":"),
    launch: { executable: "/bin/sh", args: [], cwd: "/", requires: [], surface: display ? "display" : "terminal",
      ...(display ? { display } : {}), ...(presentation?.displayScale === undefined ? {} : { displayScale: presentation.displayScale }) },
  };
  if (declaredActivity && web?.requiredPorts.length) {
    activity.launch = { surface: "web", host: "localhost", port: web.requiredPorts[0], path: "/" };
  } else if (!declaredActivity && init !== null && !("shellCommand" in init)) {
    if (id === bootProfileId && web?.requiredPorts.length) {
      activity.launch = { surface: "web", host: "localhost", port: web.requiredPorts[0], path: "/" };
    } else {
      activity.unavailable = "This declaration starts machine init, not an application. It needs a supervised runtime service definition; launching it will not reboot the computer.";
    }
  }
  return activity;
}

export function imageActivityPresentation(config: KandeloDemoConfig, id: string) {
  return {
    presentation: resolveDemoPresentation(config, id) ?? genericDemoPresentation(),
    guide: resolveDemoGuide(config, id), exchange: resolveDemoExchange(config, id),
    dockActions: resolveDemoDockActions(config, id), assets: resolveDemoAssets(config, id),
  };
}
