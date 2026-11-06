// Stats slot 9: the guest's pointer shape. 0 hides the host pointer; 1-34
// are `wp_cursor_shape_device_v1` shapes, whose names are CSS cursor names.
const CURSOR_SHAPES = [
  "none", "default", "context-menu", "help", "pointer", "progress", "wait", "cell",
  "crosshair", "text", "vertical-text", "alias", "copy", "move", "no-drop", "not-allowed",
  "grab", "grabbing", "e-resize", "n-resize", "ne-resize", "nw-resize", "s-resize",
  "se-resize", "sw-resize", "w-resize", "ew-resize", "ns-resize", "nesw-resize",
  "nwse-resize", "col-resize", "row-resize", "all-scroll", "zoom-in", "zoom-out",
];

export function cssCursor(shape: number): string {
  return CURSOR_SHAPES[shape] ?? "default";
}
