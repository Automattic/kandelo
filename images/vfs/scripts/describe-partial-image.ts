/**
 * Describe a built partial image from its own bytes: the selection its
 * metadata records, the demo config it bakes, and the shell activities it
 * kept and left out.
 *
 * `xtask partial-image` runs this after the image is built, so what the
 * browser and Node are told about the image comes from the artifact itself,
 * not from what the build was asked to do.
 *
 *   describe-partial-image.ts --image <file> --demo-out <demo.json> --report-out <report.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KandeloImageFs } from "../lib/kandelo-image-fs";
import {
  KANDELO_DEMO_CONFIG_PATH,
  parseKandeloDemoConfig,
  validateKandeloDemoConfig,
} from "../../../web-libs/kandelo-session/src/demo-config";
import { composeSourceRootfsDemoConfig } from "./build-source-rootfs-shell-image";
import {
  filterDemoConfigForSelection,
  partialShellSelection,
  type ExcludedProfile,
} from "./shell-selection";

const SHELL_DIR = fileURLToPath(new URL("../../../packages/registry/shell/", import.meta.url));

export interface PartialImageDescription {
  selection: string[];
  activities: string[];
  excluded: ExcludedProfile[];
  demoConfig: Uint8Array;
}

export function describePartialImage(image: Uint8Array): PartialImageDescription {
  const metadata = KandeloImageFs.readImageMetadata(image) as Record<string, unknown> | null;
  const recorded = (metadata?.partialSelection as { packages?: unknown } | undefined)?.packages;
  if (!Array.isArray(recorded) || recorded.some((name) => typeof name !== "string")) {
    throw new Error("image records no partial selection; it is not a partial image");
  }
  const selection = recorded as string[];
  const fs = KandeloImageFs.create();
  fs.loadImage(image);
  const demoConfig = fs.readFile(KANDELO_DEMO_CONFIG_PATH);
  const config = parseKandeloDemoConfig(new TextDecoder("utf-8", { fatal: true }).decode(demoConfig));
  if (config === null) throw new Error(`${KANDELO_DEMO_CONFIG_PATH} has an unsupported version`);
  validateKandeloDemoConfig(config);
  const activities = Object.keys(config.profiles ?? {});
  // The shell activities this selection could not carry. An image derived
  // from the shell bakes its own demo config, so this lists only shell
  // activities whose packages are missing, not every shell profile.
  const shellConfig = parseKandeloDemoConfig(new TextDecoder().decode(composeSourceRootfsDemoConfig(
    resolve(SHELL_DIR, "source-rootfs-shell-demo.json"),
    resolve(SHELL_DIR, "source-rootfs-shell-demo-profiles.json"),
  )))!;
  const { excluded } = filterDemoConfigForSelection(shellConfig, partialShellSelection(selection));
  return { selection, activities, excluded, demoConfig };
}

function parseArguments(argv: readonly string[]): { image: string; demoOut: string; reportOut: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--image", "--demo-out", "--report-out"].includes(flag ?? "") || !value || values.has(flag!)) {
      throw new Error("usage: describe-partial-image.ts --image <file> --demo-out <file> --report-out <file>");
    }
    values.set(flag!, value);
  }
  if (values.size !== 3) {
    throw new Error("usage: describe-partial-image.ts --image <file> --demo-out <file> --report-out <file>");
  }
  return { image: values.get("--image")!, demoOut: values.get("--demo-out")!, reportOut: values.get("--report-out")! };
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const description = describePartialImage(new Uint8Array(readFileSync(args.image)));
    writeFileSync(args.demoOut, description.demoConfig);
    writeFileSync(
      args.reportOut,
      `${JSON.stringify({
        selection: description.selection,
        included: description.activities,
        excluded: description.excluded,
      }, null, 2)}\n`,
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
