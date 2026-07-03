import * as React from "react";
import type { DemoActionConfig, DemoGuideConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import { useDemoGuide, useKernelHost, useStatus, useWebPreview } from "../kernel-host/react";

export interface DemoGuideProps {
  onOpenTerminal: () => void;
  onRunWebAction: (action: DemoActionConfig) => Promise<string | void>;
}

export const DemoGuide: React.FC<DemoGuideProps> = ({ onOpenTerminal, onRunWebAction }) => {
  const host = useKernelHost();
  const status = useStatus();
  const webPreview = useWebPreview();
  const descriptor = host.getBootDescriptor();
  const guide = useDemoGuide();
  const [scriptText, setScriptText] = React.useState(() => guide?.script?.initialText ?? "");
  const [runningId, setRunningId] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const runningIdRef = React.useRef<string | null>(null);
  const editorRef = React.useRef<HTMLTextAreaElement | null>(null);
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);

  React.useEffect(() => {
    setScriptText(guide?.script?.initialText ?? "");
    setMessage(null);
    setRunningId(null);
    runningIdRef.current = null;
  }, [guide]);

  const actionsById = React.useMemo(() => actionMap(guide), [guide]);

  const runAction = React.useCallback(async (action: DemoActionConfig) => {
    if (status !== "running") return;
    if (runningIdRef.current !== null) return;
    runningIdRef.current = action.id;
    setRunningId(action.id);
    setMessage(null);
    try {
      if (action.kind === "terminal.run") {
        onOpenTerminal();
        await host.runShellCommand(action.payload);
        setMessage(`Sent ${action.label}`);
      } else if (action.kind === "terminal.write") {
        onOpenTerminal();
        const pty = await host.attachPty("/dev/pts/0", { cols: 100, rows: 30 });
        pty.write(action.payload);
        pty.close();
        setMessage(`Sent ${action.label}`);
      } else {
        const result = await onRunWebAction(action);
        setMessage(result ?? `Ran ${action.label}`);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      runningIdRef.current = null;
      setRunningId(null);
    }
  }, [host, onOpenTerminal, status]);

  const runScript = React.useCallback(async () => {
    if (!guide?.script) return;
    const text = (editorRef.current?.value ?? scriptText).trimEnd();
    if (!text || status !== "running") return;
    await runAction({
      id: "script",
      label: guide.script.title,
      description: "Run the script editor contents.",
      kind: "terminal.run",
      payload: scriptToShellCommand(text),
    });
  }, [guide?.script, runAction, scriptText, status]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; actionId?: unknown };
      if (data?.type !== "kandelo.demoAction" || typeof data.actionId !== "string") return;
      const action = actionsById.get(data.actionId);
      if (!action) {
        setMessage(`Rejected unknown action ${data.actionId}`);
        return;
      }
      void runAction(action);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [actionsById, runAction]);

  if (!guide) return null;

  const waitingForWeb = webPreview !== null && webPreview.status !== "running";
  const disabled = status !== "running" || waitingForWeb;
  const groups = guide.groups ?? [];

  return (
    <aside className="kdemo" aria-label="Demo actions">
      <div className="kdemo-head">
        <div>
          <div className="kdemo-kicker">DEMO</div>
          <h2>{guide.title}</h2>
        </div>
        <div className="kdemo-id">{descriptor.id}</div>
      </div>
      {guide.summary && <p className="kdemo-summary">{guide.summary}</p>}

      {groups.length > 0 && (
        <div className="kdemo-groups">
          {groups.map((group) => (
            <section className="kdemo-section" key={group.title}>
              <div className="kdemo-section-title">{group.title}</div>
              <div className={`kdemo-actions${group.actions.length === 1 ? " single" : ""}`}>
                {group.actions.map((action) => (
                  <button
                    type="button"
                    className="kdemo-action"
                    key={action.id}
                    disabled={disabled || runningId !== null}
                    onClick={() => void runAction(action)}
                  >
                    <span>{runningId === action.id ? "Running..." : action.label}</span>
                    {action.description && <small>{action.description}</small>}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {guide.script && (
        <section className="kdemo-section">
          <div className="kdemo-section-title">{guide.script.title}</div>
          <textarea
            ref={editorRef}
            className="kdemo-editor"
            spellCheck={false}
            value={scriptText}
            onChange={(event) => setScriptText(event.currentTarget.value)}
          />
          <div className="kdemo-row">
            <span className="kdemo-lang">{guide.script.language}</span>
            <button
              type="button"
              className="kdemo-run"
              disabled={disabled || runningId !== null || scriptText.trim() === ""}
              onClick={() => void runScript()}
            >
              {runningId === "script" ? "Running..." : "Run script"}
            </button>
          </div>
        </section>
      )}

      {guide.companion && (
        <section className="kdemo-section">
          <div className="kdemo-section-title">{guide.companion.title}</div>
          <iframe
            ref={iframeRef}
            className="kdemo-companion"
            sandbox="allow-scripts"
            srcDoc={guide.companion.srcDoc}
            title={`${guide.title} companion`}
          />
        </section>
      )}

      <div className="kdemo-status" role="status">
        {status !== "running"
          ? "Waiting for the machine to finish booting."
          : waitingForWeb
            ? webPreview.message ?? "Waiting for web preview."
            : message ?? "Ready"}
      </div>
    </aside>
  );
};

function actionMap(guide: DemoGuideConfig | null): Map<string, DemoActionConfig> {
  const map = new Map<string, DemoActionConfig>();
  for (const group of guide?.groups ?? []) {
    for (const action of group.actions) map.set(action.id, action);
  }
  return map;
}

function scriptToShellCommand(script: string): string {
  const delimiter = pickDelimiter(script);
  return `cat > /tmp/kandelo-demo-action.sh <<'${delimiter}' && bash /tmp/kandelo-demo-action.sh
${script}
${delimiter}`;
}

function pickDelimiter(script: string): string {
  let suffix = 0;
  while (true) {
    const candidate = suffix === 0 ? "KANDELO_DEMO_SCRIPT" : `KANDELO_DEMO_SCRIPT_${suffix}`;
    if (!script.includes(candidate)) return candidate;
    suffix++;
  }
}
