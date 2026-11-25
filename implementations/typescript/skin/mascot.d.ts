// The types of `mascot.js` beside it, which the page's build inlines as it is written.

/** A face of the mascot's. */
export type FaceName = 'listening' | 'focused' | 'surprised' | 'happy' | 'mischief' | 'serene';

/**
 * A face on the skeleton every face shares: each eye `[cx, cy, rx, top, bottom]`, each pupil
 * `[x, y, r]`, each brow `[x1, y1, cx, cy, x2, y2, opacity]`, the mouth `[lx, ly, rx, ry, ux, uy,
 * dx, dy]` and the monocle `[opacity]`.
 */
export interface IFace {
  readonly eL: readonly number[];
  readonly eR: readonly number[];
  readonly pL: readonly number[];
  readonly pR: readonly number[];
  readonly bL: readonly number[];
  readonly bR: readonly number[];
  readonly m: readonly number[];
  readonly g: readonly number[];
}

/** A section as the reading sees it: where it starts on the page, how tall it is, and its face. */
export interface ISectionBox {
  readonly top: number;
  readonly height: number;
  readonly face: FaceName | null;
}

/** A face at a point of the page's axis. */
export interface IKeyframe {
  readonly at: number;
  readonly face: FaceName;
}

/** The face at the reading line: `t` of the way from `from` to `to`. */
export interface IReading {
  readonly from: FaceName;
  readonly to: FaceName;
  readonly t: number;
}

/** How far a blend goes from its first face to its second, from 0 to 1. */
export interface IBlendOptions {
  readonly by: number;
}

/** Whether the visitor asked for reduced motion. */
export interface IMotionOptions {
  readonly reduced?: boolean;
}

/** A bead of the mark, during an eclipse. */
export interface IBeadAt {
  readonly opacity: number;
  readonly radius: number;
}

/** The eclipse at an instant: each bead, the flare, the corona and the faces it lends. */
export interface IEclipse {
  readonly beads: readonly IBeadAt[];
  readonly flare: number;
  readonly corona: number;
  readonly mischief: number;
  readonly serene: number;
}

/** Where the mascot reads a page, each a selector. */
export interface IMascotOptions {
  /** The sections, a face each by `data-bead-face`. */
  readonly sections?: string;
  /** The text's column: the mascot stands beside it, where the page leaves room. */
  readonly content?: string;
  /** What may widen past the column, which the mascot slides clear of. */
  readonly avoid?: string;
  /** The bar it stands in where no room is left beside the column. */
  readonly dock?: string;
}

/** The mascot on a page. */
export interface IMascot {
  /** Gives it `face` for a moment. */
  readonly react: (face: FaceName) => void;
  /** Takes it off the page. */
  readonly destroy: () => void;
}

export declare const FACES: Readonly<Record<FaceName, IFace>>;
export declare const FACE_NAMES: readonly FaceName[];
export declare const DEFAULT_FACE: FaceName;
export declare const ECLIPSE_MS: number;
export declare const blend: (from: IFace, to: IFace, options: IBlendOptions) => IFace;
export declare const keyframesOf: (sections: readonly ISectionBox[]) => IKeyframe[];
export declare const readingAt: (
  keyframes: readonly IKeyframe[],
  line: number,
  options?: IMotionOptions
) => IReading;
export declare const eclipseAt: (elapsed: number, options?: IMotionOptions) => IEclipse;
export declare const drawFace: (name: FaceName) => SVGSVGElement;
export declare const mountMascot: (options?: IMascotOptions) => IMascot;
