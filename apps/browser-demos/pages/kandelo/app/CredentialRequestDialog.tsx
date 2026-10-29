// The app's answer to a program that asks for sign-in credentials.
//
// The kernel asks when a process starts an image its package declared in
// /etc/kandelo/credential-requests.d (docs/browser-support.md, "Per-process
// credential grants"). This component is the app's `KernelHost` credential
// handler: it queues the questions and shows them one at a time in Kandelo's
// own interface, never in the terminal the program controls. The queue is
// `CredentialRequestQueue` (web-libs/kandelo-session).
//
// Deny is the default everywhere: initial focus is on "Don't allow", Allow
// ignores input for a moment after each question appears, Escape answers
// "Don't allow", a withdrawn question (the process exited or ran
// another program, or the machine is torn down) closes as deny, and
// unmounting denies whatever is still open. Nothing that allows is
// remembered: every process asks again. The only remembered choice is a
// denial, "Don't allow, and stop asking for this machine", held in memory
// by the session host until the machine goes away. With questions waiting,
// "Deny all waiting" clears them, so a guest that starts declared programs
// in a loop cannot keep the user from the terminal (the kernel worker also
// keeps at most eight questions open per machine).
//
// The question also says, in its main body, which intermediary each
// credentialed request passes through (`CredentialRequest.transport`, named
// by the kernel worker from its real proxy and relay configuration) and
// that whoever operates it can read the credentials: a user may trust the
// destination and not the CORS proxy in between.

import * as React from "react";
import { createPortal } from "react-dom";
import { useKernelHost } from "../kernel-host/react";
import type {
  CredentialRequest,
  CredentialTransport,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { CredentialRequestQueue } from "../../../../../web-libs/kandelo-session/src/credential-request-queue";

/**
 * How long "Allow for this process" ignores input after a question appears,
 * including each queued question that replaces the previous one. Without
 * it, input aimed elsewhere can answer a prompt the user has not read: keys
 * typed into the terminal as the dialog opens, or the second click of a
 * double-click landing on the next queued dialog's identical button. The
 * same delay browsers put on their own permission prompts. "Don't allow"
 * is usable at once.
 */
export const CREDENTIAL_ALLOW_INPUT_DELAY_MS = 750;

/** Installs the app's credential prompt on the session host and renders it. */
export const CredentialRequestPrompt: React.FC = () => {
  const host = useKernelHost();
  const queue = React.useMemo(() => new CredentialRequestQueue(), []);
  React.useEffect(() => {
    host.setCredentialRequestHandler(queue.ask);
    return () => {
      host.setCredentialRequestHandler(null);
      queue.close();
    };
  }, [host, queue]);
  const pending = React.useSyncExternalStore(queue.subscribe, queue.snapshot);
  const current = pending[0];
  if (current === undefined) return null;
  return (
    <CredentialRequestDialog
      // A new question remounts the dialog, so focus returns to "Don't allow".
      key={current.id}
      request={current.request}
      waiting={pending.length - 1}
      answer={(allow) => queue.answer(current.id, allow)}
      denyAll={() => queue.denyAll()}
      stopAsking={() => {
        host.stopCredentialRequests();
        queue.denyAll();
      }}
    />
  );
};

const FOCUSABLE = "button:not(:disabled), summary, a[href], [tabindex]:not([tabindex='-1'])";

export function CredentialRequestDialog({ request, waiting, answer, denyAll, stopAsking }: {
  request: CredentialRequest;
  /** Further questions queued behind this one. */
  waiting: number;
  answer: (allow: boolean) => void;
  /** Deny this question and every one queued behind it. */
  denyAll: () => void;
  /** Deny all of them and every later question for this machine. */
  stopAsking: () => void;
}) {
  const dialog = React.useRef<HTMLDivElement>(null);
  const deny = React.useRef<HTMLButtonElement>(null);
  // Per mount: the prompter keys this component by question, so every new
  // question, queued or not, starts disarmed. A question that opened while
  // the page was hidden or unfocused disarms again when the user returns,
  // so input meant for another window cannot land on Allow. The other
  // choices that answer more than this question ("Deny all waiting", "stop
  // asking") wait too: they only deny, but a stray Enter should not make a
  // choice for the whole machine.
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      setArmed(false);
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      timer = window.setTimeout(() => setArmed(true), CREDENTIAL_ALLOW_INPUT_DELAY_MS);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    window.addEventListener("focus", arm);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
      window.removeEventListener("focus", arm);
    };
  }, []);

  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    deny.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Window-level so Escape and Tab never reach the page behind the prompt
  // (the terminal, a preview) while it is open.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = dialog.current;
      if (root === null) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        answer(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) {
        event.preventDefault();
        deny.current?.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [answer]);

  const parents = request.parentChain.length === 0
    ? "none recorded"
    : request.parentChain.map(({ pid, program }) => `${program} (process ${pid})`).join(" ← ");

  return createPortal(
    // A click outside is not an answer: only the two buttons and Escape are.
    <div className="kshare-backdrop">
      <div
        ref={dialog}
        className="kshare kcred"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kcred-title"
        aria-describedby="kcred-summary"
      >
        <div className="kshare-hd">
          <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="var(--k-accent)" strokeWidth="1.2" aria-hidden="true">
            <circle cx="5" cy="8" r="3" />
            <path d="M8 8h7M12.5 8v2.5M14.5 8v2" />
          </svg>
          <div className="kshare-title" id="kcred-title">
            {request.title} wants to use your sign-in credentials
          </div>
        </div>
        <div className="kshare-body">
          {request.programChangedSinceBoot && (
            <p className="kcred-changed" role="alert" data-testid="credential-request-changed">
              <strong>This file has changed since the machine started.</strong>{" "}
              Something on this machine replaced or modified it after boot, so
              it is not the file the machine's image provided, and the title
              above may not describe it.
            </p>
          )}
          <div id="kcred-summary">
            <p className="kcred-lead">
              It asks to send your sign-in credentials to:
            </p>
            <ul className="kcred-destinations">
              {request.destinations.map((destination) => (
                <li key={destination}>{destination}</li>
              ))}
            </ul>
            <div className="kcred-transport" data-testid="credential-request-transport">
              {request.transport.map((leg) => (
                <TransportLine
                  key={`${leg.kind} ${leg.via ?? ""}`}
                  leg={leg}
                  everyDestination={request.transport.length === 1}
                />
              ))}
            </div>
          </div>
          <div className="kshare-prev">
            <div className="kshare-prev-row">
              <span className="kshare-prev-k">Program</span>
              <span className="kshare-prev-v" data-testid="credential-request-program">{request.program}</span>
            </div>
            <div className="kshare-prev-row">
              <span className="kshare-prev-k">Process</span>
              <span className="kshare-prev-v" data-testid="credential-request-pid">{request.pid}</span>
            </div>
            <div className="kshare-prev-row">
              <span className="kshare-prev-k">Image</span>
              {/* One line: the provenance label leads, so a long URL is
                  what gets clipped. The full value is in the details. A
                  changed file did not come from the image, so the image's
                  provenance is not shown as the file's. */}
              <span
                className="kshare-prev-v kcred-clip"
                data-testid="credential-request-image"
                title={request.programChangedSinceBoot ? CHANGED_FILE_SOURCE : request.imageSource}
              >
                {request.programChangedSinceBoot ? CHANGED_FILE_SOURCE : request.imageSource}
              </span>
            </div>
          </div>
          <p className="kcred-scope">
            Allow lets only this running process send them, until it exits or
            runs another program; programs it starts never inherit this.
          </p>
          {request.enforcement === "none" && (
            <p className="kcred-scope" data-testid="credential-request-unenforced">
              On this host your answer is recorded but not enforced: programs
              reach the network directly, with or without it.
            </p>
          )}
          <details className="kcred-details">
            <summary>Details</summary>
            <dl>
              <dt>Program path</dt>
              <dd>{request.program}</dd>
              <dt>Command line</dt>
              <dd>{commandLine(request.argv)}</dd>
              <dt>Started by</dt>
              <dd data-testid="credential-request-parents">{parents}</dd>
              <dt>Destinations</dt>
              <dd>{request.destinations.join(", ")}</dd>
              <dt>Machine image</dt>
              <dd>{request.imageSource}</dd>
              {request.programChangedSinceBoot && (
                <>
                  <dt>Program file</dt>
                  <dd>{CHANGED_FILE_SOURCE}</dd>
                </>
              )}
            </dl>
          </details>
          <div className="kcred-more">
            {waiting > 0 && (
              <>
                <span className="kcred-waiting" role="status">
                  {waiting === 1 ? "1 more request is waiting" : `${waiting} more requests are waiting`}
                </span>
                <button type="button" className="kshare-btn kcred-secondary" disabled={!armed} onClick={() => {
                  if (armed) denyAll();
                }}>
                  Deny all waiting
                </button>
              </>
            )}
            <button type="button" className="kshare-btn kcred-secondary" disabled={!armed} onClick={() => {
              if (armed) stopAsking();
            }}>
              Don't allow, and stop asking for this machine
            </button>
          </div>
        </div>
        {/* "Don't allow" is last, so Tab from it wraps to the top of the
            dialog rather than onto Allow. */}
        <div className="kshare-actions">
          <button
            type="button"
            className="kshare-btn"
            disabled={!armed}
            onClick={() => {
              if (armed) answer(true);
            }}
          >
            Allow for this process
          </button>
          <div style={{ flex: 1 }} />
          <button ref={deny} type="button" className="kshare-btn" onClick={() => answer(false)}>
            Don't allow
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * One sentence per intermediary: who receives the credentials on their way,
 * and that they can read them. With one leg for every destination the
 * sentence says "these destinations"; otherwise it names its own.
 */
function TransportLine({ leg, everyDestination }: {
  leg: CredentialTransport;
  everyDestination: boolean;
}) {
  const subject = everyDestination
    ? "Your credentials"
    : `Your credentials for ${leg.destinations.join(", ")}`;
  const onward = everyDestination ? " to these destinations" : "";
  const via = (
    <strong className="kcred-via" data-testid="credential-request-via">{leg.via}</strong>
  );
  switch (leg.kind) {
    case "proxy":
      return (
        <p className="kcred-leg" data-transport-kind="proxy">
          {subject} pass through {via}, the CORS proxy this site uses, which
          forwards them{onward}. Whoever operates that proxy can read them.
        </p>
      );
    case "relay":
      return (
        <p className="kcred-leg" data-transport-kind="relay">
          {subject} pass through {via}, the credential relay of the
          development server running on this computer, which forwards
          them{onward}. Whoever runs that server can read them.
        </p>
      );
    case "direct":
      return (
        <p className="kcred-leg" data-transport-kind="direct">
          {everyDestination
            ? "The program connects to these destinations directly"
            : `The program connects to ${leg.destinations.join(", ")} directly`}
          : no proxy or relay is in between.
        </p>
      );
    case "none":
      return (
        <p className="kcred-leg kcred-leg-none" data-transport-kind="none">
          {subject} cannot be sent from this deployment: it has no CORS proxy
          to carry them, so requests that carry them are refused even if you
          allow.
        </p>
      );
  }
}

/** What the prompt says of a program file that changed after boot. */
const CHANGED_FILE_SOURCE = "Not from the image: this file changed after the machine started";

/** argv as a reader would type it: arguments with spaces or quotes quoted. */
function commandLine(argv: readonly string[]): string {
  return argv
    .map((argument) =>
      argument !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument)
        ? argument
        : `'${argument.replace(/'/g, `'\\''`)}'`
    )
    .join(" ");
}
