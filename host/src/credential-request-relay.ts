/**
 * Main-thread side of the credential prompt: hands the kernel worker's
 * `credential_request` to the embedder's `onCredentialRequest` handler and
 * posts the answer back. Shared by `NodeKernelHost` and `BrowserKernel` so
 * both hosts deny the same way:
 *
 * - no handler: deny at once (embedders that never ask never grant);
 * - a handler that throws, rejects, or resolves anything but `true`: deny,
 *   and a throw or rejection is reported;
 * - a withdrawn question (`credential_request_cancel`) or host teardown:
 *   abort the handler's signal and send nothing (the kernel worker already
 *   treated it as denied).
 *
 * Type-only imports: this runs on the main thread, which never loads the
 * kernel worker.
 */
import type { CredentialRequestHandler } from "./credential-grants";
import type {
  CredentialAnswerMessage,
  CredentialRequestMessage,
} from "./kernel-protocol-shared";

export class CredentialRequestRelay {
  readonly #handler: CredentialRequestHandler | undefined;
  readonly #send: (message: CredentialAnswerMessage) => void;
  readonly #report: (error: unknown) => void;
  readonly #open = new Map<number, AbortController>();

  constructor(
    handler: CredentialRequestHandler | undefined,
    send: (message: CredentialAnswerMessage) => void,
    report: (error: unknown) => void,
  ) {
    this.#handler = handler;
    this.#send = send;
    this.#report = report;
  }

  request(message: CredentialRequestMessage): void {
    const { requestId } = message;
    const controller = new AbortController();
    this.#open.set(requestId, controller);
    const answer = (allow: boolean): void => {
      if (this.#open.get(requestId) !== controller) return;
      this.#open.delete(requestId);
      try {
        this.#send({ type: "credential_answer", requestId, allow });
      } catch (error) {
        // The kernel worker is gone; its teardown already denied the question.
        this.#report(error);
      }
    };
    const handler = this.#handler;
    if (!handler) {
      answer(false);
      return;
    }
    let pending: Promise<boolean>;
    try {
      pending = Promise.resolve(
        handler(structuredClone(message.request), { signal: controller.signal }),
      );
    } catch (error) {
      this.#report(error);
      answer(false);
      return;
    }
    pending.then(
      (allow) => answer(allow === true),
      (error: unknown) => {
        this.#report(error);
        answer(false);
      },
    );
  }

  /** The kernel worker withdrew the question; the handler's answer is moot. */
  cancel(requestId: number): void {
    const controller = this.#open.get(requestId);
    if (!controller) return;
    this.#open.delete(requestId);
    controller.abort();
  }

  /** Host teardown: abort every open question. */
  close(): void {
    for (const controller of this.#open.values()) controller.abort();
    this.#open.clear();
  }
}
