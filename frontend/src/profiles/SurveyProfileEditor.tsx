import { useEffect, useMemo, useState } from "react";
import { downloadProfileDocument } from "../api";
import type { InstrumentProfileV2, SurveyProfileV2 } from "../types";
import { validateProfileDocumentV2, type ProfileDocument } from "./document";
import { NumericField } from "./numeric-input";
import { parsedNumber, replacePath, type NumericPath } from "./numeric-draft";

/** Draft callbacks; registration is the only operation that changes session profiles. */
export interface SurveyProfileEditorProps {
  /** Existing instrument object from the first stage, with no editor conversion. */
  instrument: InstrumentProfileV2;
  onBack: () => void;
  onCancel: () => void;
  /** Receives a strictly validated document; must throw on registration failure. */
  onRegister?: (document: ProfileDocument) => void;
}

// Editable UI examples, not scientific fallbacks. Efficient and epoch are absent.
function createSurveyDraft(instrumentId: string): SurveyProfileV2 {
  return {
    schema_version: 2, id: "", display_name: "", instrument_id: instrumentId,
    tiling: { type: "lattice", basis_deg: [[1, 0], [0, 1]], origin: { type: "region_center" } },
    inference: {
      enabled: false, spacing_tolerance_fraction: 0, phase_tolerance_fraction: 0,
      occupancy_tolerance_fraction: 0, min_anchor_tiles: 1, min_neighbor_pairs: 1, allow_rotation: false,
    },
    coverage: { sampling: { target_samples_per_footprint_axis: 16, max_samples: 10000 } },
    export: { ra_column: "RA", dec_column: "DEC", coordinate_format: "decimal" },
  };
}

/**
 * Complete an instrument draft with canonical Schema v2 survey policies.
 *
 * Basis components are local east/north degrees; fixed anchors are ICRS degrees.
 * Inference tolerances and Efficient thresholds are dimensionless fractions.
 * Numeric keystrokes stay in UI buffers until complete. Only the shared document
 * validator determines scientific validity. Back preserves this local draft;
 * cancel/unmount discards it, and JSON export does not register it.
 *
 * @param props - Instrument and explicit navigation/registration callbacks.
 * @returns Survey fields, strict complete-document preview and explicit actions.
 */
export function SurveyProfileEditor({ instrument, onBack, onCancel, onRegister }: SurveyProfileEditorProps) {
  const [surveyDraft, setSurveyDraft] = useState(() => createSurveyDraft(instrument.id));
  const [numberInputs, setNumberInputs] = useState<Record<string, string>>({});
  const [incompletePaths, setIncompletePaths] = useState<string[]>([]);
  const [newConstantColumn, setNewConstantColumn] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // The reference follows instrument edits on Back; a registry instrument is never selectable here.
  const validation = useMemo(() => {
    if (incompletePaths.length) return { document: null, error: "Finish the numeric field before validating the profile." };
    try {
      return { document: validateProfileDocumentV2({ instrument, survey: { ...surveyDraft, instrument_id: instrument.id } }), error: null };
    } catch (caught) {
      return { document: null, error: caught instanceof Error ? caught.message : "Profile validation failed." };
    }
  }, [instrument, surveyDraft, incompletePaths]);

  useEffect(() => { setActionError(null); setNotice(null); }, [instrument, surveyDraft, numberInputs]);

  function clearNumbers(prefix: string) {
    setNumberInputs((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${prefix}.`))));
    setIncompletePaths((current) => current.filter((key) => !key.startsWith(`${prefix}.`)));
  }

  function updateNumber(path: NumericPath, text: string, optional: boolean) {
    const key = path.join(".");
    setNumberInputs((current) => ({ ...current, [key]: text }));
    const value = parsedNumber(text);
    if (value === undefined && !(optional && text.trim() === "")) {
      setIncompletePaths((current) => current.includes(key) ? current : [...current, key]);
      return;
    }
    setSurveyDraft((current) => replacePath(current, path, value));
    setIncompletePaths((current) => current.filter((entry) => entry !== key));
  }

  const number = (label: string, path: NumericPath, value: number) => (
    <NumericField key={path.join(".")} label={label} path={path} value={value} inputValues={numberInputs} onChange={updateNumber} />
  );
  const text = (label: string, value: string, onChange: (value: string) => void) => (
    <label key={label} className="instrument-editor-field"><span>{label}</span>
      <input type="text" aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
  const checkbox = (label: string, checked: boolean, onChange: (checked: boolean) => void) => (
    <label className="survey-editor-checkbox"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} /><span>{label}</span></label>
  );

  function changeTiling(type: "lattice" | "manual") {
    setSurveyDraft((current) => ({
      ...current,
      tiling: type === "manual" ? { type: "manual" } : createSurveyDraft(instrument.id).tiling,
      inference: type === "manual" ? createSurveyDraft(instrument.id).inference : current.inference,
    }));
    clearNumbers("tiling");
    if (type === "manual") clearNumbers("inference");
  }

  function addConstant() {
    if (Object.hasOwn(surveyDraft.export.constant_fields ?? {}, newConstantColumn)) {
      setActionError(`Constant field "${newConstantColumn}" already exists. Edit its value or remove it first.`);
      return;
    }
    setSurveyDraft((current) => ({ ...current, export: {
      ...current.export, constant_fields: Object.fromEntries([...Object.entries(current.export.constant_fields ?? {}), [newConstantColumn, ""]]),
    } }));
    setNewConstantColumn("");
  }

  function removeConstant(column: string) {
    setSurveyDraft((current) => {
      const constants = Object.fromEntries(Object.entries(current.export.constant_fields ?? {}).filter(([key]) => key !== column));
      const policy = { ...current.export };
      if (Object.keys(constants).length) policy.constant_fields = constants;
      else delete policy.constant_fields;
      return { ...current, export: policy };
    });
    // Numeric buffers refer to the scalar itself rather than a child field.
    const key = ["export", "constant_fields", column].join(".");
    setNumberInputs((current) => Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key)));
    setIncompletePaths((current) => current.filter((entry) => entry !== key));
  }

  function register() {
    if (!validation.document || !onRegister) return;
    try {
      onRegister(validateProfileDocumentV2(validation.document));
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Profile registration failed.");
    }
  }

  async function download() {
    if (!validation.document) return;
    setDownloading(true);
    setActionError(null);
    try {
      await downloadProfileDocument(validation.document);
      setNotice("Profile JSON downloaded. The draft has not been added to the session.");
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Profile download failed.");
    } finally { setDownloading(false); }
  }

  const { tiling, inference, coverage, export: exportPolicy } = surveyDraft;
  return <>
    <div className="instrument-profile-editor-content">
      <section className="instrument-editor-section" aria-labelledby="survey-identity-heading">
        <h3 id="survey-identity-heading">Survey identity</h3>
        <p className="instrument-editor-help">Instrument: {instrument.display_name} · {instrument.id}. Return to the instrument stage to edit it.</p>
        <div className="instrument-editor-grid">
          {text("Survey ID", surveyDraft.id, (id) => setSurveyDraft((current) => ({ ...current, id })))}
          {text("Survey display name", surveyDraft.display_name, (display_name) => setSurveyDraft((current) => ({ ...current, display_name })))}
          <label className="instrument-editor-field instrument-editor-description-field"><span>Survey description · optional</span>
            <textarea rows={2} aria-label="Survey description" value={surveyDraft.description ?? ""} onChange={(event) => {
              const description = event.currentTarget.value;
              setSurveyDraft((current) => { const next = { ...current }; if (description === "") delete next.description; else next.description = description; return next; });
            }} />
          </label>
        </div>
      </section>
      <section className="instrument-editor-section" aria-labelledby="survey-tiling-heading">
        <h3 id="survey-tiling-heading">Tiling and origin</h3>
        <label className="instrument-editor-field instrument-editor-type-field"><span>Tiling strategy</span>
          <select aria-label="Tiling strategy" value={tiling.type} onChange={(event) => changeTiling(event.currentTarget.value as "lattice" | "manual")}>
            <option value="lattice">Lattice</option><option value="manual">Manual</option>
          </select>
        </label>
        <p className="instrument-editor-help">Legacy S-PLUS is a compatibility strategy available through bundled/imported profiles.</p>
        {tiling.type === "lattice" && <>
          <p className="instrument-editor-help">Basis vectors use local east/north degrees and determine spacing and orientation. The editable starter is a 1° square lattice.</p>
          <div className="instrument-editor-grid">
            {number("Basis 1 east (°)", ["tiling", "basis_deg", 0, 0], tiling.basis_deg[0][0])}
            {number("Basis 1 north (°)", ["tiling", "basis_deg", 0, 1], tiling.basis_deg[0][1])}
            {number("Basis 2 east (°)", ["tiling", "basis_deg", 1, 0], tiling.basis_deg[1][0])}
            {number("Basis 2 north (°)", ["tiling", "basis_deg", 1, 1], tiling.basis_deg[1][1])}
          </div>
          <label className="instrument-editor-field instrument-editor-type-field"><span>Lattice origin</span>
            <select aria-label="Lattice origin" value={tiling.origin.type} onChange={(event) => {
              const origin = event.currentTarget.value === "fixed_anchor" ? { type: "fixed_anchor" as const, ra_deg: 0, dec_deg: 0 } : { type: "region_center" as const };
              setSurveyDraft((current) => replacePath(current, ["tiling", "origin"], origin)); clearNumbers("tiling.origin");
            }}><option value="region_center">Region center</option><option value="fixed_anchor">Fixed ICRS anchor</option></select>
          </label>
          {tiling.origin.type === "fixed_anchor" && <>
            <p className="instrument-editor-help">Set the ICRS anchor in degrees. The editable starter is RA 0°, DEC 0°.</p>
            <div className="instrument-editor-grid">
              {number("Anchor RA (°)", ["tiling", "origin", "ra_deg"], tiling.origin.ra_deg)}
              {number("Anchor DEC (°)", ["tiling", "origin", "dec_deg"], tiling.origin.dec_deg)}
            </div>
          </>}
        </>}
        {tiling.type === "manual" && <p className="instrument-editor-help">Coverage accounting and manual/imported pointings work. Automatic region tiling and lattice inference are unavailable.</p>}
      </section>
      <section className="instrument-editor-section" aria-labelledby="survey-inference-heading">
        <h3 id="survey-inference-heading">Inference policy</h3>
        {tiling.type === "manual" ? <p className="instrument-editor-help">Inference is disabled for this manual survey.</p> : <>
          {checkbox("Enable lattice inference", inference.enabled, (enabled) => setSurveyDraft((current) => ({ ...current, inference: { ...current.inference, enabled } })))}
          <p className="instrument-editor-help">Dimensionless fractions relative to lattice spacing. Starters are zero tolerances and one anchor/pair; choose tolerances and evidence requirements for your survey.</p>
          <div className="instrument-editor-grid">
            {number("Spacing tolerance fraction", ["inference", "spacing_tolerance_fraction"], inference.spacing_tolerance_fraction)}
            {number("Phase tolerance fraction", ["inference", "phase_tolerance_fraction"], inference.phase_tolerance_fraction)}
            {number("Occupancy tolerance fraction", ["inference", "occupancy_tolerance_fraction"], inference.occupancy_tolerance_fraction)}
            {number("Minimum anchor tiles", ["inference", "min_anchor_tiles"], inference.min_anchor_tiles)}
            {number("Minimum neighbor pairs", ["inference", "min_neighbor_pairs"], inference.min_neighbor_pairs)}
          </div>
          {checkbox("Allow inference rotation", inference.allow_rotation, (allow_rotation) => setSurveyDraft((current) => ({ ...current, inference: { ...current.inference, allow_rotation } })))}
        </>}
      </section>
      <section className="instrument-editor-section" aria-labelledby="survey-coverage-heading">
        <h3 id="survey-coverage-heading">Coverage policy</h3>
        <p className="instrument-editor-help">Samples per footprint axis control relative numerical resolution. Maximum samples limits the browser budget. Editable starters: 16 per axis, 10,000 total.</p>
        <div className="instrument-editor-grid">
          {number("Target samples per footprint axis", ["coverage", "sampling", "target_samples_per_footprint_axis"], coverage.sampling.target_samples_per_footprint_axis)}
          {number("Maximum coverage samples", ["coverage", "sampling", "max_samples"], coverage.sampling.max_samples)}
        </div>
        {checkbox("Include Efficient policy", !!coverage.efficient, (enabled) => {
          setSurveyDraft((current) => {
            const next = { ...current.coverage };
            if (enabled) next.efficient = { min_coverage: 0.9, min_marginal_efficiency: 0.1 }; else delete next.efficient;
            return { ...current, coverage: next };
          }); clearNumbers("coverage.efficient");
        })}
        {coverage.efficient && <>
          <p className="instrument-editor-help">Editable starter fractions: 0.9 minimum coverage and 0.1 minimum marginal efficiency. Complete uses its existing algorithm without additional policy fields.</p>
          <div className="instrument-editor-grid">
            {number("Efficient minimum coverage", ["coverage", "efficient", "min_coverage"], coverage.efficient.min_coverage)}
            {number("Efficient minimum marginal efficiency", ["coverage", "efficient", "min_marginal_efficiency"], coverage.efficient.min_marginal_efficiency)}
          </div>
        </>}
      </section>
      <section className="instrument-editor-section" aria-labelledby="survey-export-heading">
        <h3 id="survey-export-heading">Export policy</h3>
        <p className="instrument-editor-help">The active survey uses this policy for pointing CSV downloads. PA requires an explicitly declared camera orientation; lattice rotation is independent.</p>
        <div className="instrument-editor-grid">
          {text("RA output column", exportPolicy.ra_column, (value) => setSurveyDraft((current) => replacePath(current, ["export", "ra_column"], value)))}
          {text("DEC output column", exportPolicy.dec_column, (value) => setSurveyDraft((current) => replacePath(current, ["export", "dec_column"], value)))}
          <label className="instrument-editor-field"><span>Export coordinate format</span>
            <select aria-label="Export coordinate format" value={exportPolicy.coordinate_format} onChange={(event) => {
              const value = event.currentTarget.value; setSurveyDraft((current) => replacePath(current, ["export", "coordinate_format"], value));
            }}><option value="decimal">Decimal</option><option value="sexagesimal">Sexagesimal</option></select>
          </label>
        </div>
        {checkbox("Include epoch policy", !!exportPolicy.epoch, (enabled) => setSurveyDraft((current) => replacePath(current, ["export", "epoch"], enabled ? { column: "EPOCH", default: "", allowed: [] } : undefined)))}
        {exportPolicy.epoch && <div className="instrument-editor-grid">
          {text("Epoch output column", exportPolicy.epoch.column, (value) => setSurveyDraft((current) => replacePath(current, ["export", "epoch", "column"], value)))}
          {text("Default export epoch", exportPolicy.epoch.default, (value) => setSurveyDraft((current) => replacePath(current, ["export", "epoch", "default"], value)))}
          <label className="instrument-editor-field"><span>Allowed export epochs · one per line</span>
            <textarea rows={3} aria-label="Allowed export epochs" value={exportPolicy.epoch.allowed.join("\n")} onChange={(event) => {
              const value = event.currentTarget.value.split("\n"); setSurveyDraft((current) => replacePath(current, ["export", "epoch", "allowed"], value));
            }} />
          </label>
        </div>}
        {text("Position angle output column · optional", exportPolicy.position_angle_column ?? "", (value) => setSurveyDraft((current) => replacePath(current, ["export", "position_angle_column"], value === "" ? undefined : value)))}
        <h4>Generated identifiers · optional</h4>
        <p className="instrument-editor-help">ID uses acceptance order (PROPOSED_0001); name uses the proposal name or ID; group uses the survey ID. Source PID and runtime IDs are never copied.</p>
        <div className="instrument-editor-grid">
          {(["id", "name", "group"] as const).map((semantic) => text(`${semantic.toUpperCase()} output column · optional`, exportPolicy.identifiers?.[`${semantic}_column`] ?? "", (value) => {
            setSurveyDraft((current) => {
              const identifiers = { ...current.export.identifiers };
              if (value === "") delete identifiers[`${semantic}_column`]; else identifiers[`${semantic}_column`] = value;
              const policy = { ...current.export };
              if (Object.keys(identifiers).length) policy.identifiers = identifiers; else delete policy.identifiers;
              return { ...current, export: policy };
            });
          }))}
        </div>
        <h4>Constant fields</h4>
        <p className="instrument-editor-help">Add column keys with string, finite number or boolean values. Remove a key to replace its name.</p>
        {Object.entries(exportPolicy.constant_fields ?? {}).map(([column, value]) => <div className="survey-editor-constant" key={column}>
          <strong>{column || "(empty key)"}</strong>
          <label className="instrument-editor-field"><span>Value type</span>
            <select aria-label={`Constant ${column} type`} value={typeof value} onChange={(event) => {
              const replacement = event.currentTarget.value === "number" ? 0 : event.currentTarget.value === "boolean" ? false : "";
              setSurveyDraft((current) => replacePath(current, ["export", "constant_fields", column], replacement));
              const key = ["export", "constant_fields", column].join(".");
              setNumberInputs((current) => Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key)));
              setIncompletePaths((current) => current.filter((entry) => entry !== key));
            }}><option value="string">String</option><option value="number">Number</option><option value="boolean">Boolean</option></select>
          </label>
          {typeof value === "number" ? number(`Constant ${column} value`, ["export", "constant_fields", column], value)
            : typeof value === "boolean" ? checkbox(`Constant ${column} value`, value, (next) => setSurveyDraft((current) => replacePath(current, ["export", "constant_fields", column], next)))
            : text(`Constant ${column} value`, value, (next) => setSurveyDraft((current) => replacePath(current, ["export", "constant_fields", column], next)))}
          <button type="button" className="button button-quiet" aria-label={`Remove constant ${column}`} onClick={() => removeConstant(column)}>Remove</button>
        </div>)}
        <div className="instrument-editor-grid">
          {text("New constant column", newConstantColumn, setNewConstantColumn)}
          <button className="button button-outline" type="button" onClick={addConstant}>Add constant field</button>
        </div>
      </section>
      <section className="instrument-editor-validation" aria-label="Complete profile validation">
        <p className={validation.document ? "is-valid" : "is-invalid"} role={validation.document ? "status" : "alert"}>{validation.document ? "Profile valid" : validation.error}</p>
        <p className="instrument-editor-validity-note">The session changes only after Add profile. Download profile JSON works without registration.</p>
        {actionError && <p className="is-invalid" role="alert">{actionError}</p>}
        {notice && <p role="status">{notice}</p>}
      </section>
    </div>
    <footer className="instrument-profile-editor-footer">
      <button className="button button-quiet" type="button" onClick={onBack}>Back to instrument</button>
      <button className="button button-outline" type="button" onClick={onCancel}>Cancel</button>
      <button className="button button-outline" type="button" disabled={!validation.document || downloading} onClick={() => void download()}>Download profile JSON</button>
      <button className="button button-primary" type="button" disabled={!validation.document || !onRegister || downloading} onClick={register}>Add profile</button>
    </footer>
  </>;
}
