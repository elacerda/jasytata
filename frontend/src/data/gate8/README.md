# Gate 8 validation fixtures

These are test documents, not bundled presets. T80 uses the actual
`profiles/splus-t80-south.json` and the frozen `golden.json`,
`planner-contract.json`, and `public/data/tiles_nc.csv` data.

Every document is parsed with `parseProfileJson`, canonically serialized,
reparsed, and registered through `registerProfileDocument`. B is additionally
authored through the two browser editors. B–D are imported through the actual
App file controls before planning and downloading.

| File | Instrument | Declared lattice (local east/north degrees) | Region center (ICRS degrees) |
| --- | --- | --- | --- |
| `circle.json` | Circle, radius 0.08°; diameter 9.6 arcmin | `(0.1,0)`, `(0,0.1)` | `(0,-32)` |
| `mosaic.json` | Two detectors: rectangle + polygon; parent PA 31°; child rotations +12°/−8°; offsets `(-0.22,0)`, `(0.22,0.03)` | Orthogonal 0.17°/0.15° vectors rotated clockwise 11° | `(150,-25)` |
| `triangular.json` | Circle, radius 0.6° | `(0.8,0)`, `(0.4,0.4√3)` | `(75,42)` |

Catalogue CSVs contain only canonical `ra_deg,dec_deg,quality`, never PID.
Their local lattice indices are `(-1,-1),(0,-1),(2,-1),(-1,0),(0,0),(2,0),
(-1,2),(0,2),(2,2)`: missing row/column 1 introduces harmonic separations.
All use fractional phase `(0.2,0.3)`. B applies an additional clockwise 13°
rotation; C applies 7° (total lattice orientation 18°); D applies none.
Coordinates use the existing local projection convention
`RA = wrap(RA0 + east/cos(DEC0)), DEC = DEC0 + north`, rounded to 12 decimals.
These modest local regions deliberately stay within the published support model.

`results.json` is a small, asserted record of observed candidate/proposal counts,
sampling, inference, Efficient coverage and the first export row. It does not
replace the independent reference coverage checks or frozen T80 expectations.
Runtime logs print the same concise metrics. See
[`docs/legacy/GATE8_AGNOSTICISM_VALIDATION.md`](../../../../docs/legacy/GATE8_AGNOSTICISM_VALIDATION.md)
for the integration results and limitations.

Run the matrix from `frontend`:

```sh
npm test -- src/science/gate8-matrix.test.ts src/science/gate8-area-regression.test.ts src/App.gate8.test.tsx src/AladinMap.gate8.test.tsx
```
