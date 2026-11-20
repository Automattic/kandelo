// The files pane of `delo config <computer>`: the files of one computer's
// disk, one folder at a time, in the rows of `delo list`. The disk opens the
// first time the pane shows. A folder row opens the folder; any other row
// opens to its details. The right arrow does the same, except on `..`; the left arrow closes
// the details, or goes up to the parent folder, and from `/` to the sidebar.
// The up and down arrows move between the rows and through the sections of
// the open details; the left arrow goes from a section back to its row.
// The pane header holds the open folder; the view header says what the disk
// is doing. Below the panel, Download saves the open file, or the open
// folder as a zip when no file is open, and Upload picks files for the open
// folder. Files and folders dropped on the pane go to the open folder too, a
// folder with everything in it. Uploading over a file asks first (Y/N). A
// computer that boots an image has no Upload and says read-only left of
// Download. The pane builds the DOM; files-client.ts opens and closes the
// disk.

import type { DeloFilesDisk, DeloFilesWritableDisk } from "./files-client";
import { parentPath, type DeloFilesEntry, type DeloUpload } from "./files";
import { element, focusRow, icon } from "./view";

export interface DeloFilesPane {
  node: HTMLElement;
  status: HTMLElement;
  aside: HTMLElement[];
  actions: HTMLElement[];
  /** Open the disk, the first time. */
  open(): void;
  /** Wait for the disk to open, when it does, then close it, saving it when
   *  an upload changed it. */
  close(): Promise<void>;
}

const permissions = (mode: number) => [6, 3, 0].map((shift) => {
  const bits = (mode >> shift) & 7;
  return `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
}).join("");

const symbol = (entry: DeloFilesEntry) => ({ folder: "d", file: "-", symlink: "l", other: "?" })[entry.kind];

/** The names `/etc/passwd` or `/etc/group` give to ids: the first field by
 *  the third. */
const namesOf = (text: string) => new Map(text.split("\n").map((line) => line.split(":")).filter((fields) => fields.length > 2).map((fields) => [Number(fields[2]), fields[0]]));

const section = (label: string, content: (Node | string)[]) => {
  const box = element("div", "delo-list-box");
  box.append(...content);
  const node = element("section", "delo-list-section delo-list-stop");
  node.append(element("h3", "delo-list-label", label), box);
  node.tabIndex = -1;
  return node;
};

const save = (bytes: Uint8Array<ArrayBuffer>, name: string) => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
};

const action = (text: string) => {
  const button = element("button", "delo-files-action", text);
  button.type = "button";
  button.disabled = true;
  return button;
};

/** Every file under a dropped entry, with its path from the drop: a folder's
 *  name, then the path inside it. */
const filesOf = async (entry: FileSystemEntry, prefix = ""): Promise<{ path: string; file: File }[]> => {
  if (entry.isFile) return [{ path: `${prefix}${entry.name}`, file: await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)) }];
  if (!entry.isDirectory) return [];
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map((child) => filesOf(child, `${prefix}${entry.name}/`)))).flat();
};

export function deloFilesPane(name: string, writable: boolean, openDisk: (onState: (state: string) => void) => Promise<DeloFilesDisk | DeloFilesWritableDisk>): DeloFilesPane {
  const status = element("span", "delo-view-status");
  const path = element("span", "delo-files-path", "/");
  const download = action("download");
  const upload = action("upload");
  const picker = element("input", "");
  picker.type = "file";
  picker.multiple = true;
  picker.hidden = true;
  const message = element("p", "delo-view-note delo-files-message");
  const list = element("ul", "delo-list");
  const pane = element("section", "delo-files-pane");
  pane.append(message, list, picker);
  const buttons = writable ? [upload, download] : [download];

  let users = new Map<number, string>();
  let groups = new Map<number, string>();
  let folder = "/";
  let opened: DeloFilesEntry | null = null;
  const say = (text: string, error = false) => {
    message.textContent = text;
    message.classList.toggle("is-error", error);
  };
  const setState = (state: string, error = false) => {
    status.textContent = state;
    status.classList.toggle("is-error", error);
  };
  const owner = (id: number, names: Map<number, string>) => names.has(id) ? `${names.get(id)} (${id})` : String(id);

  const details = (entry: DeloFilesEntry) => [
    section("path", [entry.path]),
    section("type", [entry.lazy ? `${entry.kind} · not on the disk yet: the computer downloads it when a program reads it` : entry.kind]),
    section("size", [`${entry.size} bytes`]),
    section("mode", [`${symbol(entry)}${permissions(entry.mode)} · ${(entry.mode & 0o7777).toString(8).padStart(4, "0")}`]),
    section("owner", [`${owner(entry.uid, users)} · ${owner(entry.gid, groups)}`]),
    ...(entry.target === null ? [] : [section("points to", [entry.target])]),
  ];

  const row = (disk: DeloFilesDisk, entry: DeloFilesEntry, label = entry.name) => {
    const toggle = element("button", "delo-list-row");
    toggle.type = "button";
    toggle.append(element("span", "delo-list-name", entry.kind === "folder" ? `${label}/` : label), ...(entry.kind === "folder" ? [icon(label === ".." ? "parent" : "chevron")] : []));
    if (label !== "..") toggle.dataset.path = entry.path;
    toggle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      if (event.key === "ArrowRight" && label === "..") return;
      if (event.key === "ArrowRight" && entry.kind === "folder") return void show(disk, entry.path, null);
      if (event.key === "ArrowRight" && !expanded) return toggle.click();
      if (event.key === "ArrowRight") return;
      if (expanded) return toggle.click();
      if (folder === "/") return toggle.closest(".delo-view-panel")?.querySelector<HTMLElement>(".delo-view-tab[aria-current=page]")?.focus();
      void show(disk, parentPath(folder), folder);
    });
    const item = element("li", "delo-list-entry");
    item.append(toggle);
    if (entry.kind === "folder") {
      toggle.addEventListener("click", (event) => {
        const focus = label === ".." ? folder : null;
        void show(disk, entry.path, event.detail === 0 ? focus : undefined);
      });
      return item;
    }
    toggle.setAttribute("aria-expanded", "false");
    const box = element("div", "delo-list-details");
    box.hidden = true;
    box.append(...details(entry));
    item.append(box);
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      for (const other of list.querySelectorAll<HTMLElement>(".delo-list-row[aria-expanded]")) other.setAttribute("aria-expanded", "false");
      for (const other of list.querySelectorAll<HTMLElement>(".delo-list-details")) other.hidden = true;
      toggle.setAttribute("aria-expanded", String(expanded));
      box.hidden = !expanded;
      opened = expanded ? entry : null;
      if (expanded) (item.nextElementSibling ?? item).scrollIntoView({ block: "nearest" });
    });
    return item;
  };

  /** Show the folder `next`, then focus the row of the path `focus`, or its
   *  first entry when `focus` is null. A click by mouse moves no focus; Enter
   *  focuses like the arrows. */
  const show = async (disk: DeloFilesDisk, next: string, focus?: string | null) => {
    const entries = await disk.list(next).catch((err: unknown) => {
      say(err instanceof Error ? err.message : String(err), true);
      return null;
    });
    if (entries === null) return;
    folder = next;
    opened = null;
    path.textContent = next;
    const up: DeloFilesEntry = { name: "..", path: parentPath(next), kind: "folder", mode: 0, uid: 0, gid: 0, size: 0, lazy: false, target: null };
    list.replaceChildren(...(next === "/" ? [] : [row(disk, up, "..")]), ...entries.map((entry) => row(disk, entry)));
    say("");
    if (focus === undefined) return;
    const toggles = [...list.querySelectorAll<HTMLButtonElement>(".delo-list-row")];
    (toggles.find((toggle) => toggle.dataset.path === focus) ?? toggles.find((toggle) => toggle.dataset.path !== undefined) ?? toggles[0])?.focus();
  };

  const confirmReplace = (paths: string[]) => new Promise<boolean>((resolve) => {
    say(`replace ${paths.join(" ")} ? (Y/N)`);
    const listen = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key !== "y" && key !== "n" && key !== "escape") return;
      event.preventDefault();
      event.stopPropagation();
      window.removeEventListener("keydown", listen, { capture: true });
      resolve(key === "y");
    };
    window.addEventListener("keydown", listen, { capture: true });
  });

  list.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (event.key === "ArrowLeft" && target.classList.contains("delo-list-stop")) {
      event.preventDefault();
      focusRow(target.closest(".delo-list-entry")!.querySelector<HTMLElement>(".delo-list-row")!);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const stops = [...list.querySelectorAll<HTMLElement>(".delo-list-row, .delo-list-details:not([hidden]) .delo-list-stop")];
    const next = stops.indexOf(document.activeElement as HTMLElement) + (event.key === "ArrowDown" ? 1 : -1);
    focusRow(stops[Math.min(Math.max(next, 0), stops.length - 1)]);
  });

  const send = async (disk: DeloFilesWritableDisk, files: { path: string; file: File }[]) => {
    if (files.length === 0) return;
    const uploads: DeloUpload[] = await Promise.all(files.map(async ({ path, file }) => ({ path, bytes: new Uint8Array(await file.arrayBuffer()) })));
    const into = folder;
    const conflicts = await disk.conflicts(into, uploads.map((upload) => upload.path));
    if (conflicts.length > 0 && !await confirmReplace(conflicts)) {
      say("nothing uploaded");
      return;
    }
    await disk.upload(into, uploads);
    await show(disk, into);
    say(`${uploads.length} ${uploads.length === 1 ? "file" : "files"} uploaded into ${into}. delo saves the disk when the settings close.`);
  };

  /** Send the files `collect` finds, with every action off until they are in. */
  const sendAll = (disk: DeloFilesWritableDisk, collect: () => Promise<{ path: string; file: File }[]>) => {
    for (const each of buttons) each.disabled = true;
    collect()
      .then((files) => send(disk, files))
      .catch((err: unknown) => say(err instanceof Error ? err.message : String(err), true))
      .finally(() => { for (const each of buttons) each.disabled = false; });
  };

  const wireUpload = (disk: DeloFilesWritableDisk) => {
    upload.addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => {
      const files = [...(picker.files ?? [])].map((file) => ({ path: file.name, file }));
      picker.value = "";
      sendAll(disk, async () => files);
    });
    pane.addEventListener("dragover", (event) => {
      if (upload.disabled || !event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      pane.classList.add("is-dropping");
    });
    pane.addEventListener("dragleave", (event) => {
      if (!pane.contains(event.relatedTarget as Node | null)) pane.classList.remove("is-dropping");
    });
    pane.addEventListener("drop", (event) => {
      pane.classList.remove("is-dropping");
      if (upload.disabled) return;
      event.preventDefault();
      const entries = [...event.dataTransfer?.items ?? []].map((item) => item.webkitGetAsEntry()).filter((entry) => entry !== null);
      sendAll(disk, async () => (await Promise.all(entries.map((entry) => filesOf(entry)))).flat());
    });
  };

  /** Save the open file, or the open folder as a zip when no file is open. */
  const saveShown = async (disk: DeloFilesDisk) => {
    const named = folder === "/" ? name : folder;
    if (opened === null) return save(await disk.zip(folder), `${named.slice(named.lastIndexOf("/") + 1)}.zip`);
    if (opened.kind !== "file") throw new Error(`${opened.path} is ${opened.kind === "symlink" ? "a symlink" : "a special file"}: it has no bytes to download`);
    if (opened.lazy) throw new Error(`${opened.path} is not on the disk yet: it has no bytes to download`);
    save(await disk.read(opened.path), opened.name);
  };

  let ready: Promise<DeloFilesDisk | null> | null = null;

  return {
    node: pane,
    status,
    aside: [path],
    actions: writable ? buttons : [element("span", "delo-files-read-only", "read-only"), download],
    open: () => {
      ready ??= openDisk(setState).then(async (disk) => {
        const text = (file: string) => disk.read(file).then((bytes) => new TextDecoder().decode(bytes), () => "");
        [users, groups] = [namesOf(await text("/etc/passwd")), namesOf(await text("/etc/group"))];
        download.addEventListener("click", () => saveShown(disk).catch((err: unknown) => say(err instanceof Error ? err.message : String(err), true)));
        if ("upload" in disk) wireUpload(disk);
        for (const each of buttons) each.disabled = false;
        await show(disk, "/");
        return disk;
      }, (err: unknown) => {
        setState("error", true);
        say(err instanceof Error ? err.message : String(err), true);
        return null;
      });
    },
    close: async () => {
      const disk = await ready;
      if (disk !== null) await disk.close();
    },
  };
}
