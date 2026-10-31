import { expect, it, vi } from "vitest";
import type { BrowserContext, Route } from "@playwright/test";
import { routeCurrentImageModules } from "../../apps/browser-demos/test/support/current-image-module";

vi.mock("node:fs", () => ({ readFileSync: (path: string) =>
  Buffer.from(path.includes("positioned") ? [2, 3, 4] : [1, 2, 3]) }));

async function request(url: string, type = "fetch") {
  let handler: ((route: Route) => unknown) | undefined;
  const context = { route: vi.fn((_pattern: string, callback: typeof handler) => { handler = callback; }) };
  await routeCurrentImageModules(context as unknown as BrowserContext);
  expect(context.route).toHaveBeenCalledOnce();
  const route = { request: () => ({ url: () => url, resourceType: () => type }),
    continue: vi.fn(), fulfill: vi.fn() };
  await handler!(route as unknown as Route);
  return route;
}

it.each(["import", "url", "import&url"])("does not fulfill a JavaScript asset wrapper reported as fetch (%s)", async query => {
  const route = await request(`http://127.0.0.1/kandelo_image_module32.wasm?${query}`);
  expect(route.continue).toHaveBeenCalledOnce();
  expect(route.fulfill).not.toHaveBeenCalled();
});

it.each(["", "?v=current"])("fulfills the actual positioned Wasm fetch (%s)", async query => {
  const route = await request(`http://127.0.0.1/kandelo_image_module_positioned32.wasm${query}`);
  expect(route.fulfill).toHaveBeenCalledWith({ body: Buffer.from([2, 3, 4]) });
  expect(route.continue).not.toHaveBeenCalled();
});

it("fulfills the resident Wasm fetch without replacing unrelated files or scripts", async () => {
  const resident = await request("http://127.0.0.1/kandelo_image_module32.wasm");
  expect(resident.fulfill).toHaveBeenCalledWith({ body: Buffer.from([1, 2, 3]) });
  for (const [url, type] of [["http://127.0.0.1/other_kandelo_image_module.wasm", "fetch"],
    ["http://127.0.0.1/kandelo_image_module32.wasm", "script"]]) {
    const route = await request(url, type);
    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.fulfill).not.toHaveBeenCalled();
  }
});
