import { describe, expect, it } from "vitest";
import { imageActivity, imageActivityPresentation } from "../src/image-activities";
import { validateKandeloDemoConfig, type KandeloDemoConfig } from "../src/demo-config";

const config: KandeloDemoConfig = { version: 1, profiles: {
  shell: { identity: { title: "Shell", summary: "Workspace", accent: "#123456", glyph: "sh" } },
  graphics: { identity: { title: "Graphics", summary: "Application", accent: "#123456", glyph: "G" }, init: { shellCommand: "/usr/bin/demo --normal" }, runtime: { features: ["kms", "evdev-input"] } },
  framebuffer: { init: { shellCommand: "/usr/bin/framebuffer" }, runtime: { features: ["framebuffer"] } },
  service: { init: { target: "web" }, web: { requiredPorts: [8080], probeHttp: true } },
  init: { init: { program: "/usr/bin/server", args: [], uid: 0, gid: 0 } },
} };

describe("image activities", () => {
  it("uses declared commands without reboot or constructor changes", () => {
    expect(imageActivity(config, "graphics", "shell")).toMatchObject({ command: "/usr/bin/demo --normal", launch: { surface: "display", display: "kms" } });
    expect(imageActivity(config, "framebuffer", "shell")).toMatchObject({ launch: { surface: "display", display: "framebuffer" } });
  });
  it("opens a workspace when the image declares no application command", () => {
    expect(imageActivity(config, "shell", "shell")).toMatchObject({ command: ":", launch: { surface: "terminal" } });
  });
  it("opens an already-running web service instead of relaunching init", () => {
    expect(imageActivity(config, "service", "service")).toMatchObject({ launch: { surface: "web", host: "localhost", port: 8080 } });
    expect(imageActivity(config, "service", "service").unavailable).toBeUndefined();
  });
  it("does not turn init-only definitions into reboot or elevated process requests", () => {
    expect(imageActivity(config, "service", "shell").unavailable).toContain("supervised runtime service");
    expect(imageActivity(config, "init", "shell").unavailable).toContain("supervised runtime service");
  });
  it("rejects unknown or inherited identifiers", () => {
    expect(() => imageActivity(config, "missing", "shell")).toThrow("Unknown image activity");
    expect(() => imageActivity(config, "toString", "shell")).toThrow("Unknown image activity");
  });
  it("keeps workspace presentation separate from its launch command", () => {
    expect(imageActivityPresentation(config, "shell").presentation.runningPrimary).toContain("terminal");
  });
  it("uses explicit service activity commands independently from machine init", () => {
    const declared: KandeloDemoConfig = { version: 1, image: { title: "Web Stack" }, profiles: { web: {
      init: { program: "/sbin/kandelo-init", args: ["web-php"], uid: 0, gid: 0 },
      activity: { shellCommand: "/usr/local/bin/kandelo-service start web-php" },
      web: { requiredPorts: [8080] },
    } } };
    validateKandeloDemoConfig(declared);
    expect(imageActivity(declared, "web", "other")).toMatchObject({ command: "/usr/local/bin/kandelo-service start web-php", launch: { surface: "web", host: "localhost", port: 8080 } });
    expect(imageActivity(declared, "web", "other").unavailable).toBeUndefined();
  });
  it.each([{}, { shellCommand: "bad\0command" }, { shellCommand: "x".repeat(4097) }, { shellCommand: ":", uid: 0 }])("rejects malformed activity declarations %j", activity => {
    expect(() => validateKandeloDemoConfig({ version: 1, profiles: { web: { activity } } } as KandeloDemoConfig)).toThrow();
  });
});
