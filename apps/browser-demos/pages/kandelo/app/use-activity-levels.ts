import * as React from "react";
import { readGameLevels } from "../../../../../web-libs/kandelo-session/src/game-levels";
import { MAX_DEPENDENCY_BYTES, type SessionDependency } from "../../../../../web-libs/kandelo-session/src/session-dependencies";
import type { SessionField, SessionValues } from "../../../../../web-libs/kandelo-session/src/package-sessions";
import type { DependencySelections } from "./activity-dependencies";

export function useActivityLevels(fields: SessionField[], dependencies: SessionDependency[], selections: DependencySelections,
  values: SessionValues, setValues: React.Dispatch<React.SetStateAction<SessionValues>>) {
  const [uploaded, setUploaded] = React.useState<Record<string, { file: File; levels: string[]; error?: string }>>({});
  React.useEffect(() => {
    let disposed = false;
    setUploaded({});
    for (const field of fields) if (field.type === "level") {
      const file = selections[field.dependency]?.file;
      if (!file) continue;
      void (async () => {
        try {
          if (file.size <= 0 || file.size > MAX_DEPENDENCY_BYTES) throw new Error("Activity files must be between 1 byte and 64 MiB");
          const levels = readGameLevels(new Uint8Array(await file.arrayBuffer()), field.format);
          if (!disposed) setUploaded(previous => ({ ...previous, [field.id]: { file, levels } }));
        } catch (error) {
          if (!disposed) setUploaded(previous => ({ ...previous, [field.id]: { file, levels: [], error: error instanceof Error ? error.message : String(error) } }));
        }
      })();
    }
    return () => { disposed = true; };
  }, [fields, selections]);
  const levels: Record<string, string[]> = {};
  const errors: string[] = [];
  for (const field of fields) if (field.type === "level") {
    const selection = selections[field.dependency];
    const source = selection?.source ?? dependencies.find(d => d.id === field.dependency)?.sources[0]?.id;
    const parsed = uploaded[field.id];
    levels[field.id] = source === "file" ? selection?.file && parsed?.file === selection.file ? parsed.levels : [] : field.sources[source ?? ""] ?? [];
    if (source === "file" && selection?.file && parsed?.file === selection.file && parsed.error) errors.push(parsed.error);
  }
  const signature = JSON.stringify(levels);
  React.useEffect(() => {
    setValues(previous => {
      const next = { ...previous };
      let changed = false;
      for (const [id, choices] of Object.entries(levels)) if (choices.length && !choices.includes(String(previous[id]))) {
        next[id] = choices.includes(fields.find(f => f.id === id)?.default as string) ? fields.find(f => f.id === id)!.default : choices[0];
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [signature, fields, setValues]);
  return { levels, errors, ready: Object.entries(levels).every(([id, choices]) => choices.includes(String(values[id]))) };
}
