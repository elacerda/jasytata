import { useState } from "react";
import { parseSkyCoordinate } from "./science/coordinates";
import type { CenterInput } from "./types";

interface ReferenceCoordinateProps {
  marker: Pick<CenterInput, "ra_deg" | "dec_deg"> | null;
  onChange: (marker: ReferenceCoordinateProps["marker"]) => void;
}

/** Author a visual reference coordinate independently of pointings and regions.
 * @param props - Session marker and its dedicated state setter.
 * @returns Collapsible labelled coordinate fields with local validation errors.
 */
export function ReferenceCoordinate({ marker, onChange }: ReferenceCoordinateProps) {
  const [ra, setRa] = useState("");
  const [dec, setDec] = useState("");
  const [error, setError] = useState<string | null>(null);
  return <details className="reference-coordinate">
    <summary>Reference coordinate{marker ? " · marker set" : ""}</summary>
    <p className="scientific-help">Visual aid only. Decimal degrees or sexagesimal: RA hours, Dec degrees; colon or three space-separated fields.</p>
    <form noValidate onSubmit={(event) => {
      event.preventDefault();
      try { onChange(parseSkyCoordinate(ra, dec)); setError(null); }
      catch (caught) { setError(caught instanceof Error ? caught.message : "Check RA and Dec."); }
    }}>
      <div className="coordinate-fields">
        <label className="coordinate-field"><span>Reference RA</span><input value={ra} required onChange={(event) => setRa(event.target.value)} /></label>
        <label className="coordinate-field"><span>Reference Dec</span><input value={dec} required onChange={(event) => setDec(event.target.value)} /></label>
      </div>
      {error && <p className="coordinate-error" role="alert">{error}</p>}
      <div className="region-actions">
        <button className="button button-outline" type="submit">Place marker</button>
        <button className="button button-quiet" type="button" disabled={!marker} onClick={() => { onChange(null); setError(null); }}>Clear marker</button>
      </div>
    </form>
  </details>;
}
