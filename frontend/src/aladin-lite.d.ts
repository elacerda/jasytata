declare module "aladin-lite" {
  /** Aladin source marker; custom tile metadata is stored in `data`. */
  export interface AladinLiteSource {
    data?: Record<string, unknown>;
    ra?: number;
    dec?: number;
    name?: string;
  }

  /** Catalog overlay that renders coordinate-center markers. */
  export interface AladinLiteCatalogue {
    addSources(sources: AladinLiteSource[]): void;
    removeAll(): void;
    /** Toggle native catalogue rendering without deleting source data. */
    show(): void;
    hide(): void;
    remove?(): void;
  }

  /** Graphic overlay for ICRS tile outlines and lattice positions. */
  export interface AladinLiteOverlay {
    add(shape: unknown): void;
    removeAll(): void;
  }

  /** Subset of the Aladin Lite v3 view API used by this application. */
  export interface AladinLiteInstance {
    on(event: string, callback: (value: unknown) => void): void;
    /** Remove all listeners registered for the named event. */
    off?(event: string): void;
    addCatalog(catalogue: AladinLiteCatalogue): void;
    addOverlay(overlay: AladinLiteOverlay): void;
    removeCatalog?(catalogue: AladinLiteCatalogue): void;
    removeOverlay(overlay: AladinLiteOverlay): void;
    /** Convert top-left-origin viewport pixels to ICRS [RA, DEC] degrees. */
    pix2world(x: number, y: number): [number, number] | undefined;
    /** Return current ICRS center coordinates in degrees. */
    getRaDec(): [number, number];
    /** Return current field of view as horizontal and vertical degrees. */
    getFoV(): [number, number];
    /** Enter native polygon selection; Aladin draws the draft and returns pixels. */
    select(
      mode: "poly",
      callback: (selection: { vertices: Array<{ x: number; y: number }> }) => void,
    ): Promise<void>;
    /** Return the viewport to pan mode and cancel any active native selector. */
    fire(event: "default"): void;
    /** Move the view center to ICRS decimal degrees. */
    gotoRaDec(ra: number, dec: number): void;
    /** Set the horizontal field of view in degrees. */
    setFoV(fov: number): void;
    remove(): void;
  }

  /** Constructors exposed by the package default export. */
  const A: {
    init: Promise<void>;
    aladin(container: HTMLElement, options: Record<string, unknown>): AladinLiteInstance;
    /** Create a celestial source from ICRS degrees and associated metadata. */
    source(ra: number, dec: number, data: Record<string, unknown>, options?: Record<string, unknown>): AladinLiteSource;
    catalog(options: Record<string, unknown>): AladinLiteCatalogue;
    graphicOverlay(options: Record<string, unknown>): AladinLiteOverlay;
    polyline(vertices: Array<[number, number]>, options?: Record<string, unknown>): unknown;
    circle(ra: number, dec: number, radius: number, options?: Record<string, unknown>): unknown;
  };

  export default A;
}
