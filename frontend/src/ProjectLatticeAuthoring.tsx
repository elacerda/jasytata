import { useState, type FormEvent } from "react";
import { parseSkyCoordinate } from "./science/coordinates";
import type { ProjectLatticePreviewResult } from "./science/project-lattice-preview";
import { projectAngularToDegrees } from "./science/project-lattice-preview";
import type { ProjectPlanningMode } from "./profiles/planning-capabilities";
import type { LatticeProjectPlacement, ProjectLatticeAuthoring as ProjectLatticeAuthoringPolicy, ProjectLatticeRotation, ProjectPlacementPolicy } from "./types";

type Preset = "" | "rectangular" | "triangular" | "advanced_basis";
type Unit = "deg" | "arcmin" | "arcsec";
type RotationMode = "" | ProjectLatticeRotation["mode"];
type OriginMode = "" | "region_center" | "fixed_anchor";

interface ProjectLatticeAuthoringProps {
  mode: ProjectPlanningMode;
  onModeChange: (mode: ProjectPlanningMode) => void;
  canAuthor: boolean;
  canPreview: boolean;
  unavailableReason: string | null;
  footprintNotice: string | null;
  effectiveInstrumentPA?: number;
  placement: ProjectPlacementPolicy | null;
  preview: ProjectLatticePreviewResult | null;
  disabled: boolean;
  onDraftChange: () => void;
  onApply: (policy: LatticeProjectPlacement) => void;
  onPreview: (policy: LatticeProjectPlacement) => void;
}

interface Draft {
  preset: Preset;
  unit: Unit;
  eastSpacing: string;
  northSpacing: string;
  pitch: string;
  vector1East: string;
  vector1North: string;
  vector2East: string;
  vector2North: string;
  rotationMode: RotationMode;
  rotation: string;
  originMode: OriginMode;
  anchorRa: string;
  anchorDec: string;
}

const INITIAL_DRAFT: Draft = {
  preset: "", unit: "arcsec", eastSpacing: "", northSpacing: "", pitch: "",
  vector1East: "", vector1North: "", vector2East: "", vector2North: "",
  rotationMode: "", rotation: "", originMode: "", anchorRa: "", anchorDec: "",
};

function draftFromPlacement(placement: ProjectPlacementPolicy | null): Draft {
  if (!placement || placement.type !== "lattice_project_placement") return INITIAL_DRAFT;
  const authoring = placement.authoring;
  return {
    ...INITIAL_DRAFT,
    unit: "deg",
    preset: authoring.preset,
    ...(authoring.preset === "rectangular" ? {
      eastSpacing: String(authoring.east_spacing_deg),
      northSpacing: String(authoring.north_spacing_deg),
    } : {}),
    ...(authoring.preset === "triangular" ? { pitch: String(authoring.pitch_deg) } : {}),
    ...(authoring.preset === "advanced_basis" ? {
      vector1East: String(authoring.basis_deg[0][0]),
      vector1North: String(authoring.basis_deg[0][1]),
      vector2East: String(authoring.basis_deg[1][0]),
      vector2North: String(authoring.basis_deg[1][1]),
    } : {}),
    rotationMode: placement.rotation.mode,
    rotation: placement.rotation.mode === "independent" ? String(placement.rotation.rotation_deg) : "",
    originMode: placement.origin.type,
    anchorRa: placement.origin.type === "fixed_anchor" ? String(placement.origin.ra_deg) : "",
    anchorDec: placement.origin.type === "fixed_anchor" ? String(placement.origin.dec_deg) : "",
  };
}

function parseFiniteDraft(value: string, label: string): number {
  if (!value.trim()) throw new Error(`${label} is required.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number.`);
  return parsed;
}

function buildPolicy(draft: Draft): LatticeProjectPlacement {
  if (!draft.preset) throw new Error("Choose a project lattice authoring mode.");
  if (!draft.rotationMode) throw new Error("Choose Independent or Follow instrument PA for lattice rotation.");
  if (!draft.originMode) throw new Error("Choose Region center or Fixed sky coordinate for the lattice origin.");

  let authoring: ProjectLatticeAuthoringPolicy;
  if (draft.preset === "rectangular") {
    authoring = {
      preset: "rectangular",
      east_spacing_deg: projectAngularToDegrees(parseFiniteDraft(draft.eastSpacing, "East spacing"), draft.unit),
      north_spacing_deg: projectAngularToDegrees(parseFiniteDraft(draft.northSpacing, "North spacing"), draft.unit),
    };
  } else if (draft.preset === "triangular") {
    authoring = {
      preset: "triangular",
      pitch_deg: projectAngularToDegrees(parseFiniteDraft(draft.pitch, "Pitch"), draft.unit),
    };
  } else {
    authoring = {
      preset: "advanced_basis",
      basis_deg: [
        [projectAngularToDegrees(parseFiniteDraft(draft.vector1East, "Vector 1 east"), draft.unit),
          projectAngularToDegrees(parseFiniteDraft(draft.vector1North, "Vector 1 north"), draft.unit)],
        [projectAngularToDegrees(parseFiniteDraft(draft.vector2East, "Vector 2 east"), draft.unit),
          projectAngularToDegrees(parseFiniteDraft(draft.vector2North, "Vector 2 north"), draft.unit)],
      ],
    };
  }

  const rotation: ProjectLatticeRotation = draft.rotationMode === "independent"
    ? { mode: "independent", rotation_deg: parseFiniteDraft(draft.rotation, "Lattice rotation") }
    : { mode: "follow_instrument_pa" };
  const origin = draft.originMode === "region_center"
    ? { type: "region_center" as const }
    : { type: "fixed_anchor" as const, ...parseSkyCoordinate(draft.anchorRa, draft.anchorDec) };
  return { type: "lattice_project_placement", provenance: "user_declared", authoring, rotation, origin };
}

function angularVectorLabel(eastDeg: number, northDeg: number): string {
  const eastArcsec = eastDeg * 3600;
  const northArcsec = northDeg * 3600;
  return `${eastArcsec >= 0 ? "+" : ""}${eastArcsec.toFixed(3)}″ E, ${northArcsec >= 0 ? "+" : ""}${northArcsec.toFixed(3)}″ N`;
}

/** Author project placement drafts and request a deterministic candidate-only preview.
 *
 * Numeric drafts stay local until Apply placement or Preview lattice succeeds. The only emitted
 * policy uses Gate 1's canonical degree units and explicit rotation/origin modes.
 *
 * @param props - Project mode, semantic capabilities, saved policy, preview, and callbacks.
 * @returns Compact project-placement controls and the resolved candidate summary.
 */
export function ProjectLatticeAuthoring(props: ProjectLatticeAuthoringProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFromPlacement(props.placement));
  const [error, setError] = useState<string | null>(null);
  const updateField = (key: keyof Draft, value: string) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    props.onDraftChange();
    setError(null);
  };
  const numericField = (key: keyof Draft, label: string) => (
    <label className="coordinate-field"><span>{label}</span>
      <input type="number" step="any" inputMode="decimal" value={String(draft[key])} disabled={props.disabled}
        onChange={(event) => updateField(key, event.target.value)} />
    </label>
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const policy = buildPolicy(draft);
      const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
      if (action === "apply") props.onApply(policy);
      else props.onPreview(policy);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review the lattice, rotation, origin, and region inputs.");
    }
  }

  const appliedPolicy = props.placement?.type === "lattice_project_placement" ? props.placement : null;
  const appliedPreset = props.preview?.placement ? appliedPolicy?.authoring.preset : null;
  const followPaUnavailable = draft.rotationMode === "follow_instrument_pa" && props.effectiveInstrumentPA === undefined;
  return <section className="project-placement-section" aria-label="Project placement">
    <h3>Project placement</h3>
    {props.canAuthor ? <fieldset className="project-mode-options">
      <legend>Planning mode</legend>
      <label><input type="radio" name="project-planning-mode" value="manual_pointings"
        checked={props.mode === "manual_pointings"} disabled={props.disabled}
        onChange={() => { props.onModeChange("manual_pointings"); setError(null); }} /> Manual pointings</label>
      <label><input type="radio" name="project-planning-mode" value="regional_mosaic"
        checked={props.mode === "regional_mosaic"} disabled={props.disabled}
        onChange={() => { props.onModeChange("regional_mosaic"); setError(null); }} /> Regional mosaic</label>
    </fieldset> : <>
      <p className="scientific-help">Manual pointings remain available.</p>
      {props.unavailableReason && <p className="planning-capability-message">{props.unavailableReason}</p>}
    </>}

    {props.mode === "regional_mosaic" && props.canAuthor && <div className="project-lattice-authoring">
      <p className="scientific-help">User-defined project geometry. Candidate sites are a geometry preview, not a plan.</p>
      {props.footprintNotice && <p className="scientific-help">{props.footprintNotice}</p>}
      <form noValidate onSubmit={submit}>
        <label className="coordinate-field"><span>Project lattice type</span>
          <select value={draft.preset} disabled={props.disabled} onChange={(event) => updateField("preset", event.target.value as Preset)}>
            <option value="">Choose a grid type…</option>
            <option value="rectangular">Rectangular grid</option>
            <option value="triangular">Triangular grid</option>
            <option value="advanced_basis">Advanced basis</option>
          </select>
        </label>
        {draft.preset && <>
          <div className="coordinate-fields">
            {draft.preset === "rectangular" && <>
              {numericField("eastSpacing", "East spacing")}
              {numericField("northSpacing", "North spacing")}
            </>}
            {draft.preset === "triangular" && numericField("pitch", "Pitch · nearest-neighbor spacing")}
            {draft.preset === "advanced_basis" && <>
              {numericField("vector1East", "Vector 1 east")}{numericField("vector1North", "Vector 1 north")}
              {numericField("vector2East", "Vector 2 east")}{numericField("vector2North", "Vector 2 north")}
            </>}
          </div>
          <label className="coordinate-field"><span>Spacing and basis units</span>
            <select value={draft.unit} disabled={props.disabled} onChange={(event) => updateField("unit", event.target.value as Unit)}>
              <option value="deg">deg</option><option value="arcmin">arcmin</option><option value="arcsec">arcsec</option>
            </select>
          </label>
          {draft.preset === "triangular" && <p className="scientific-help">Pitch is the nearest-neighbor center-to-center distance.</p>}
          {draft.preset === "advanced_basis" && <p className="scientific-help">Vectors are east/north offsets; zero, collinear, and near-degenerate bases are rejected.</p>}
        </>}

        <fieldset className="project-placement-options">
          <legend>Lattice rotation</legend>
          <label><input type="radio" name="project-lattice-rotation" value="independent" checked={draft.rotationMode === "independent"}
            disabled={props.disabled} onChange={() => updateField("rotationMode", "independent")} /> Independent</label>
          <label><input type="radio" name="project-lattice-rotation" value="follow_instrument_pa" checked={draft.rotationMode === "follow_instrument_pa"}
            disabled={props.disabled} onChange={() => updateField("rotationMode", "follow_instrument_pa")} /> Follow instrument PA</label>
        </fieldset>
        {draft.rotationMode === "independent" && numericField("rotation", "Lattice rotation · degrees east of north")}
        {draft.rotationMode === "follow_instrument_pa" && <p className="scientific-help" role="status">
          {props.effectiveInstrumentPA === undefined
            ? "The active instrument PA is unresolved. Resolve it before previewing."
            : `Instrument PA: ${props.effectiveInstrumentPA.toFixed(3)}°. The project lattice will follow this PA.`}
        </p>}

        <fieldset className="project-placement-options">
          <legend>Origin</legend>
          <label><input type="radio" name="project-lattice-origin" value="region_center" checked={draft.originMode === "region_center"}
            disabled={props.disabled} onChange={() => updateField("originMode", "region_center")} /> Region center</label>
          <label><input type="radio" name="project-lattice-origin" value="fixed_anchor" checked={draft.originMode === "fixed_anchor"}
            disabled={props.disabled} onChange={() => updateField("originMode", "fixed_anchor")} /> Fixed sky coordinate</label>
        </fieldset>
        {draft.originMode === "fixed_anchor" && <>
          <div className="coordinate-fields">
            <label className="coordinate-field"><span>Origin RA</span><input value={draft.anchorRa} disabled={props.disabled}
              onChange={(event) => updateField("anchorRa", event.target.value)} /></label>
            <label className="coordinate-field"><span>Origin Dec</span><input value={draft.anchorDec} disabled={props.disabled}
              onChange={(event) => updateField("anchorDec", event.target.value)} /></label>
          </div>
          <p className="scientific-help">ICRS decimal degrees or supported sexagesimal values (RA hours, Dec degrees).</p>
        </>}
        {error && <p className="coordinate-error" role="alert">{error}</p>}
        {props.unavailableReason && <p className="planning-capability-message" role="status">{props.unavailableReason}</p>}
        {followPaUnavailable && <p className="planning-capability-message" role="status">Follow instrument PA requires a resolved physical instrument PA.</p>}
        <button className="button button-outline button-full" type="submit" value="apply" disabled={props.disabled || !props.canPreview || followPaUnavailable}>Apply placement</button>
        <button className="button button-outline button-full" type="submit" value="preview" disabled={props.disabled || !props.canPreview || followPaUnavailable}>
          Preview lattice
        </button>
      </form>

      {props.preview && appliedPolicy && <div className="project-lattice-summary" aria-label="Resolved project lattice preview">
        <strong>User-defined {appliedPreset === "advanced_basis" ? "advanced-basis" : appliedPreset} grid</strong>
        <span>Basis v1: {angularVectorLabel(...props.preview.placement.basis_deg[0])}</span>
        <span>Basis v2: {angularVectorLabel(...props.preview.placement.basis_deg[1])}</span>
        <span>Rotation: {props.preview.placement.lattice_rotation_deg.toFixed(3)}°
          {props.preview.placement.rotation_mode === "follow_instrument_pa" ? " · follows instrument PA" : " · independent"}</span>
        <span>Origin: {props.preview.placement.origin.type === "region_center" ? "Region center" : "Fixed sky coordinate"} · RA {props.preview.placement.resolved_origin.ra_deg.toFixed(6)}°, Dec {props.preview.placement.resolved_origin.dec_deg.toFixed(6)}°</span>
        <strong>{props.preview.candidates.length.toLocaleString()} candidate sites · preview only</strong>
      </div>}
      {!props.preview && appliedPolicy && <p className="planning-capability-message" role="status">
        Project placement is saved; its previous candidate preview is stale. Preview lattice again.
      </p>}
    </div>}
  </section>;
}
