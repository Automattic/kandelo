import {
  createProtectedCandidatePagesVfsPlacement,
  installProtectedCandidatePagesActivation,
  resolveCandidateOrDefaultOptionalVfsUrl,
  type CandidateOptionalDemoVfsImage,
  type ProtectedCandidateVfsSource,
} from "../../../pages/kandelo/kernel-host/candidate-evidence-vfs";

interface PlacementFixtureApi {
  pagesLoad: "eager" | "lazy" | null;
  activate(): Promise<number>;
  bytes(): Promise<number>;
  resolveOptional(image: CandidateOptionalDemoVfsImage): Promise<{
    fallbackCalls: number;
    url: string;
  }>;
}

declare global {
  interface Window {
    __KANDELO_ABI_STAGING_PAGES_PLACEMENT_SOURCE__?: ProtectedCandidateVfsSource;
    __KANDELO_ABI_STAGING_PAGES_PLACEMENT_FIXTURE__?: PlacementFixtureApi;
  }
}

const source = window.__KANDELO_ABI_STAGING_PAGES_PLACEMENT_SOURCE__;
if (source === undefined) {
  throw new Error("protected Pages placement fixture source is absent");
}
const placement = createProtectedCandidatePagesVfsPlacement(source);
installProtectedCandidatePagesActivation(window, placement, async () => {
  await placement.activate();
});
const api: PlacementFixtureApi = {
  pagesLoad: placement.pagesLoad,
  async activate(): Promise<number> {
    const activate = window.__KANDELO_ABI_STAGING_ACTIVATE_PAGES_PRODUCT__;
    if (activate === undefined) {
      throw new Error("protected Pages placement activation is absent");
    }
    await activate();
    return (await placement.bytes()).byteLength;
  },
  async bytes(): Promise<number> {
    return (await placement.bytes()).byteLength;
  },
  async resolveOptional(image): Promise<{ fallbackCalls: number; url: string }> {
    let fallbackCalls = 0;
    const url = await resolveCandidateOrDefaultOptionalVfsUrl(
      image,
      source,
      async () => {
        fallbackCalls += 1;
        return "/forbidden-default.vfs.zst";
      },
    );
    return { fallbackCalls, url };
  },
};
Object.defineProperty(window, "__KANDELO_ABI_STAGING_PAGES_PLACEMENT_FIXTURE__", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: api,
});
