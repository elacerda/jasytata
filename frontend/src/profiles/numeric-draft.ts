/** Object/array path within a canonical profile draft. */
export type NumericPath = Array<string | number>;

/** Accessible field identity, canonical value and UI-only numeric text buffers. */
export interface NumericFieldProps {
  label: string;
  path: NumericPath;
  optional?: boolean;
  value: number | undefined;
  inputValues: Record<string, string>;
  onChange: (path: NumericPath, value: string, optional: boolean) => void;
}

/** Copy a canonical draft and replace one field; undefined removes object fields.
 * @param source - Configuration to copy, never mutated.
 * @param path - Existing parent path with a final property or array index.
 * @param value - Replacement value, or undefined to omit an optional property.
 * @returns An independent updated draft.
 */
export function replacePath<T>(source: T, path: NumericPath, value: unknown): T {
  const copy = structuredClone(source);
  let parent: unknown = copy;
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[segment as number];
    else if (typeof parent === "object" && parent !== null) parent = (parent as Record<string, unknown>)[String(segment)];
  }
  const last = path[path.length - 1];
  if (Array.isArray(parent) && typeof last === "number") parent[last] = value;
  else if (typeof parent === "object" && parent !== null && typeof last === "string") {
    if (value === undefined) delete (parent as Record<string, unknown>)[last];
    else (parent as Record<string, unknown>)[last] = value;
  }
  return copy;
}

/** Parse complete finite decimal text without converting empty text to zero.
 * @param value - Raw input, including temporarily incomplete keystrokes.
 * @returns Finite number, or undefined while the text is incomplete/non-finite.
 */
export function parsedNumber(value: string): number | undefined {
  const text = value.trim();
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

