// The one way a machine is put into a #k1= link.
//
// The Share dialog and a machine's "Save state" control both describe the
// running machine to a later visitor: the same image, plus whatever boot
// inputs and parameters put it back where it was. They must produce the same
// descriptor for the same content, so both build it here.

import type { CheckpointLinkContent } from "./demo-checkpoint";
import type { BootDescriptor, BootInput } from "./kernel-host";

/** The boot-input id and filename a link's script travels under. */
export const LINK_SCRIPT_INPUT_ID = "script";
export const LINK_SCRIPT_FILENAME = "kandelo-link.sh";

export interface ShareLinkParts {
  /** A checkpoint and the content it belongs to. */
  checkpoint?: CheckpointLinkContent;
  /** An inline script input, run by bash once the machine is up. */
  script?: BootInput;
}

/**
 * The descriptor a link carries: `base`'s machine, booting with the given
 * parts. Returns null when there is nothing to carry, so the link is just the
 * page's own URL.
 */
export function composeShareDescriptor(
  base: BootDescriptor,
  parts: ShareLinkParts,
): BootDescriptor | null {
  const checkpointInputs = parts.checkpoint?.inputs ?? [];
  const checkpointParameters = parts.checkpoint?.parameters;
  if (!parts.script && checkpointInputs.length === 0) return null;
  return {
    ...base,
    boot: {
      // BOOT IDENTITY COMES FROM THE IMAGE: argv/cwd/env carried here
      // would just be the CURRENT machine's, which the opener's boot
      // ignores (with a visible log line) in favour of its own image's
      // init. This placeholder only satisfies validateBootDescriptor's
      // non-empty-argv/cwd/env schema requirement; every Kandelo
      // browser image can run this default interactive login session,
      // so it is truthful even though it is never actually launched.
      argv: ["bash", "-l", "-i"],
      cwd: "/",
      env: {},
      inputs: [...checkpointInputs, ...(parts.script ? [parts.script] : [])],
      // Record the shell that should run the script so the opener's
      // machine executes it directly (`<shell> script`) with no visible
      // `command -v bash` probe. Every Kandelo browser image provides
      // bash as its default shell, and the opener boots the same image
      // this link carries, so the choice is a property of the link.
      ...(parts.script || checkpointParameters
        ? {
          parameters: {
            ...(checkpointParameters ?? {}),
            ...(parts.script
              ? { runScript: parts.script.id, runScriptShell: "bash" }
              : {}),
          },
        }
        : {}),
    },
  };
}
