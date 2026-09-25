# Profile Schema v2

Schema v2 separates an instrument's physical geometry from a survey's planning
and data policies. An instrument profile describes the camera and its footprint;
a survey profile references an instrument and describes tiling, inference,
coverage, and export choices. This lets one instrument support multiple survey
policies without duplicating its geometry.

## Coordinates and footprints

Instrument positions use the canonical ICRS celestial frame. Footprint vertices
and component offsets use a local tangent plane centered on the telescope
pointing, in degrees as `[east, north]`. Position angles and component rotations
are astronomical degrees east of north: PA 0° leaves local north unchanged,
and positive PA rotates local north toward east. These conventions define the
data contract.

The `Footprint` discriminated union supports rectangles, circles, polygons, and
compound footprints. Rectangle width and height and circle radius are angular
degrees. Polygon vertices are distinct east/north offsets and describe a simple
closed boundary whose final edge back to the first vertex is implicit.

A compound footprint is a union of child footprints. Each child is translated
by its local east/north offset and may be rotated about its own center. An
optional compound PA rotates both the child offsets and child shapes; each
child's rotation then composes with the parent PA. Child footprints cannot
themselves be compound in v2, so detector gaps can be represented without
recursive mosaics.

## Gate 3 geometry behavior

The shared footprint engine uses the local tangent-plane model above for point
coverage, region intersection, physical area, and display boundaries. Rectangle
containment uses width and height; circle containment uses exact local distance
and its area is `πr²`; polygon containment uses an even-odd crossing rule and
absolute shoelace area. Polygon vertex order is retained. A point on a polygon
edge or vertex counts as inside.

Compound coverage and display are the union of child detector shapes. Gaps
between components stay uncovered. Compound area is a deterministic adaptive
estimate of the union, so overlapping children are not double-counted; its
boundary-cell resolution is 1/4096 of the compound bounding-box scale. Circle
boundaries are sampled for display only; their containment and area do not use
those samples.

Local offsets are translated to ICRS using wrapped RA and a tangent
approximation scaled by `max(cos(DEC), 0.01)`. This avoids a singular RA scale
near the poles and preserves RA-zero wrapping, but it is not exact spherical
geometry. Region intersection and rendered boundaries share this projection;
no celestial polygon clipping is performed.

## Survey policies

`TilingModel` is generic: `legacy_splus` names the published compatibility
strategy, `manual` requests no generated lattice, and `lattice` stores two
independent tangent-plane basis vectors. Each lattice vector is `[east, north]`
in degrees. Rectangular, staggered, and hexagonal layouts can be represented by
choosing different basis vectors; they are not separate scientific model types.
The origin policy describes how the lattice phase is chosen.

`InferencePolicy` holds scale-independent tolerances, evidence counts, and the
rotation allowance. `CoveragePolicy` holds target sampling density, a sample
cap, and optional Efficient stopping thresholds. `ExportPolicy` describes
coordinate columns and format, optional epoch and position-angle columns, and
constant output fields.

## Bundled T80/S-PLUS pair

`T80_SOUTH_INSTRUMENT_V2` defines the ICRS T80-South camera with a rectangular
1.4° × 1.4° footprint. `SPLUS_SURVEY_V2` references that instrument and selects
`legacy_splus`. It records inference fractions expressed against the 1.4° T80
footprint, the current three-anchor/two-neighbor minimum, the existing 140
samples-per-axis and 90,000-sample cap, current Efficient thresholds, and the
RA/DEC/EPOCH export contract with epoch `2000`.

`adaptT80SplusV2ToV1` is transitional compatibility infrastructure. It maps the
bundled instrument and survey back to the existing `TilingProfile`, including
the legacy 120 arcsecond effective overlap. The production planner remains on
the v1 profile contract in this gate.

## Gate 1 boundary

Gate 1 validates and serializes the schema only. It does not implement masks or
rendering for the new footprint types, generic lattice generation, profile-based
inference thresholds, configurable coverage sampling, or generic CSV output.
Planner, coverage, geometry, catalogue, rendering, and export behavior remain
the v0.2.0 production behavior. Scientific migration is deferred to later gates.
