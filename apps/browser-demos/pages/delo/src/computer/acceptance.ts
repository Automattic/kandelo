// The dialog where the visitor accepts a WebMCP tool the first time an agent
// calls it in this page session: an untrusted tool file, or a device tool
// that sends input to the computer. The dialog shows what the call would
// run, one call at a time; Accept lets this call and the later ones with the
// same key run, Refuse and Escape refuse this call only. A computer with the
// `mcp` option accepts every tool without a dialog. Nothing is remembered
// past the page.

interface AcceptRequest {
  tool: string;
  rows: [string, string][];
}

export interface Acceptance {
  /** Whether the tool with `key` runs without asking. */
  accepted(key: string): boolean;
  /** Ask the visitor, unless the tool with `key` runs without asking; true on Accept. */
  accept(key: string, request: AcceptRequest): Promise<boolean>;
}

const part = <T extends Element>(dialog: HTMLDialogElement, selector: string, type: new () => T): T => {
  const found = dialog.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`The acceptance dialog is missing ${selector}.`);
  return found;
};

export function wireAcceptance(dialog: HTMLDialogElement, all: boolean): Acceptance {
  const tool = part(dialog, ".delo-accept-tool", HTMLElement);
  const rows = part(dialog, ".delo-accept-rows", HTMLDListElement);
  const yes = part(dialog, ".delo-accept-yes", HTMLButtonElement);
  const no = part(dialog, ".delo-accept-no", HTMLButtonElement);
  const keys = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const ask = (request: AcceptRequest) => new Promise<boolean>((resolve) => {
    tool.textContent = request.tool;
    rows.replaceChildren(...request.rows.flatMap(([key, value]) => {
      const term = document.createElement("dt");
      term.textContent = key;
      const detail = document.createElement("dd");
      detail.textContent = value;
      return [term, detail];
    }));
    const settle = (answer: boolean) => {
      dialog.close();
      resolve(answer);
    };
    yes.onclick = () => settle(true);
    no.onclick = () => settle(false);
    dialog.oncancel = (event) => {
      event.preventDefault();
      settle(false);
    };
    dialog.showModal();
    no.focus();
  });
  const accepted = (key: string) => all || keys.has(key);
  return {
    accepted,
    accept: (key, request) => {
      const answer = queue.then(async () => {
        if (accepted(key)) return true;
        const given = await ask(request);
        if (given) keys.add(key);
        return given;
      });
      queue = answer.catch(() => {});
      return answer;
    },
  };
}
