// The page of one delo computer: it boots the computer that its URL names,
// `?computer=<id>` for a stored computer or `?vfs=<image>&profile=<id>` for a
// registered image, and shows it. The boot is Kandelo's own; everything on
// this page is Delo's. The toolbar lists the devices of the packages on the
// computer's disk (see devices.ts) and the tools of the options enabled in its
// record on the host. A registered image has no record, and neither has a
// computer whose record is lost, so it has no option tool. The tools an
// agent calls follow the record too: a tool file is trusted when the
// record's pipeline writes it, and the `mcp` option accepts every tool.

import { BrowserComputerStore } from "../../../../../../web-libs/kandelo-session/src/browser-computer-store";
import type { KernelHost, MachineProgress, MachineStatus } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import { createLiveHost } from "../../../kandelo/kernel-host/live-setup";
import { COMPUTER_QUERY_PARAM, PROFILE_QUERY_PARAM, VFS_IMAGE_QUERY_PARAM } from "../../../kandelo/url-state";
import { readDeloComputerRecord, type DeloComputerRecord } from "../computer-record";
import { EMPTY_DELO_PIPELINE } from "../draft";
import { deloComputerName } from "../name";
import { deloEnabledOptions, deloInstalled } from "../packages";
import { parseDeloRegistry } from "../registry";
import registrySource from "../registry.json?raw";
import { wireAcceptance } from "./acceptance";
import { wireAudio } from "./audio";
import { DELO_DEVICES, deloDevicesOf, deloShownDevice, imageDevicesOf, type DeloDevice } from "./devices";
import { wireDownload } from "./download";
import { openFramebuffer } from "./framebuffer";
import { wireInternals } from "./internals";
import { openKms } from "./kms";
import { wireNetwork } from "./network";
import { wirePageTools, type DeloPageHandles } from "./page-tools";
import { closePanel } from "./panel";
import { wireShare } from "./share";
import { openTerminal, type OpenTerminal } from "./terminal";
import { DELO_THEME_LABEL, nextDeloTheme, readDeloTheme, writeDeloTheme, type DeloTheme } from "./theme";
import { wireToolFiles } from "./tool-files";
import { officialToolTexts, trustedToolTexts } from "./trust";
import { wireToolbar } from "./toolbar";
import { wireUpload } from "./upload";
import { openWeb } from "./web";
import { wireWebMcp, type DeloSurfaces, type OpenDevice } from "./webmcp";

const element = <T extends HTMLElement>(id: string, type: new () => T): T => {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`The delo computer page is missing #${id}.`);
  return found;
};

const status = element("delo-status", HTMLOutputElement);
const fab = element("delo-fab", HTMLButtonElement);
const toolbar = element("delo-toolbar", HTMLDivElement);
const fold = element("delo-fold", HTMLButtonElement);
const back = element("delo-back", HTMLAnchorElement);
const themeOption = element("delo-option-theme", HTMLButtonElement);
const terminal = element("delo-terminal", HTMLDivElement);
const framebuffer = element("delo-framebuffer", HTMLCanvasElement);
const kms = element("delo-kms", HTMLDivElement);
const web = element("delo-web", HTMLDivElement);

const SURFACE: Record<DeloDevice, HTMLElement> = { terminal, framebuffer, kms, web };
const DEVICE_BUTTON = Object.fromEntries(DELO_DEVICES.map((device) => [device, element(`delo-device-${device}`, HTMLButtonElement)])) as Record<DeloDevice, HTMLButtonElement>;

const registry = parseDeloRegistry(registrySource);
let openedTerminal: OpenTerminal | null = null;

wireToolbar(fab, toolbar, fold, closePanel);

const applyTheme = (theme: DeloTheme) => {
  document.documentElement.dataset.deloTheme = theme;
  const label = `Theme: ${DELO_THEME_LABEL[theme]}`;
  themeOption.setAttribute("aria-label", label);
  themeOption.title = label;
  openedTerminal?.retheme();
};

const wireTheme = () => {
  let theme = readDeloTheme({ getItem: (key) => window.localStorage.getItem(key) });
  applyTheme(theme);
  themeOption.addEventListener("click", () => {
    theme = nextDeloTheme(theme);
    writeDeloTheme({ setItem: (key, value) => window.localStorage.setItem(key, value) }, theme);
    applyTheme(theme);
  });
};

const show = (text: string, error = false) => {
  status.textContent = text;
  status.classList.toggle("is-error", error);
  status.hidden = text === "";
};

const SYNTHETIC_INIT_PID = 1;

/** Kandelo reports a failed boot as two error lines in dmesg: which machine
 *  failed, then why. */
const failure = (host: KernelHost) => host.dmesgHistory().filter((line) => line.level === "err").slice(-2).map((line) => line.msg).join(" · ");

const describe = (machine: MachineStatus, progress: MachineProgress | null, processes: number | null, failed: string) => {
  if (progress?.status === "error") return progress.error ?? progress.label;
  if (machine === "error") return failed || "the computer stopped on an error";
  if (machine === "booting" || progress?.status === "loading") return progress?.label ?? "booting";
  if (machine === "halted") return "the computer is halted";
  if (machine === "running" && processes === 0) return "nothing is running";
  return "";
};

const watchStatus = (host: KernelHost) => {
  let processes: number | null = null;
  const render = () => {
    const machine = host.getStatus();
    const progress = host.getMachineProgress();
    show(describe(machine, progress, processes, machine === "error" ? failure(host) : ""), machine === "error" || progress?.status === "error");
  };
  const count = () => {
    host.enumProcs().then((procs) => {
      processes = procs.filter((proc) => proc.pid !== SYNTHETIC_INIT_PID).length;
      render();
    }, () => {
      processes = null;
      render();
    });
  };
  host.subscribeStatus(() => {
    render();
    count();
  });
  host.subscribeMachineProgress(render);
  host.subscribeProcessEvents(count);
  render();
};

/** Halt a running computer before the link back to delo leaves the page:
 *  the kernel's graceful destroy writes the cache to the disk, and leaving
 *  without it loses every write no program synced (kandelo-problems.md).
 *  A halt that fails keeps the page, with its error. Any other way out of a
 *  running computer asks with the browser's own dialog, whose text no page
 *  sets. Returns the way back, which delo_page takes too. */
const wireBack = (host: KernelHost): (() => Promise<void>) => {
  let leaving = false;
  window.addEventListener("beforeunload", (event) => {
    if (leaving || host.getStatus() !== "running") return;
    event.preventDefault();
    event.returnValue = true;
  });
  const leave = async () => {
    if (leaving) return;
    leaving = true;
    try {
      if (host.getStatus() === "running") await host.halt();
    } catch (error) {
      leaving = false;
      show(`the computer did not halt, so its unsynced writes are not on its disk: ${error instanceof Error ? error.message : String(error)}`, true);
      throw error;
    }
    window.location.assign(back.href);
  };
  back.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (host.getStatus() !== "running" && !leaving) return;
    event.preventDefault();
    leave().catch(() => {});
  });
  return leave;
};

/** Show the devices the toolbar lists and the surface `deloShownDevice`
 *  picks, until a click on a device shows its surface instead. A
 *  surface opens the first time it is shown, or the first time a WebMCP tool
 *  asks for it, and stays open. The terminal attaches once the host has a
 *  terminal session to attach to, shown or not, so its login shell starts
 *  what the computer runs. The display opens at boot, shown or not, so a
 *  compositor finds a screen and its size when it starts. Returns the
 *  opener the WebMCP tools use. */
const wireDevices = (host: KernelHost, devices: () => DeloDevice[], subscribe: (listener: () => void) => void): OpenDevice => {
  const opened = new Map<DeloDevice, DeloSurfaces[DeloDevice]>();
  const open: { [D in DeloDevice]: () => DeloSurfaces[D] | null } = {
    terminal: () => {
      if (!host.getSurfaceAvailability().terminal) return null;
      openedTerminal = openTerminal(host, terminal);
      return openedTerminal;
    },
    framebuffer: () => host.getStatus() === "running" ? openFramebuffer(host, framebuffer) : null,
    kms: () => host.getStatus() === "booting" || host.getStatus() === "running" ? openKms(host, kms) : null,
    web: () => {
      const frame = web.querySelector("iframe");
      const message = web.querySelector(".delo-web-message");
      if (!(frame instanceof HTMLIFrameElement) || !(message instanceof HTMLElement)) throw new Error("The web surface is missing its frame.");
      return openWeb(host, frame, message);
    },
  };
  const ensure: OpenDevice = <D extends DeloDevice>(device: D) => {
    const found = (opened.get(device) ?? open[device]()) as DeloSurfaces[D] | null;
    if (found !== null) opened.set(device, found);
    return found;
  };
  let picked: DeloDevice | null = null;
  const render = () => {
    const listed = devices();
    const selected = picked !== null && listed.includes(picked) ? picked : deloShownDevice(listed, host.getSurfaceAvailability());
    for (const device of DELO_DEVICES) {
      const shown = device === selected;
      DEVICE_BUTTON[device].hidden = !listed.includes(device);
      DEVICE_BUTTON[device].setAttribute("aria-pressed", String(shown));
      SURFACE[device].hidden = !shown;
    }
    for (const device of listed) {
      if (device !== selected && device !== "kms" && device !== "terminal") continue;
      try {
        ensure(device);
      } catch (error) {
        show(error instanceof Error ? error.message : String(error), true);
      }
    }
  };
  for (const device of DELO_DEVICES) {
    DEVICE_BUTTON[device].addEventListener("click", () => {
      picked = device;
      render();
      opened.get(device)?.focus();
    });
  }
  host.subscribeStatus(render);
  host.subscribeSurfaceAvailability(render);
  subscribe(render);
  render();
  return ensure;
};

/** Wire the tools of the options `record` enables, and return the handles the page tools share with them. */
const wireOptions = (host: KernelHost, title: string, record: DeloComputerRecord): Pick<DeloPageHandles, "network" | "share"> => {
  const options = deloEnabledOptions(registry, record.disk);
  const button = (option: string) => {
    const found = element(`delo-option-${option}`, HTMLButtonElement);
    found.hidden = false;
    return found;
  };
  const draft = { name: title, ...record.disk };
  const share = options.includes("share") ? wireShare(button("share"), element("delo-share", HTMLElement), registry, draft) : null;
  const network = options.includes("network") ? wireNetwork(host, button("network"), element("delo-network", HTMLElement), registry, draft) : null;
  if (options.includes("upload")) wireUpload(host, button("upload"), element("delo-upload", HTMLElement));
  if (options.includes("download")) wireDownload(host, button("download"), element("delo-download", HTMLElement));
  if (options.includes("internals")) wireInternals(host, button("internals"), element("delo-internals", HTMLElement));
  return { network, share };
};

const boot = async () => {
  const query = new URLSearchParams(window.location.search);
  const computerId = query.get(COMPUTER_QUERY_PARAM);
  const title = computerId === null
    ? query.get(PROFILE_QUERY_PARAM) ?? query.get(VFS_IMAGE_QUERY_PARAM) ?? ""
    : deloComputerName((await new BrowserComputerStore().list()).find((computer) => computer.id === computerId)?.title ?? computerId);
  const record = computerId === null ? null : await readDeloComputerRecord(computerId);
  if (record !== null && deloEnabledOptions(registry, record.disk).includes("theme")) {
    wireTheme();
    themeOption.hidden = false;
  }
  const host = await createLiveHost({
    managedComputers: true,
    computerId,
    vfsUrl: query.get(VFS_IMAGE_QUERY_PARAM),
    profile: query.get(PROFILE_QUERY_PARAM),
  });
  watchStatus(host);
  const leave = wireBack(host);
  const options = record === null ? [] : deloEnabledOptions(registry, record.disk);
  const sound = options.includes("sound") ? element("delo-option-sound", HTMLButtonElement) : null;
  if (sound !== null) sound.hidden = false;
  const setSound = wireAudio(host, sound, (message) => show(message, true));
  const acceptance = wireAcceptance(element("delo-accept", HTMLDialogElement), options.includes("mcp"));
  wireToolFiles(host, { official: officialToolTexts(registry), trusted: trustedToolTexts(record?.disk.pipeline ?? EMPTY_DELO_PIPELINE), acceptance, computer: title });
  const handles = { host, back: leave, sound: sound === null ? null : setSound };
  if (record === null) {
    const devices = () => imageDevicesOf(host.getPresentation());
    const subscribe = (listener: () => void) => host.subscribePresentation(listener);
    wireWebMcp(host, devices, subscribe, wireDevices(host, devices, subscribe), acceptance);
    wirePageTools({ ...handles, network: null, share: null }, options, acceptance);
    return;
  }
  const devices = () => deloDevicesOf([...deloInstalled(registry, record.disk), record.disk.pipeline]);
  wireWebMcp(host, devices, () => {}, wireDevices(host, devices, () => {}), acceptance);
  wirePageTools({ ...handles, ...wireOptions(host, title, record) }, options, acceptance);
};

show("preparing this computer");
boot().catch((error) => show(error instanceof Error ? error.message : String(error), true));
