// The WebMCP tools of a delo computer's devices. While the computer runs,
// the page registers with the browser's `document.modelContext` the tools of
// the devices its toolbar lists. A tool calls the open surface of its device,
// so an agent sees what the user sees and its keys, clicks and text take the
// user's path. A call opens the surface when it is not open yet, and never
// changes the device the page shows. A tool that sends input to the
// computer waits for the visitor's acceptance on its first call (see
// acceptance.ts); a tool that only reads does not. Results and errors use
// Kandelo's WebMCP envelope (see docs/webmcp.md).

import { guestPath, ToolError, type Schema } from "../../../kandelo/webmcp/contract";
import { modelContextOf } from "../../../kandelo/webmcp/model-context";
import { objectSchema, registerTool } from "../../../kandelo/webmcp/registry";
import type { KernelHost } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import type { Acceptance } from "./acceptance";
import type { DeloDevice } from "./devices";
import type { OpenFramebuffer } from "./framebuffer";
import type { OpenKms } from "./kms";
import type { OpenTerminal } from "./terminal";
import type { OpenWeb } from "./web";

export interface DeloSurfaces {
  terminal: OpenTerminal;
  framebuffer: OpenFramebuffer;
  kms: OpenKms;
  web: OpenWeb;
}

/** The open surface of a device, opened on the first call; null while it cannot open. */
export type OpenDevice = <D extends DeloDevice>(device: D) => DeloSurfaces[D] | null;

type Args = Record<string, unknown>;

interface DeloDeviceTool {
  name: string;
  device: DeloDevice;
  description: string;
  readOnly: boolean;
  inputSchema: Schema;
  run(open: OpenDevice, args: Args): Promise<Record<string, unknown>>;
}

const CLICK_MS = 50;

const TEXT_LIMIT = 262144;

const BUTTONS: Record<string, number> = { left: 1, right: 2, middle: 4 };

const surface = <D extends DeloDevice>(open: OpenDevice, device: D): DeloSurfaces[D] => {
  const found = open(device);
  if (found === null) throw new ToolError("NOT_READY", `The ${device} of this computer is not ready.`);
  return found;
};

const png = async (canvas: HTMLCanvasElement) => {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob === null) throw new ToolError("OPERATION_FAILED", "The screen could not be encoded as PNG.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { mimeType: "image/png", width: canvas.width, height: canvas.height, data: btoa(binary) };
};

const keys = (codes: unknown, knows: (code: string) => boolean): string[] => {
  const list = codes as unknown[];
  if (list.length === 0 || list.length > 8) throw new ToolError("INVALID_ARGUMENT", "keys names one to eight keys.");
  for (const code of list) {
    if (typeof code !== "string" || !knows(code)) throw new ToolError("INVALID_ARGUMENT", `${String(code)} is not a key this device has. Name keys by their DOM code, such as KeyA, Enter or ArrowUp.`);
  }
  return list as string[];
};

const inside = (kms: OpenKms, args: Args) => {
  const size = kms.scanout();
  if (size === null) throw new ToolError("NOT_READY", "Nothing is shown on the display.");
  const x = args.x as number;
  const y = args.y as number;
  if (x >= size.width || y >= size.height) throw new ToolError("INVALID_ARGUMENT", `(${x}, ${y}) is outside the ${size.width}x${size.height} display.`);
  return { x, y };
};

const webPath = (path: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.split(/[?#]/)[0]);
  } catch {
    throw new ToolError("INVALID_ARGUMENT", "The path has a malformed URL encoding.");
  }
  guestPath(decoded);
  if (path.startsWith("//") || decoded.startsWith("//") || /[\\\x00-\x20]/.test(path) || /%25/i.test(path)) throw new ToolError("INVALID_ARGUMENT", "device_web_open takes a guest URL path, such as /index.html.");
  return path;
};

const keysSchema = (screen: string) => objectSchema({
  keys: { type: "array", description: `DOM key codes pressed together on the ${screen}, in order, such as ["ControlLeft", "KeyC"]. One to eight keys.` },
  holdMs: { type: "integer", description: "How long the keys stay down, in milliseconds; default 100.", minimum: 0, maximum: 10000 },
}, ["keys"]);

const point = { type: "integer", minimum: 0, maximum: 65535 };

const delta = { type: "integer", minimum: -4096, maximum: 4096 };

const button = { type: "string", enum: Object.keys(BUTTONS), description: "The button to click; default left." };

/** Every device tool, in registration order. Two devices give device_keyboard_press and the pointer tools; the first one the computer has wins. */
const DELO_DEVICE_TOOLS: DeloDeviceTool[] = [
  {
    name: "device_terminal_read",
    device: "terminal",
    description: "Read the text the delo computer's terminal shows now, one line per row.",
    readOnly: true,
    inputSchema: objectSchema({}, []),
    run: async (open) => ({ screen: surface(open, "terminal").screen() }),
  },
  {
    name: "device_terminal_type",
    device: "terminal",
    description: "Type text into the delo computer's terminal, as the user's keys do. Include \\n to press Enter. Returns delivery, not the command's result: read the terminal after.",
    readOnly: false,
    inputSchema: objectSchema({ text: { type: "string", description: "The literal text to type.", maxLength: 65536 } }, ["text"]),
    run: async (open, args) => {
      if (!surface(open, "terminal").type(args.text as string)) throw new ToolError("NOT_READY", "The terminal is not attached yet.");
      return { delivered: true };
    },
  },
  {
    name: "device_framebuffer_screenshot",
    device: "framebuffer",
    description: "Take a PNG of /dev/fb0 on the delo computer, at the framebuffer's own resolution. Returns base64 data.",
    readOnly: true,
    inputSchema: objectSchema({}, []),
    run: async (open) => {
      const screen = surface(open, "framebuffer").screen();
      if (screen === null) throw new ToolError("NOT_READY", "No process draws on /dev/fb0.");
      return png(screen);
    },
  },
  {
    name: "device_display_screenshot",
    device: "kms",
    description: "Take a PNG of the delo computer's KMS display. Returns base64 data and the scanout size, which pointer coordinates use.",
    readOnly: true,
    inputSchema: objectSchema({}, []),
    run: async (open) => {
      const kms = surface(open, "kms");
      const size = kms.scanout();
      if (size === null) throw new ToolError("NOT_READY", "Nothing is shown on the display.");
      return { ...await png(kms.screen()), scanout: size };
    },
  },
  {
    name: "device_keyboard_press",
    device: "kms",
    description: "Press keys on the delo computer's KMS display, as the user's keys do, then release them.",
    readOnly: false,
    inputSchema: keysSchema("display"),
    run: async (open, args) => {
      const kms = surface(open, "kms");
      await kms.press(keys(args.keys, kms.knows), (args.holdMs as number | undefined) ?? 100);
      return { pressed: args.keys };
    },
  },
  {
    name: "device_keyboard_press",
    device: "framebuffer",
    description: "Press keys on the delo computer's framebuffer, as the user's keys do, then release them. The process that draws on /dev/fb0 reads them.",
    readOnly: false,
    inputSchema: keysSchema("framebuffer"),
    run: async (open, args) => {
      const framebuffer = surface(open, "framebuffer");
      if (!await framebuffer.press(keys(args.keys, framebuffer.knows), (args.holdMs as number | undefined) ?? 100)) throw new ToolError("NOT_READY", "No process draws on /dev/fb0.");
      return { pressed: args.keys };
    },
  },
  {
    name: "device_pointer_move",
    device: "kms",
    description: "Move the pointer to a pixel of the delo computer's KMS display, in scanout coordinates from the top left.",
    readOnly: false,
    inputSchema: objectSchema({ x: { ...point, description: "Scanout column." }, y: { ...point, description: "Scanout row." } }, ["x", "y"]),
    run: async (open, args) => {
      const kms = surface(open, "kms");
      const at = inside(kms, args);
      kms.point(at.x, at.y, 0);
      return at;
    },
  },
  {
    name: "device_pointer_click",
    device: "kms",
    description: "Move the pointer to a pixel of the delo computer's KMS display and click a button there.",
    readOnly: false,
    inputSchema: objectSchema({
      x: { ...point, description: "Scanout column." },
      y: { ...point, description: "Scanout row." },
      button,
    }, ["x", "y"]),
    run: async (open, args) => {
      const kms = surface(open, "kms");
      const at = inside(kms, args);
      kms.point(at.x, at.y, 0);
      kms.point(at.x, at.y, BUTTONS[(args.button as string | undefined) ?? "left"]);
      await new Promise((resolve) => setTimeout(resolve, CLICK_MS));
      kms.point(at.x, at.y, 0);
      return at;
    },
  },
  {
    name: "device_pointer_move",
    device: "framebuffer",
    description: "Move the mouse of the delo computer's framebuffer by a number of pixels. The process that draws on /dev/fb0 reads the motion from /dev/input/mice and keeps its own cursor position: take a screenshot to see where it is.",
    readOnly: false,
    inputSchema: objectSchema({ dx: { ...delta, description: "Pixels to the right; negative moves left." }, dy: { ...delta, description: "Pixels down; negative moves up." } }, ["dx", "dy"]),
    run: async (open, args) => {
      if (!surface(open, "framebuffer").move(args.dx as number, args.dy as number, 0)) throw new ToolError("NOT_READY", "No process draws on /dev/fb0.");
      return { dx: args.dx, dy: args.dy };
    },
  },
  {
    name: "device_pointer_click",
    device: "framebuffer",
    description: "Click a mouse button on the delo computer's framebuffer, where the process that draws on /dev/fb0 has its cursor.",
    readOnly: false,
    inputSchema: objectSchema({ button }, []),
    run: async (open, args) => {
      const framebuffer = surface(open, "framebuffer");
      const pressed = (args.button as string | undefined) ?? "left";
      if (!framebuffer.move(0, 0, BUTTONS[pressed])) throw new ToolError("NOT_READY", "No process draws on /dev/fb0.");
      await new Promise((resolve) => setTimeout(resolve, CLICK_MS));
      framebuffer.move(0, 0, 0);
      return { button: pressed };
    },
  },
  {
    name: "device_web_open",
    device: "web",
    description: "Open a page the delo computer's web server serves, by its guest path such as /index.html?x=1. Returns the frame's URL, not proof the page loaded.",
    readOnly: false,
    inputSchema: objectSchema({ path: { type: "string", description: "Guest URL path starting with /.", maxLength: 4096 } }, ["path"]),
    run: async (open, args) => {
      const url = surface(open, "web").open(webPath(args.path as string));
      if (url === null) throw new ToolError("NOT_READY", "No web server is running.");
      return { url };
    },
  },
  {
    name: "device_web_read",
    device: "web",
    description: "Read the page the delo computer's web frame shows: its guest path, title, whether it has loaded, and its visible text.",
    readOnly: true,
    inputSchema: objectSchema({}, []),
    run: async (open) => {
      const page = surface(open, "web").read();
      if (page === null) throw new ToolError("NOT_READY", "No web server is running.");
      return { ...page, text: page.text.slice(0, TEXT_LIMIT), truncated: page.text.length > TEXT_LIMIT };
    },
  },
];

/** The tools of `devices`: each tool whose device the computer has, once per name. */
export function deloDeviceTools(devices: readonly DeloDevice[]): DeloDeviceTool[] {
  const tools = DELO_DEVICE_TOOLS.filter((tool) => devices.includes(tool.device));
  return tools.filter((tool, index) => tools.findIndex((other) => other.name === tool.name) === index);
}

/** Keep the registered tools equal to the tools of `devices()` while the computer runs, and none while it does not. */
export function wireWebMcp(host: KernelHost, devices: () => DeloDevice[], subscribe: (listener: () => void) => void, open: OpenDevice, acceptance: Acceptance): void {
  const context = modelContextOf(document);
  if (context === null) return;
  let controller = new AbortController();
  let registered = "";
  const sync = () => {
    const tools = host.getStatus() === "running" ? deloDeviceTools(devices()) : [];
    const key = tools.map((tool) => `${tool.name}:${tool.device}`).join(" ");
    if (key === registered) return;
    registered = key;
    controller.abort();
    controller = new AbortController();
    for (const tool of tools) {
      const definition = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly, untrustedContentHint: true },
        execute: async (args: Args) => {
          if (!tool.readOnly && !await acceptance.accept(tool.name, { tool: tool.name, rows: [["description", tool.description]] })) {
            throw new ToolError("PERMISSION_DENIED", `The user refused ${tool.name}.`);
          }
          return tool.run(open, args);
        },
      };
      void Promise.resolve(registerTool(context, definition, controller.signal)).catch((error) => console.error(`WebMCP: registering ${tool.name} failed`, error));
    }
  };
  host.subscribeStatus(sync);
  subscribe(sync);
  sync();
}
