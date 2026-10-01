import { useState } from "react";
import { parseSkyCoordinate } from "./science/coordinates";
import { rectangleRegionFromCenterSize, rectangleRegionFromCorners, type RegionAngularUnit } from "./science/regions";
import type { SkyPolygon } from "./types";

interface RegionAuthoringProps {
  disabled: boolean;
  polygonLabel: string;
  selecting: boolean;
  onPolygon: () => void;
  onCancelPolygon: () => void;
  onApply: (region: SkyPolygon) => void;
}

/** Compact region drafts; only validated submissions reach scientific state.
 * @param props - Capability/busy state and the shared region application boundary.
 * @returns Mode selector with only the active authoring controls exposed.
 */
export function RegionAuthoring(props: RegionAuthoringProps) {
  const [mode, setMode] = useState("polygon");
  const [draft, setDraft] = useState({ ra1: "", dec1: "", ra2: "", dec2: "", ra: "", dec: "", width: "", height: "" });
  const [unit, setUnit] = useState<RegionAngularUnit>("deg");
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof typeof draft, label: string, dimension = false) => (
    <label className="coordinate-field"><span>{label}</span>
      <input value={draft[key]} inputMode={dimension ? "decimal" : "text"} required
        onChange={(event) => setDraft((previous) => ({ ...previous, [key]: event.target.value }))} />
    </label>
  );
  return <div className="region-authoring">
    <label className="coordinate-field"><span>Select region</span>
      <select value={mode} disabled={props.disabled} onChange={(event) => {
        props.onCancelPolygon(); setMode(event.target.value); setError(null);
      }}>
        <option value="polygon">Polygon</option>
        <option value="corners">Rectangle: corners</option>
        <option value="center-size">Rectangle: center + size</option>
      </select>
    </label>
    {mode === "polygon" ? <>
      <button className="button button-outline button-full" disabled={props.disabled} onClick={props.onPolygon}>{props.polygonLabel} · Draw polygon</button>
      {props.selecting && <button className="button button-quiet button-full" onClick={props.onCancelPolygon}>Cancel polygon</button>}
    </> : <form noValidate onSubmit={(event) => {
      event.preventDefault();
      try {
        const region = mode === "corners"
          ? rectangleRegionFromCorners(parseSkyCoordinate(draft.ra1, draft.dec1), parseSkyCoordinate(draft.ra2, draft.dec2))
          : rectangleRegionFromCenterSize({ center: parseSkyCoordinate(draft.ra, draft.dec), width: Number(draft.width), height: Number(draft.height), unit });
        props.onApply(region); setError(null);
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Check the coordinates and rectangle dimensions."); }
    }}>
      <p className="scientific-help">ICRS: decimal degrees or sexagesimal (RA hours, Dec degrees); colon or three space-separated fields.</p>
      <div className="coordinate-fields">
        {mode === "corners" ? <>{field("ra1", "Corner 1 RA")}{field("dec1", "Corner 1 Dec")}{field("ra2", "Corner 2 RA")}{field("dec2", "Corner 2 Dec")}</>
          : <>{field("ra", "Center RA")}{field("dec", "Center Dec")}{field("width", "Width", true)}{field("height", "Height", true)}</>}
      </div>
      {mode === "center-size" && <>
        <label className="coordinate-field"><span>Units</span><select value={unit} onChange={(event) => setUnit(event.target.value as RegionAngularUnit)}>
          <option value="deg">deg</option><option value="arcmin">arcmin</option><option value="arcsec">arcsec</option>
        </select></label>
        <p className="scientific-help">Full east-west width and north-south height at the center. Local approximation; axis aligned.</p>
      </>}
      {error && <p className="coordinate-error" role="alert">{error}</p>}
      <button className="button button-outline button-full" disabled={props.disabled} type="submit">Set region</button>
    </form>}
  </div>;
}
