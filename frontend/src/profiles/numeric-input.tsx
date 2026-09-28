import type { ChangeEvent } from "react";
import type { NumericFieldProps } from "./numeric-draft";

/** Render numeric text separately from the last complete scientific value.
 * @param props - Label, canonical path, raw buffers and edit callback.
 * @returns Accessible decimal input; no coercion or clamping occurs here.
 */
export function NumericField({ label, path, optional = false, value, inputValues, onChange }: NumericFieldProps) {
  const key = path.join(".");
  const displayValue = inputValues[key] ?? (value === undefined ? "" : String(value));
  return (
    <label className="instrument-editor-field">
      <span>{label}{optional ? " · optional" : ""}</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={displayValue}
        aria-label={label}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(path, event.currentTarget.value, optional)}
      />
    </label>
  );
}

