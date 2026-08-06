export type HomebrewBottleArch = "wasm32" | "wasm64";

export interface HomebrewLinkEntry {
  type: "symlink" | "directory" | "file";
  source: string;
  target: string;
  mode?: string;
}
