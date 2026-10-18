import type { BootDescriptor, GalleryItem } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { encodeBootDescriptor, HARD_CAPS } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import { createInlineBootInput } from "../../../../../web-libs/kandelo-session/src/boot-inputs";
import { descriptorFromGalleryItem } from "../gallery-descriptor";
import { ToolError } from "./contract";

const encoder = new TextEncoder();

type LaunchLink = {
  url: string;
  sizeBytes: number;
  reproduces: string;
};

/**
 * Encode a boot configuration into a shareable URL fragment. A named profile
 * drops the current computer's inputs and parameters, so the link reproduces
 * that profile rather than this session's boot.
 */
export async function buildLaunchLink(
  current: BootDescriptor,
  item: GalleryItem | undefined,
  itemUrl: string,
  startupScript: string | undefined,
): Promise<LaunchLink> {
  let descriptor = item ? descriptorFromGalleryItem(item, current) : current;
  if (item) descriptor = { ...descriptor, boot: { ...descriptor.boot, inputs: undefined, parameters: undefined } };
  if (startupScript !== undefined) descriptor = await withStartupScript(descriptor, startupScript);
  const url = new URL(itemUrl);
  url.hash = (await encodeBootDescriptor(descriptor)).fragment;
  return {
    url: url.href,
    sizeBytes: encoder.encode(url.href).length,
    reproduces: "Boot configuration and encoded startup inputs only; no modified files, processes or terminal state.",
  };
}

async function withStartupScript(descriptor: BootDescriptor, script: string): Promise<BootDescriptor> {
  const bytes = encoder.encode(script.endsWith("\n") ? script : `${script}\n`);
  if (bytes.length > HARD_CAPS.maxInlineInflatedInputBytes) {
    throw new ToolError("LIMIT_EXCEEDED", "Startup script exceeds inline inflated input limit");
  }
  const input = await createInlineBootInput({ id: "script", filename: "kandelo-link.sh", bytes, compression: "gzip" });
  return {
    ...descriptor,
    boot: { ...descriptor.boot, inputs: [input], parameters: { runScript: "script", runScriptShell: "bash" } },
  };
}
