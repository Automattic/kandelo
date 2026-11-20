// The view a typed `delo write <path> <computer>` opens when the line gives
// the file no source: one pane per option of the file's type, with Save and
// Cancel below the panel. Another type shows its own options. Save hands the
// options to the page, which writes the file into the computer's pipeline;
// Cancel, the close button and Escape write nothing. The view builds the
// DOM; the page decides what saving means.

import { element, renderDeloView } from "./view";
import { DELO_EDITOR_KEYS, DELO_WRITE_FLAGS, type DeloEditorFields } from "./write";

interface DeloEditorSubject {
  path: string;
  fields: DeloEditorFields;
}

interface DeloEditorHandlers {
  /** Write the file the options describe into the pipeline; a rejection stays in the view. */
  save: (fields: DeloEditorFields) => Promise<void>;
  close: () => void;
}

type Option = keyof DeloEditorFields;

const action = (text: string) => {
  const button = element("button", "delo-files-action", text);
  button.type = "button";
  return button;
};

const menu = (values: Record<string, string>, value: string, label: string) => {
  const node = element("select", "delo-config-input delo-editor-menu");
  node.append(...Object.entries(values).map(([key, text]) => {
    const item = element("option", "", text);
    item.value = key;
    return item;
  }));
  node.value = value;
  node.setAttribute("aria-label", label);
  return node;
};

const line = (value: string, label: string, placeholder: string) => {
  const node = element("input", "delo-config-input");
  node.value = value;
  node.placeholder = placeholder;
  node.autocomplete = "off";
  node.spellcheck = false;
  node.setAttribute("aria-label", label);
  return node;
};

export function renderDeloEditor(view: HTMLElement, subject: DeloEditorSubject, handlers: DeloEditorHandlers): void {
  const { path, fields } = subject;
  const problem = element("p", "delo-config-problem");
  problem.setAttribute("role", "alert");
  const save = action("save");
  const cancel = action("cancel");

  const input = (option: Option): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement => {
    const label = `the ${option} of ${path}`;
    if (option === "type") return menu({ file: "file", directory: "directory", symlink: "symlink" }, fields.type, label);
    if (option === "lazy") {
      const box = element("input", "delo-editor-check");
      box.type = "checkbox";
      box.checked = fields.lazy;
      box.setAttribute("aria-label", label);
      return box;
    }
    if (option === "content") {
      const text = element("textarea", "delo-config-input delo-editor-text");
      text.value = fields.content;
      text.spellcheck = false;
      text.setAttribute("aria-label", label);
      return text;
    }
    const text = line(fields[option], label, { from: "/etc/bar", mode: fields.type === "directory" ? "755" : "644", owner: "0:0" }[option]);
    if (option === "from") text.classList.add("delo-editor-wide");
    return text;
  };

  const pane = (option: Option) => {
    const control = input(option);
    control.addEventListener(option === "type" ? "change" : "input", () => {
      if (control instanceof HTMLInputElement && control.type === "checkbox") fields.lazy = control.checked;
      else Object.assign(fields, { [option]: control.value });
      if (option === "type") render("type");
    });
    const node = element("section", option === "content" ? "" : "delo-editor-option");
    node.append(control, element("p", "delo-view-note", option === "type" ? "file, directory or symlink" : DELO_WRITE_FLAGS[option]));
    return { label: option, node, onShow: () => node.append(problem) };
  };

  const render = (shown: Option) => {
    renderDeloView(view, {
      title: path,
      panes: (["type", ...DELO_EDITOR_KEYS[fields.type]] as Option[]).map(pane),
      shown,
      named: true,
      aside: [],
      actions: [save, cancel],
      close: handlers.close,
    });
    view.querySelector<HTMLElement>(".delo-view-tab[aria-current=page]")!.focus();
  };

  cancel.addEventListener("click", handlers.close);
  save.addEventListener("click", () => {
    save.disabled = true;
    problem.textContent = "";
    handlers.save(fields).catch((err: unknown) => {
      problem.textContent = err instanceof Error ? err.message : String(err);
      save.disabled = false;
    });
  });
  render(fields.type === "file" ? "content" : "type");
}
