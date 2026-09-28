import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, SyntheticEvent } from "react";
import type { ProfileDocument } from "./document";
import { NumericField } from "./numeric-input";
import { parsedNumber, replacePath, type NumericPath, type NumericFieldProps } from "./numeric-draft";
import { SurveyProfileEditor } from "./SurveyProfileEditor";
import { footprintSummary } from "./presentation";
import { validateInstrumentProfileV2 } from "./schema-v2";
import type {
  CircleFootprint,
  CompoundFootprint,
  Footprint,
  InstrumentProfileV2,
  NonCompoundFootprint,
  PolygonFootprint,
  RectangleFootprint,
} from "../types";

type ProfileDocumentDraft = Pick<ProfileDocument, "instrument">;
type FootprintType = Footprint["type"];

interface ValidationPreview {
  instrument: InstrumentProfileV2 | null;
  error: string | null;
  incomplete: boolean;
}

interface GeometryFieldsProps {
  footprint: NonCompoundFootprint;
  path: NumericPath;
  prefix: string;
  inputValues: Record<string, string>;
  onNumberChange: NumericFieldProps["onChange"];
  onAddVertex: () => void;
  onRemoveVertex: (index: number) => void;
}

const FOOTPRINT_LABELS: Record<FootprintType, string> = {
  rectangle: "Rectangle",
  circle: "Circle",
  polygon: "Polygon",
  compound: "Compound / mosaic",
};

function defaultRectangle(): RectangleFootprint {
  return { type: "rectangle", width_deg: 1, height_deg: 1, position_angle_deg: 0 };
}

function defaultCircle(): CircleFootprint {
  return { type: "circle", radius_deg: 0.5 };
}

function defaultPolygon(): PolygonFootprint {
  return {
    type: "polygon",
    vertices_deg: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
    position_angle_deg: 0,
  };
}

function defaultCompound(): CompoundFootprint {
  return {
    type: "compound",
    components: [
      { offset_deg: [-0.6, 0], rotation_deg: 0, footprint: defaultRectangle() },
      { offset_deg: [0.6, 0], rotation_deg: 0, footprint: defaultCircle() },
    ],
    position_angle_deg: 0,
  };
}

function defaultFootprint(type: FootprintType): Footprint {
  switch (type) {
    case "rectangle": return defaultRectangle();
    case "circle": return defaultCircle();
    case "polygon": return defaultPolygon();
    case "compound": return defaultCompound();
  }
}

function createDraft(): ProfileDocumentDraft {
  return {
    instrument: {
      schema_version: 2,
      id: "",
      display_name: "",
      coordinate_frame: "icrs",
      footprint: defaultRectangle(),
    },
  };
}

function readPath(source: unknown, path: NumericPath): unknown {
  return path.reduce<unknown>((value, segment) => {
    if (Array.isArray(value)) return value[segment as number];
    if (typeof value === "object" && value !== null) return (value as Record<string, unknown>)[String(segment)];
    return undefined;
  }, source);
}

function shiftIndexedPaths<T extends string[] | Record<string, string>>(
  values: T,
  prefix: string,
  removedIndex: number,
): T {
  const entries = Array.isArray(values)
    ? values.map((value) => [value, value] as const)
    : Object.entries(values);
  const marker = `${prefix}.`;
  const nextEntries: Array<readonly [string, string]> = [];
  for (const [key, value] of entries) {
    if (!key.startsWith(marker)) {
      nextEntries.push([key, value]);
      continue;
    }
    const suffix = key.slice(marker.length);
    const separator = suffix.indexOf(".");
    const indexText = separator === -1 ? suffix : suffix.slice(0, separator);
    if (!/^\d+$/.test(indexText)) {
      nextEntries.push([key, value]);
      continue;
    }
    const index = Number(indexText);
    if (index === removedIndex) continue;
    const shiftedIndex = index > removedIndex ? index - 1 : index;
    const tail = separator === -1 ? "" : suffix.slice(separator);
    nextEntries.push([`${marker}${shiftedIndex}${tail}`, value]);
  }
  if (Array.isArray(values)) return nextEntries.map(([key]) => key) as T;
  return Object.fromEntries(nextEntries) as T;
}

function GeometryFields({
  footprint,
  path,
  prefix,
  inputValues,
  onNumberChange,
  onAddVertex,
  onRemoveVertex,
}: GeometryFieldsProps) {
  const field = (label: string, parts: NumericPath, value: number | undefined, optional = false) => (
    <NumericField
      key={parts.join(".")}
      label={`${prefix}${label}`}
      path={[...path, ...parts]}
      value={value}
      optional={optional}
      inputValues={inputValues}
      onChange={onNumberChange}
    />
  );

  if (footprint.type === "rectangle") {
    return (
      <div className="instrument-editor-grid">
        {field("width (°)", ["width_deg"], footprint.width_deg)}
        {field("height (°)", ["height_deg"], footprint.height_deg)}
        {field("position angle (°)", ["position_angle_deg"], footprint.position_angle_deg, true)}
      </div>
    );
  }

  if (footprint.type === "circle") {
    return <div className="instrument-editor-grid">{field("radius (°)", ["radius_deg"], footprint.radius_deg)}</div>;
  }

  return (
    <div className="instrument-editor-polygon">
      {field("position angle (°)", ["position_angle_deg"], footprint.position_angle_deg, true)}
      <fieldset className="instrument-editor-vertices">
        <legend>{prefix ? `${prefix}vertices · local tangent-plane degrees` : "Vertices · local tangent-plane degrees"}</legend>
        {footprint.vertices_deg.map(([east, north], index) => (
          <div className="instrument-editor-vertex" key={`vertex-${index}`}>
            <span className="instrument-editor-index">{index + 1}</span>
            {field(`vertex ${index + 1} east (°)`, ["vertices_deg", index, 0], east)}
            {field(`vertex ${index + 1} north (°)`, ["vertices_deg", index, 1], north)}
            <button className="button button-quiet" type="button" aria-label={`Remove ${prefix}vertex ${index + 1}`} onClick={() => onRemoveVertex(index)}>
              Remove
            </button>
          </div>
        ))}
        <button className="button button-outline" type="button" onClick={onAddVertex}>Add vertex</button>
      </fieldset>
    </div>
  );
}

/** Callbacks for the isolated instrument/survey authoring workflow. */
export interface InstrumentProfileEditorProps {
  /** Close the draft without registering it or changing planner state. */
  onCancel: () => void;
  /** Atomically register a complete validated document; throws on failure. */
  onRegister?: (document: ProfileDocument) => void;
  /** Receive the normalized instrument when it is valid, or null otherwise. */
  onInstrumentValidatedChange?: (instrument: InstrumentProfileV2 | null) => void;
}

/**
 * Author a Schema v2 instrument profile in isolated local form state.
 *
 * The first stage retains the existing instrument object; the survey stage
 * completes the same ProfileDocument used by JSON import. Numeric text buffers are UI state for
 * incomplete keystrokes; scientific values remain `InstrumentProfileV2` and are
 * checked by the shared validator. This component never mutates the registry.
 *
 * @param props - Cancel, explicit registration and optional instrument preview callbacks.
 * @returns A keyboard-accessible profile authoring dialog.
 */
export function InstrumentProfileEditor({ onCancel, onRegister, onInstrumentValidatedChange }: InstrumentProfileEditorProps) {
  const [stage, setStage] = useState<"instrument" | "survey">("instrument");
  const [surveyStarted, setSurveyStarted] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [documentDraft, setDocumentDraft] = useState<ProfileDocumentDraft>(createDraft);
  const [numberInputs, setNumberInputs] = useState<Record<string, string>>({});
  const [incompleteNumberPaths, setIncompleteNumberPaths] = useState<string[]>([]);
  const instrumentDraft = documentDraft.instrument;

  const validation = useMemo<ValidationPreview>(() => {
    if (incompleteNumberPaths.length > 0) {
      return {
        instrument: null,
        error: "Finish the numeric field before validating the instrument.",
        incomplete: true,
      };
    }
    try {
      return { instrument: validateInstrumentProfileV2(instrumentDraft), error: null, incomplete: false };
    } catch (caught) {
      return {
        instrument: null,
        error: caught instanceof Error ? caught.message : "Instrument validation failed.",
        incomplete: false,
      };
    }
  }, [instrumentDraft, incompleteNumberPaths]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.open = true;
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.open = false;
    };
  }, []);

  useEffect(() => {
    const label = stage === "instrument" ? "Instrument ID" : "Survey ID";
    dialogRef.current?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.focus();
  }, [stage]);

  useEffect(() => {
    onInstrumentValidatedChange?.(validation.instrument);
  }, [onInstrumentValidatedChange, validation.instrument]);

  function updateNumber(path: NumericPath, text: string, optional: boolean) {
    const key = path.join(".");
    setNumberInputs((current) => ({ ...current, [key]: text }));
    const value = text.trim() ? parsedNumber(text) : undefined;
    if (value === undefined && !(optional && text.trim() === "")) {
      setIncompleteNumberPaths((current) => current.includes(key) ? current : [...current, key]);
      return;
    }
    setDocumentDraft((current) => ({
      instrument: replacePath(current.instrument, path, value),
    }));
    setIncompleteNumberPaths((current) => current.filter((entry) => entry !== key));
  }

  function updateInstrumentField(field: "id" | "display_name", value: string) {
    setDocumentDraft((current) => ({ instrument: { ...current.instrument, [field]: value } }));
  }

  function updateDescription(value: string) {
    setDocumentDraft((current) => {
      const instrument = { ...current.instrument };
      if (value === "") delete instrument.description;
      else instrument.description = value;
      return { instrument };
    });
  }

  function changeRootFootprint(type: FootprintType) {
    setDocumentDraft((current) => ({ instrument: { ...current.instrument, footprint: defaultFootprint(type) } }));
    setNumberInputs({});
    setIncompleteNumberPaths([]);
  }

  function updatePolygon(path: NumericPath, update: (polygon: PolygonFootprint) => PolygonFootprint) {
    setDocumentDraft((current) => {
      const footprint = readPath(current.instrument, path);
      if (typeof footprint !== "object" || footprint === null || !("type" in footprint) || footprint.type !== "polygon") return current;
      return { instrument: replacePath(current.instrument, path, update(footprint as PolygonFootprint)) };
    });
  }

  function addPolygonVertex(path: NumericPath) {
    updatePolygon(path, (polygon) => ({ ...polygon, vertices_deg: [...polygon.vertices_deg, [0, 0]] }));
  }

  function removePolygonVertex(path: NumericPath, index: number) {
    updatePolygon(path, (polygon) => ({
      ...polygon,
      vertices_deg: polygon.vertices_deg.filter((_, vertexIndex) => vertexIndex !== index),
    }));
    const prefix = `${path.join(".")}.vertices_deg`;
    setNumberInputs((current) => shiftIndexedPaths(current, prefix, index));
    setIncompleteNumberPaths((current) => shiftIndexedPaths(current, prefix, index));
  }

  function updateCompound(update: (compound: CompoundFootprint) => CompoundFootprint) {
    setDocumentDraft((current) => {
      const footprint = current.instrument.footprint;
      if (footprint.type !== "compound") return current;
      return { instrument: { ...current.instrument, footprint: update(footprint) } };
    });
  }

  function addComponent() {
    updateCompound((compound) => ({
      ...compound,
      components: [...compound.components, {
        offset_deg: [compound.components.length * 0.6, 0],
        rotation_deg: 0,
        footprint: defaultRectangle(),
      }],
    }));
  }

  function removeComponent(index: number) {
    updateCompound((compound) => ({
      ...compound,
      components: compound.components.filter((_, componentIndex) => componentIndex !== index),
    }));
    const prefix = "footprint.components";
    setNumberInputs((current) => shiftIndexedPaths(current, prefix, index));
    setIncompleteNumberPaths((current) => shiftIndexedPaths(current, prefix, index));
  }

  function changeComponentFootprint(index: number, type: Exclude<FootprintType, "compound">) {
    updateCompound((compound) => ({
      ...compound,
      components: compound.components.map((component, componentIndex) => componentIndex === index
        ? { ...component, footprint: defaultFootprint(type) as NonCompoundFootprint }
        : component),
    }));
    const prefix = `footprint.components.${index}.footprint`;
    setNumberInputs((current) => Object.fromEntries(Object.entries(current).filter(([path]) => !path.startsWith(`${prefix}.`))));
    setIncompleteNumberPaths((current) => current.filter((path) => !path.startsWith(`${prefix}.`)));
  }

  function resetDraft() {
    setSurveyStarted(false);
    setStage("instrument");
    setDocumentDraft(createDraft());
    setNumberInputs({});
    setIncompleteNumberPaths([]);
  }

  function handleDialogCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    onCancel();
  }

  const rootFootprint = instrumentDraft.footprint;
  let geometryFields: ReactNode;
  if (rootFootprint.type === "compound") {
    geometryFields = (
      <div className="instrument-editor-compound">
        <NumericField
          label="Mosaic position angle (°)"
          path={["footprint", "position_angle_deg"]}
          value={rootFootprint.position_angle_deg}
          optional
          inputValues={numberInputs}
          onChange={updateNumber}
        />
        <p className="instrument-editor-help">Component offsets use local east/north degrees. Child rotation, child footprint angle, and mosaic angle are separate schema fields.</p>
        <div className="instrument-editor-component-list">
          {rootFootprint.components.map((component, index) => {
            const componentPrefix = `Component ${index + 1} `;
            const componentPath: NumericPath = ["footprint", "components", index];
            return (
              <fieldset className="instrument-editor-component" key={`component-${index}`}>
                <legend>Component {index + 1}</legend>
                <label className="instrument-editor-field">
                  <span>Component {index + 1} footprint type</span>
                  <select
                    value={component.footprint.type}
                    aria-label={`Component ${index + 1} footprint type`}
                    onChange={(event) => changeComponentFootprint(index, event.currentTarget.value as Exclude<FootprintType, "compound">)}
                  >
                    <option value="rectangle">Rectangle</option>
                    <option value="circle">Circle</option>
                    <option value="polygon">Polygon</option>
                  </select>
                </label>
                <GeometryFields
                  footprint={component.footprint}
                  path={[...componentPath, "footprint"]}
                  prefix={componentPrefix}
                  inputValues={numberInputs}
                  onNumberChange={updateNumber}
                  onAddVertex={() => addPolygonVertex([...componentPath, "footprint"])}
                  onRemoveVertex={(vertexIndex) => removePolygonVertex([...componentPath, "footprint"], vertexIndex)}
                />
                <div className="instrument-editor-grid">
                  <NumericField
                    label={`Component ${index + 1} offset east (°)`}
                    path={[...componentPath, "offset_deg", 0]}
                    value={component.offset_deg[0]}
                    inputValues={numberInputs}
                    onChange={updateNumber}
                  />
                  <NumericField
                    label={`Component ${index + 1} offset north (°)`}
                    path={[...componentPath, "offset_deg", 1]}
                    value={component.offset_deg[1]}
                    inputValues={numberInputs}
                    onChange={updateNumber}
                  />
                  <NumericField
                    label={`Component ${index + 1} rotation (°)`}
                    path={[...componentPath, "rotation_deg"]}
                    value={component.rotation_deg}
                    optional
                    inputValues={numberInputs}
                    onChange={updateNumber}
                  />
                </div>
                <button className="button button-quiet" type="button" aria-label={`Remove component ${index + 1}`} onClick={() => removeComponent(index)}>
                  Remove component
                </button>
              </fieldset>
            );
          })}
        </div>
        <button className="button button-outline" type="button" onClick={addComponent}>Add component</button>
      </div>
    );
  } else {
    geometryFields = (
      <GeometryFields
        footprint={rootFootprint}
        path={["footprint"]}
        prefix=""
        inputValues={numberInputs}
        onNumberChange={updateNumber}
        onAddVertex={() => addPolygonVertex(["footprint"])}
        onRemoveVertex={(index) => removePolygonVertex(["footprint"], index)}
      />
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className="instrument-profile-editor"
      aria-labelledby="instrument-profile-editor-title"
      aria-describedby="instrument-profile-editor-description"
      onCancel={handleDialogCancel}
    >
      <div className="instrument-profile-editor-shell">
        <header className="instrument-profile-editor-header">
          <div>
            <h2 id="instrument-profile-editor-title">{stage === "instrument" ? "Create instrument profile" : "Create survey profile"}</h2>
            <p id="instrument-profile-editor-description">{stage === "instrument" ? "Step 1 · Instrument geometry. Continue to survey policies when the instrument is valid." : "Step 2 · Survey policies. Validate the complete profile, then add it or download JSON."}</p>
          </div>
          <button className="button button-quiet" type="button" aria-label="Cancel profile authoring" onClick={onCancel}>Close</button>
        </header>
        <div className="profile-authoring-stage" hidden={stage !== "instrument"}>
        <div className="instrument-profile-editor-content">
          <section className="instrument-editor-section" aria-labelledby="instrument-identity-heading">
            <h3 id="instrument-identity-heading">Instrument identity</h3>
            <div className="instrument-editor-grid">
              <label className="instrument-editor-field">
                <span>Instrument ID</span>
                <input
                  autoFocus
                  type="text"
                  autoComplete="off"
                  value={instrumentDraft.id}
                  aria-label="Instrument ID"
                  onChange={(event) => updateInstrumentField("id", event.currentTarget.value)}
                />
              </label>
              <label className="instrument-editor-field">
                <span>Display name</span>
                <input type="text" autoComplete="off" value={instrumentDraft.display_name} aria-label="Display name"
                  onChange={(event) => updateInstrumentField("display_name", event.currentTarget.value)} />
              </label>
              <label className="instrument-editor-field instrument-editor-description-field">
                <span>Description · optional</span>
                <textarea rows={2} value={instrumentDraft.description ?? ""} aria-label="Instrument description"
                  onChange={(event) => updateDescription(event.currentTarget.value)} />
              </label>
            </div>
            <p className="instrument-editor-help">ID is the exact Schema v2 and registry identifier. Coordinate frame is fixed to ICRS. Geometry starts with editable examples (rectangle: 1° × 1°); set your instrument dimensions.</p>
          </section>

          <section className="instrument-editor-section" aria-labelledby="instrument-footprint-heading">
            <div className="instrument-editor-section-heading">
              <h3 id="instrument-footprint-heading">Instrument footprint</h3>
              <span>{rootFootprint.type.toUpperCase()}</span>
            </div>
            <label className="instrument-editor-field instrument-editor-type-field">
              <span>Footprint type</span>
              <select aria-label="Footprint type" value={rootFootprint.type}
                onChange={(event) => changeRootFootprint(event.currentTarget.value as FootprintType)}>
                {Object.entries(FOOTPRINT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <div className="instrument-editor-summary" aria-label="Instrument footprint summary">
              {footprintSummary(rootFootprint, true)}
            </div>
            {geometryFields}
          </section>

          <section className="instrument-editor-validation" aria-label="Instrument validation preview">
            <p className={validation.instrument ? "is-valid" : "is-invalid"} role={validation.instrument ? "status" : "alert"}>
              {validation.instrument ? "Instrument valid" : validation.error}
            </p>
            {validation.instrument && <p className="instrument-editor-validity-note">This checks the instrument only. A complete survey is still required before this draft can be registered.</p>}
          </section>
        </div>
        <footer className="instrument-profile-editor-footer">
          <button className="button button-quiet" type="button" onClick={resetDraft}>Reset draft</button>
          <button className="button button-outline" type="button" onClick={onCancel}>Cancel</button>
          <button className="button button-primary" type="button" disabled={!validation.instrument} onClick={() => { setSurveyStarted(true); setStage("survey"); }}>Continue to survey</button>
        </footer>
        </div>
        {surveyStarted && <div className="profile-authoring-stage" hidden={stage !== "survey"}>
          <SurveyProfileEditor instrument={instrumentDraft} onBack={() => setStage("instrument")} onCancel={onCancel} onRegister={onRegister} />
        </div>}
      </div>
    </dialog>
  );
}
