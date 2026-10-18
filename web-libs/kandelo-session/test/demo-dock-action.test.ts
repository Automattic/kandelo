import { describe, expect, it, vi } from "vitest";
import {
  parseKandeloDemoConfig,
  resolveDemoDockActions,
  validateKandeloDemoConfig,
  type DemoDockCommandConfig,
} from "../src/demo-config";
import {
  dockActionProgramName,
  dockActionProgress,
  runDemoDockAction,
  shellPromptReturned,
  type DockActionPhase,
} from "../src/demo-dock-action";
import type { KernelHost } from "../src/kernel-host";

const ACTION: DemoDockCommandConfig = {
  id: "play",
  label: "Play the bundled game",
  restart: "/usr/local/bin/play",
};

function config(dockActions: unknown) {
  const parsed = parseKandeloDemoConfig(JSON.stringify({
    version: 1,
    profiles: { machine: { dockActions } },
  }));
  if (parsed === null) throw new Error("fixture did not parse");
  return parsed;
}

describe("image-owned dock actions", () => {
  it("resolves declared actions in order", () => {
    const actions = [
      { ...ACTION, description: "Fetch it, then run it" },
      { id: "other", label: "Other", restart: "/usr/local/bin/other" },
    ];
    expect(resolveDemoDockActions(config(actions), "machine")).toEqual(actions);
  });

  it("resolves to no actions when a profile declares none", () => {
    const parsed = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: { machine: {} },
    }));
    expect(resolveDemoDockActions(parsed!, "machine")).toEqual([]);
  });

  it.each([
    ["not an array", { play: ACTION }, /must be an array/],
    ["missing restart", [{ id: "play", label: "Play" }], /restart/],
    ["empty label", [{ ...ACTION, label: "" }], /label/],
    ["duplicate ids", [ACTION, ACTION], /duplicate dock action id: play/],
    [
      "too many actions",
      Array.from({ length: 5 }, (_, i) => ({ ...ACTION, id: `a${i}` })),
      /at most 4/,
    ],
  ])("rejects %s when the image is validated", (_name, actions, message) => {
    expect(() => validateKandeloDemoConfig(config(actions))).toThrow(message);
  });

  it("resolves a menu action with runnable and unavailable entries", () => {
    const menu = {
      id: "games",
      label: "More games",
      menu: [
        { id: "a", label: "Game A", detail: "12 MB", restart: "/usr/local/bin/play a" },
        { id: "b", label: "Game B", unavailable: "needs a codec this build leaves out" },
      ],
    };
    expect(resolveDemoDockActions(config([ACTION, menu]), "machine")).toEqual([ACTION, menu]);
  });

  it.each([
    ["both restart and menu", [{ ...ACTION, menu: [{ id: "a", label: "A", restart: "x" }] }], /exactly one of restart or menu/],
    ["an empty menu", [{ id: "m", label: "M", menu: [] }], /non-empty array/],
    [
      "an entry with neither command nor reason",
      [{ id: "m", label: "M", menu: [{ id: "a", label: "A" }] }],
      /exactly one of restart or unavailable/,
    ],
    [
      "duplicate entry ids",
      [{ id: "m", label: "M", menu: [{ id: "a", label: "A", restart: "x" }, { id: "a", label: "B", restart: "y" }] }],
      /duplicate menu entry id: a/,
    ],
  ])("rejects a menu with %s", (_name, actions, message) => {
    expect(() => validateKandeloDemoConfig(config(actions))).toThrow(message);
  });

  it("rejects dockActions declared outside a profile", () => {
    const parsed = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      dockActions: [ACTION],
    }));
    expect(() => validateKandeloDemoConfig(parsed!)).toThrow(/top level/);
  });
});

describe("runDemoDockAction", () => {
  it("interrupts the foreground program before dispatching the restart", async () => {
    const calls: string[] = [];
    const host = {
      interruptShellForeground: vi.fn(async () => { calls.push("interrupt"); }),
      dispatchShellCommand: vi.fn(async (command: string) => { calls.push(command); }),
    } as unknown as KernelHost;
    const phases: DockActionPhase[] = [];

    await runDemoDockAction(host, ACTION, { onPhase: (p) => phases.push(p) });

    expect(calls).toEqual(["interrupt", "/usr/local/bin/play"]);
    expect(phases).toEqual(["stopping", "starting", "done"]);
  });

  it("does not dispatch when the foreground program never exits", async () => {
    const dispatchShellCommand = vi.fn(async () => {});
    const host = {
      interruptShellForeground: vi.fn(async () => {
        throw new Error("the foreground program did not exit");
      }),
      dispatchShellCommand,
    } as unknown as KernelHost;

    await expect(runDemoDockAction(host, ACTION)).rejects.toThrow(/did not exit/);
    expect(dispatchShellCommand).not.toHaveBeenCalled();
  });

  it("passes the stop timeout through to the interrupt", async () => {
    const interruptShellForeground = vi.fn(async () => {});
    const host = {
      interruptShellForeground,
      dispatchShellCommand: vi.fn(async () => {}),
    } as unknown as KernelHost;

    await runDemoDockAction(host, ACTION, { stopTimeoutMs: 1234 });

    expect(interruptShellForeground).toHaveBeenCalledWith({ timeoutMs: 1234 });
  });
});

describe("dock action progress", () => {
  const name = dockActionProgramName("/usr/local/bin/fetch-game --fast");

  it("names the program by the basename of the command's first word", () => {
    expect(name).toBe("fetch-game");
  });

  it("reports the program's latest status line and curl's percentage", () => {
    const output = "/usr/local/bin/fetch-game\r\n"
      + "fetch-game: Downloading the game...\r\n"
      + "#####                  7.5%\r##########          21.0%";
    expect(dockActionProgress(output, name)).toEqual({
      status: "Downloading the game...",
      percent: 21,
    });
  });

  it("drops the percentage when the next step starts", () => {
    const output = "fetch-game: Downloading...\r\n###### 100.0%\r\n"
      + "fetch-game: Verifying the download...\r\n";
    expect(dockActionProgress(output, name)).toEqual({
      status: "Verifying the download...",
      percent: null,
    });
  });

  it("ignores other programs' output and terminal escapes", () => {
    const output = "fetch-game: Starting...\r\n"
      + "\x1b[33mWARNING: joystick support missing\x1b[0m\r\n";
    expect(dockActionProgress(output, name)).toEqual({
      status: "Starting...",
      percent: null,
    });
  });

  it("detects the shell prompt returning after the command exits", () => {
    expect(shellPromptReturned("fetch-game: Download failed\r\nkandelo$ ")).toBe(true);
    expect(shellPromptReturned("fetch-game: Downloading...\r\n")).toBe(false);
  });

  it("does not mistake curl's progress bar for a root prompt", () => {
    expect(shellPromptReturned("fetch-game: Downloading...\r\n\r####      # ")).toBe(false);
    expect(shellPromptReturned("fetch-game: Downloading...\r\n######## ")).toBe(false);
    expect(shellPromptReturned("done\r\nroot@kandelo:/# ")).toBe(true);
  });
});
