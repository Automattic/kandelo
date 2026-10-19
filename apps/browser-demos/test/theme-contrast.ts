import type { Page } from "@playwright/test";

export async function contrast(page: Page) {
  return page.locator("[data-contrast]").evaluateAll((nodes) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const luminance = (rgb: Uint8ClampedArray) => [...rgb].slice(0, 3)
      .map((v) => v / 255)
      .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    // Check both ends of every gradient; a good midpoint must not hide an
    // unreadable edge. Browser canvas resolves color-mix/oklch into sRGB.
    const backgrounds = (style: CSSStyleDeclaration) => {
      if (style.backgroundImage === "none") return [style.backgroundColor];
      const parts = style.backgroundImage.slice(style.backgroundImage.indexOf("(") + 1, -1)
        .split(/,(?![^()]*\))/);
      return parts.slice(1).map((part) => part.trim().replace(/\s+[\d.]+%$/, ""));
    };
    return nodes.map((node) => {
      const ancestors: CSSStyleDeclaration[] = [];
      for (let n: Element | null = node; n; n = n.parentElement) {
        ancestors.unshift(getComputedStyle(n));
      }
      let layers: string[][] = [[]];
      for (const style of ancestors) {
        layers = layers.flatMap((layer) => backgrounds(style).map((bg) => [...layer, bg]));
      }
      const ratios = layers.map((layer) => {
        ctx.globalAlpha = 1;
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, 1, 1);
        for (const bg of layer) {
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, 1, 1);
        }
        const bg = luminance(ctx.getImageData(0, 0, 1, 1).data);
        ctx.globalAlpha = ancestors.reduce((a, style) => a * Number(style.opacity), 1);
        ctx.fillStyle = getComputedStyle(node).color;
        ctx.fillRect(0, 0, 1, 1);
        const fg = luminance(ctx.getImageData(0, 0, 1, 1).data);
        return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
      });
      return { name: node.getAttribute("data-contrast"), ratio: Math.min(...ratios) };
    });
  });
}
