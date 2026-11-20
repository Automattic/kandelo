// The devices of a delo computer: the surfaces its toolbar lists. A computer
// Delo made lists them from the properties of its installed binaries and of
// its own pipeline. A registered image has no packages in the registry, so it lists
// the one surface its own /etc/kandelo/demo.json prefers. Until the user picks
// a device, the computer shows the first listed one in priority order that the
// host has available.

import type { DemoPresentation } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import type { DeloPipeline } from "../registry";

export const DELO_DEVICES = ["terminal", "framebuffer", "kms", "web"] as const;

export type DeloDevice = typeof DELO_DEVICES[number];

const PRIORITY: readonly DeloDevice[] = ["kms", "web", "framebuffer", "terminal"];

/** The devices `installed` provide, in toolbar order: `terminal` for a
 *  package that provides `shell`, `framebuffer` for one that opens `fb0`, `kms`
 *  for one that opens `card0`, and `web` for one that provides `web`. */
export function deloDevicesOf(installed: readonly DeloPipeline[]): DeloDevice[] {
  const contracts = new Set(installed.flatMap((entry) => entry.provide));
  const devices = new Set(installed.flatMap((entry) => entry.device));
  const provided: Record<DeloDevice, boolean> = {
    terminal: contracts.has("shell"),
    framebuffer: devices.has("fb0"),
    kms: devices.has("card0"),
    web: contracts.has("web"),
  };
  return DELO_DEVICES.filter((device) => provided[device]);
}

/** The device a registered image's presentation prefers: the first of its
 *  surfaces that is a Delo device. */
export function imageDevicesOf(presentation: DemoPresentation): DeloDevice[] {
  return presentation.runningPrimary.filter((surface): surface is DeloDevice => (DELO_DEVICES as readonly string[]).includes(surface)).slice(0, 1);
}

/** The device the computer shows until the user picks one: the first of
 *  `listed` in priority order that is `available`, or the first in priority
 *  order while none is. The terminal only when it is the sole device. */
export function deloShownDevice(listed: readonly DeloDevice[], available: Readonly<Record<DeloDevice, boolean>>): DeloDevice | null {
  const candidates = PRIORITY.filter((device) => listed.includes(device) && (device !== "terminal" || listed.length === 1));
  return candidates.find((device) => available[device]) ?? candidates[0] ?? null;
}
