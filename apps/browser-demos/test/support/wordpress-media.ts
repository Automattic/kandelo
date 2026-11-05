import { expect, type FrameLocator, type Page } from "@playwright/test";

export interface WordPressUpload { id: number; path: string; bytes: number[] }

export async function uploadWordPressPng(page: Page, frame: FrameLocator, prefix: string): Promise<WordPressUpload> {
  const nonce = await frame.locator("body").evaluate(() => {
    const settings = (window as Window & { wpApiSettings?: { nonce?: string } }).wpApiSettings;
    const inline = document.querySelector("#wp-api-fetch-js-after")?.textContent ?? "";
    const nonce = settings?.nonce ?? /"nonce":"([^"]+)"/.exec(inline)?.[1];
    if (!nonce) throw new Error("WordPress upload nonce missing");
    return nonce;
  });
  return page.evaluate(async ({ prefix, nonce }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const drawing = canvas.getContext("2d");
    if (!drawing) throw new Error("PNG fixture context missing");
    drawing.fillStyle = "#369ace";
    drawing.fillRect(0, 0, 2, 2);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      value => value ? resolve(value) : reject(new Error("PNG fixture encoding failed")), "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const response = await fetch(`${prefix}index.php?rest_route=/wp/v2/media`, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "image/png", "Content-Disposition": 'attachment; filename="software-update.png"', "X-WP-Nonce": nonce },
      body: bytes,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Upload failed ${response.status}: ${body.slice(0, 500)}`);
    const media = JSON.parse(body) as { id: number; source_url: string };
    if (!media.id || !media.source_url) throw new Error("Upload has no media identity");
    const path = new URL(media.source_url).pathname;
    if (!path.startsWith(prefix)) throw new Error("Upload escaped its computer preview");
    return { id: media.id, path: path.slice(prefix.length), bytes: Array.from(bytes) };
  }, { prefix, nonce });
}

export async function expectWordPressUpload(page: Page, prefix: string, upload: WordPressUpload): Promise<void> {
  const actual = await page.evaluate(async ({ prefix, upload }) => {
    const response = await fetch(`${prefix}${upload.path}`, { cache: "no-store" });
    const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
    const metadataResponse = await fetch(`${prefix}index.php?rest_route=/wp/v2/media/${upload.id}`, { cache: "no-store" });
    const metadata = await metadataResponse.json() as { id: number; source_url: string };
    return { status: response.status, bytes, metadataStatus: metadataResponse.status,
      id: metadata.id, path: new URL(metadata.source_url).pathname };
  }, { prefix, upload });
  expect(actual).toEqual({ status: 200, bytes: upload.bytes, metadataStatus: 200,
    id: upload.id, path: `${prefix}${upload.path}` });
}
