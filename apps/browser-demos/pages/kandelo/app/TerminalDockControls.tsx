import * as React from "react";
import { useRemovePty } from "../kernel-host/react";
import type { ShellTerminal } from "../panes/Shell";

export const TerminalDockControls: React.FC<{
  terminals: ShellTerminal[];
  activeTerminalId: string;
  onActiveTerminalId: (id: string) => void;
  onAddTerminal: () => void;
  onRemoveTerminalId: (id: string) => void;
}> = ({
  terminals,
  activeTerminalId,
  onActiveTerminalId,
  onAddTerminal,
  onRemoveTerminalId,
}) => {
  const removePty = useRemovePty();
  return (
    <div className="kdock-view-tabs" role="tablist" aria-label="Terminals">
      {terminals.map((terminal) => (
        <span className="kdock-terminal-tab" key={terminal.id}>
          <button
            type="button"
            className="kdock-view-tab"
            role="tab"
            aria-selected={terminal.id === activeTerminalId}
            onClick={() => onActiveTerminalId(terminal.id)}
          >
            {terminal.label}
          </button>
          {terminals.length > 1 && (
            <button
              type="button"
              className="kdock-terminal-close"
              aria-label={`Close ${terminal.label}`}
              onClick={() => {
                removePty(terminal.path);
                onRemoveTerminalId(terminal.id);
              }}
            >
              ×
            </button>
          )}
        </span>
      ))}
      <button
        type="button"
        className="kdock-view-iconbtn"
        title="New terminal"
        aria-label="New terminal"
        onClick={onAddTerminal}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M6 2v8M2 6h8" />
        </svg>
      </button>
    </div>
  );
};
