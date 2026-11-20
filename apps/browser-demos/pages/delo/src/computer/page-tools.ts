// The WebMCP tools of a delo computer page itself, beside the tools of its
// devices (see webmcp.ts): `delo_page`, which does what the link back to delo
// does, and the tools of the options the computer's record enables, each on
// the same switch, link or session as the option's own tool in the toolbar.
// They stay registered for the life of the page. A tool that changes
// something waits for the visitor's acceptance on its first call (see
// acceptance.ts); a tool that only reads does not. Results and errors use
// Kandelo's WebMCP envelope (see docs/webmcp.md).

import { ToolError, type Schema } from "../../../kandelo/webmcp/contract";
import { modelContextOf } from "../../../kandelo/webmcp/model-context";
import { objectSchema, registerTool } from "../../../kandelo/webmcp/registry";
import type { KernelHost } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import type { Acceptance } from "./acceptance";
import type { DeloNetwork, DeloNetworkState } from "./network";

/** What the page tools reach of the computer page; an option the record does not enable is null. */
export interface DeloPageHandles {
  host: KernelHost;
  /** Halt the computer, which writes its disk, then open the delo page. */
  back(): Promise<void>;
  network: DeloNetwork | null;
  share: string | null;
  sound: ((on: boolean) => void) | null;
}

type Args = Record<string, unknown>;

type DeloPageOption = "network" | "internals" | "share" | "sound";

interface DeloPageTool {
  name: string;
  /** The option the tool belongs to, or null for a tool every computer page has. */
  option: DeloPageOption | null;
  description: string;
  readOnly: boolean;
  inputSchema: Schema;
  run(handles: DeloPageHandles, args: Args): Promise<Record<string, unknown>>;
}

const running = (host: KernelHost) => {
  if (host.getStatus() !== "running") throw new ToolError("NOT_READY", "The computer is not running.");
};

const network = ({ network }: DeloPageHandles) => network!;

/** A session that ended on an error is the tool's error. */
const session = (state: DeloNetworkState) => {
  if (state.phase === "error") throw new ToolError("OPERATION_FAILED", state.error ?? "The network session failed.");
  return state;
};

/** Every page tool, in registration order. */
const DELO_PAGE_TOOLS: DeloPageTool[] = [
  {
    name: "delo_page",
    option: null,
    description: "Go back to the delo page, as the toolbar's link back to delo does: a running computer halts first, which writes its disk. The delo page then registers its delo_* tools again, to change this computer and run it again.",
    readOnly: false,
    inputSchema: objectSchema({}, []),
    run: async ({ back }) => {
      try {
        await back();
      } catch (error) {
        throw new ToolError("OPERATION_FAILED", `The computer did not halt, so the page stays: ${error instanceof Error ? error.message : String(error)}`);
      }
      return {};
    },
  },
  {
    name: "option_network_read",
    option: "network",
    description: "Read the computer's network session: its phase (offline, hosting, joining, connected or error), the delo session link another computer joins with, this computer's address, and the members.",
    readOnly: true,
    inputSchema: objectSchema({}, []),
    run: async (handles) => network(handles).read(),
  },
  {
    name: "option_network_create",
    option: "network",
    description: "Create a network session on this running computer, as the network panel's Create does, and return it once it is connected, with the link another computer joins with. The computer's address shows in option_network_read once the session reports it.",
    readOnly: false,
    inputSchema: objectSchema({}, []),
    run: async (handles) => {
      running(handles.host);
      return session(await network(handles).create());
    },
  },
  {
    name: "option_network_join",
    option: "network",
    description: "Join the network session a link names, as the network panel's Join does, and return the session once this running computer is in it.",
    readOnly: false,
    inputSchema: objectSchema({ link: { type: "string", description: "A network session link, such as the link option_network_create returns on another computer.", maxLength: 65536 } }, ["link"]),
    run: async (handles, args) => {
      running(handles.host);
      let joined: Promise<DeloNetworkState>;
      try {
        joined = network(handles).join(args.link as string);
      } catch (error) {
        throw new ToolError("INVALID_ARGUMENT", error instanceof Error ? error.message : String(error));
      }
      return session(await joined);
    },
  },
  {
    name: "option_network_leave",
    option: "network",
    description: "Leave the computer's network session, as the network panel's Leave does.",
    readOnly: false,
    inputSchema: objectSchema({}, []),
    run: (handles) => network(handles).leave(),
  },
  {
    name: "option_internals_read",
    option: "internals",
    description: "Read the computer's process table, as the internals panel shows it: pid, ppid, user, state and command of each process.",
    readOnly: true,
    inputSchema: objectSchema({}, []),
    run: async ({ host }) => {
      running(host);
      const processes = await host.enumProcs();
      return { processes: processes.map(({ pid, ppid, user, state, cmdline }) => ({ pid, ppid, user, state, command: cmdline })) };
    },
  },
  {
    name: "option_share_read",
    option: "share",
    description: "Read the computer's share link, as the share panel shows it: a link that opens a new computer with this computer's configuration.",
    readOnly: true,
    inputSchema: objectSchema({}, []),
    run: async ({ share }) => ({ link: share }),
  },
  {
    name: "option_sound_set",
    option: "sound",
    description: "Turn the computer's sound on or off, as the sound tool does. The browser plays sound only after the visitor's first click or key press on the page.",
    readOnly: false,
    inputSchema: objectSchema({ on: { type: "boolean", description: "true: the computer's sound plays; false: it is muted." } }, ["on"]),
    run: async ({ host, sound }, args) => {
      sound!(args.on as boolean);
      return { on: args.on, audio: host.getAudioState() };
    },
  },
];

export function deloPageTools(options: readonly string[]): DeloPageTool[] {
  return DELO_PAGE_TOOLS.filter((tool) => tool.option === null || options.includes(tool.option));
}

/** Register the page tools of `options` for the life of the page. */
export function wirePageTools(handles: DeloPageHandles, options: readonly string[], acceptance: Acceptance): void {
  const context = modelContextOf(document);
  if (context === null) return;
  const { signal } = new AbortController();
  for (const tool of deloPageTools(options)) {
    const definition = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.readOnly, untrustedContentHint: true },
      execute: async (args: Args) => {
        if (!tool.readOnly && !await acceptance.accept(tool.name, { tool: tool.name, rows: [["description", tool.description]] })) {
          throw new ToolError("PERMISSION_DENIED", `The user refused ${tool.name}.`);
        }
        return tool.run(handles, args);
      },
    };
    void Promise.resolve(registerTool(context, definition, signal)).catch((error) => console.error(`WebMCP: registering ${tool.name} failed`, error));
  }
}
