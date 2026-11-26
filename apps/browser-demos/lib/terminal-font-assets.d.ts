declare module "virtual:kandelo-terminal-fonts" {
  export interface TerminalFontAsset {
    url: string;
    weight: string;
    clusterFallback?: boolean;
  }
  export const assets: readonly (TerminalFontAsset | null)[];
  /** Base64-encoded varint triples of gap, inclusive range length minus one, and subset index. */
  export const packedSpans: string;
}
