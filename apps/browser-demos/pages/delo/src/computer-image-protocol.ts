// Messages between the delo page and its image builder worker. Everything is
// plain structured-cloneable data: the page holds only the finished bytes.

import type { ComputerDisk, ComputerImagePlan } from "./computer-image";

export interface ComputerImageRequest {
  plan: ComputerImagePlan;
  /** The URL of every source the plan's files read, of every lazy archive it lists, and of every lazy file it sizes. */
  sources: Record<string, string>;
  /** The computer's current disk, which the plan is written onto, or null for an empty disk. */
  base: ComputerDisk<Uint8Array<ArrayBuffer>> | null;
}

export type ComputerImageMessage =
  | { type: "done"; disk: ComputerDisk<Uint8Array<ArrayBuffer>> }
  | { type: "error"; message: string };
