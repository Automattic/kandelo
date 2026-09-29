import * as React from "react";

/** `canvasOrRef` is a ref to a canvas the pane renders, or the element
 *  itself when the pane mounts one it does not own (the KMS display
 *  canvas) — passing the element re-runs the fit when it arrives. */
export function useFittedCanvasStyle(
  containerRef: React.RefObject<HTMLElement | null>,
  canvasOrRef: React.RefObject<HTMLCanvasElement | null> | HTMLCanvasElement | null,
  fallbackAspect: number,
): React.CSSProperties {
  const [style, setStyle] = React.useState<React.CSSProperties>({});

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const canvas = canvasOrRef && "current" in canvasOrRef
      ? canvasOrRef.current
      : canvasOrRef;
    if (!container || !canvas) return;

    const update = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const aspect = canvasAspect(canvas, fallbackAspect);
      const containerAspect = rect.width / rect.height;
      const width = containerAspect > aspect ? rect.height * aspect : rect.width;
      const height = width / aspect;
      const nextWidth = Math.max(1, Math.floor(width));
      const nextHeight = Math.max(1, Math.floor(height));

      setStyle((current) => {
        if (current.width === `${nextWidth}px` && current.height === `${nextHeight}px`) {
          return current;
        }
        return {
          width: `${nextWidth}px`,
          height: `${nextHeight}px`,
        };
      });
    };

    update();
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(container);
    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(canvas, {
      attributes: true,
      attributeFilter: ["width", "height"],
    });
    window.addEventListener("resize", update);
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [canvasOrRef, containerRef, fallbackAspect]);

  return style;
}

function canvasAspect(canvas: HTMLCanvasElement, fallbackAspect: number): number {
  const width = canvas.width;
  const height = canvas.height;
  if (width > 0 && height > 0 && !(width === 300 && height === 150)) {
    return width / height;
  }
  return fallbackAspect;
}
