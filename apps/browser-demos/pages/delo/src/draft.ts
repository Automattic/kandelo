// A delo draft: the config of a computer that does not exist yet. `delo init`
// creates one, `add`, `remove`, `write`, `enable` and `disable` change it through the
// plans in packages.ts, and nothing boots until `delo run`. Every change
// returns a new draft, so the page holds the only copy and a reload of the
// page discards it.

import { deloPipelineName, type DeloOwnPipeline, type DeloPipeline } from "./registry";

export interface DeloDraft {
  name: string;
  /** The computer's own pipeline: its name and description, the binaries it
   *  uses, the options it enables, and a copy of the files of every pipeline
   *  added to it. */
  pipeline: DeloOwnPipeline;
  /** The installed binary that becomes the first process, or null when nothing runs. */
  firstProcess: string | null;
  /** The registered pipelines copied into `pipeline`, in the order they were
   *  added: a share link names them instead of carrying their files. */
  added: string[];
}

/** What a computer is made of, without its name. */
export type DeloConfiguration = Omit<DeloDraft, "name">;

export const EMPTY_DELO_PIPELINE: DeloPipeline = { use: [], enable: [], provide: [], need: [], device: [], files: [] };

export function createDeloDraft(name: string): DeloDraft {
  return { name, pipeline: { name: deloPipelineName(name), description: "", ...EMPTY_DELO_PIPELINE }, firstProcess: null, added: [] };
}
