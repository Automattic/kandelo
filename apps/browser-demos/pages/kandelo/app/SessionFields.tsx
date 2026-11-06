import * as React from "react";
import { sessionFieldWarning, type SessionDisplayField } from "../../../../../web-libs/kandelo-session/src/package-sessions";
import type { SessionField, SessionValues } from "../../../../../web-libs/kandelo-session/src/package-sessions";

/** Offer and participant forms render the same bounded package field types. */
export function SessionFields({ fields, values, onChange, disabled, levels = {}, sources = {} }: {
  fields: (SessionField | SessionDisplayField)[]; values: SessionValues;
  onChange: (values: SessionValues) => void; disabled: boolean; levels?: Record<string, string[]>; sources?: Record<string, string>;
}) {
  return <>{fields.map(field => <React.Fragment key={field.id}><label className="knetwork-field" key={field.id}>
    {field.label}
    {field.type === "level" ? <select aria-label={field.label} disabled={disabled || !levels[field.id]?.length} value={values[field.id] ?? ""}
      onChange={event => onChange({ ...values, [field.id]: event.target.value })}>
      {!levels[field.id]?.length && <option value="">Choose game data to see its levels</option>}
      {levels[field.id]?.map(level => <option key={level} value={level}>{level}</option>)}
    </select> : field.type === "choice" ? <select aria-label={field.label} disabled={disabled} value={values[field.id] ?? field.default}
      onChange={event => onChange({ ...values, [field.id]: event.target.value })}>
      {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select> : <input disabled={disabled} required
      type={field.type === "integer" ? "number" : "text"}
      min={field.type === "integer" ? field.min : undefined}
      max={field.type === "integer" ? field.max : undefined}
      maxLength={field.type === "text" ? field.maxLength : undefined}
      value={Number.isNaN(values[field.id]) ? "" : values[field.id] ?? field.default}
      onChange={event => onChange({ ...values, [field.id]: field.type === "integer" ? event.target.valueAsNumber : event.target.value })} />}
  </label>{sessionFieldWarning(field, values[field.id] ?? field.default, field.type === "level" ? sources[field.dependency] : undefined) && <p className="knetwork-note" data-activity-warning>{sessionFieldWarning(field, values[field.id] ?? field.default, field.type === "level" ? sources[field.dependency] : undefined)}</p>}</React.Fragment>)}</>;
}
