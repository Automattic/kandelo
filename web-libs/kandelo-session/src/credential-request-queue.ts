// Credential questions waiting for the user, first come first asked.
//
// A `KernelHost` credential handler that a prompt UI can render from: `ask`
// is the handler (install it with `setCredentialRequestHandler`), and
// `subscribe` / `snapshot` fit React's `useSyncExternalStore`. Each
// question's promise settles exactly once: with the user's answer, or with
// deny when it is withdrawn (its signal aborts) or the queue is closed.

import type {
  CredentialRequest,
  CredentialRequestHandler,
} from "./kernel-host";

export interface PendingCredentialRequest {
  /** Unique per queue; a new id is a new question. */
  readonly id: number;
  readonly request: CredentialRequest;
}

interface OpenEntry extends PendingCredentialRequest {
  readonly settle: (allow: boolean) => void;
}

export class CredentialRequestQueue {
  #nextId = 1;
  #entries: OpenEntry[] = [];
  #snapshot: readonly PendingCredentialRequest[] = [];
  readonly #listeners = new Set<() => void>();

  readonly ask: CredentialRequestHandler = (request, { signal }) =>
    new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const id = this.#nextId++;
      const withdrawn = () => this.answer(id, false);
      signal.addEventListener("abort", withdrawn, { once: true });
      this.#entries.push({
        id,
        request,
        settle: (allow) => {
          signal.removeEventListener("abort", withdrawn);
          resolve(allow);
        },
      });
      this.#changed();
    });

  /** Answer question `id`. A question already settled is ignored. */
  answer(id: number, allow: boolean): void {
    const index = this.#entries.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const [entry] = this.#entries.splice(index, 1);
    this.#changed();
    entry.settle(allow);
  }

  /** Deny every open question (the prompt is going away). */
  close(): void {
    this.denyAll();
  }

  /**
   * Deny every question waiting, the one shown included: the user's way out
   * of a flood of questions. Later questions are asked as usual.
   */
  denyAll(): void {
    const entries = this.#entries;
    if (entries.length === 0) return;
    this.#entries = [];
    this.#changed();
    for (const entry of entries) entry.settle(false);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly snapshot = (): readonly PendingCredentialRequest[] => this.#snapshot;

  #changed(): void {
    this.#snapshot = this.#entries.map(({ id, request }) => ({ id, request }));
    for (const listener of this.#listeners) listener();
  }
}
