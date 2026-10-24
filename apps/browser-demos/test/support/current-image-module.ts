import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext } from "@playwright/test";

const repository = resolve(import.meta.dirname, "../../../..");

export async function routeCurrentImageModules(context: BrowserContext): Promise<void> {
  const modules = new Map([
    ["kandelo_image_module32.wasm", readFileSync(resolve(repository, "local-binaries/kandelo_image_module32.wasm"))],
    ["kandelo_image_module_positioned32.wasm", readFileSync(resolve(repository, "local-binaries/kandelo_image_module_positioned32.wasm"))],
  ]);
  await context.route("**/*kandelo_image_module*wasm*", route => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    const url = new URL(route.request().url());
    if (url.searchParams.has("import") || url.searchParams.has("url")) return route.continue();
    const filename = url.pathname.split("/").at(-1)!;
    const bytes = modules.get(filename);
    return bytes === undefined ? route.continue() : route.fulfill({ body: bytes });
  });
}
