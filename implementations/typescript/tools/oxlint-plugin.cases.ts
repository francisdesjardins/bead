// ── The cases of `bead/options-last` ─────────────────────────────────────────
// A line for each verdict of `oxlint-plugin.mjs`: a line the rule refuses follows a comment of its
// own, `// refused:` and why, and every other line is one it accepts. `check-oxlint-plugin.mjs`
// lints this file alone, through the package's configuration, and fails unless the lines refused
// are exactly the ones marked. The package's own lint leaves it out, and no `tsconfig` includes it.

interface IGoodOptions {
  a?: number;
}

interface IOtherOptions {
  b?: number;
}

interface IClock {
  now: () => number;
}

interface IFailureLike {
  code: number;
}

type EmitterEventMap<E> = { [K in keyof E]: unknown[] };

// ── Two parameters, then the options object ──────────────────────────────────

export const two = (a: number, b: number): number => {
  return a + b;
};
export const twoThenOptions = (a: number, b: number, options?: IGoodOptions): number => {
  return a + b + (options?.a ?? 0);
};
// refused: a third positional
export const thirdPositional = (a: number, b: number, c: number): number => {
  return a + b + c;
};
// refused: a third positional, optional
export const thirdOptional = (a: number, b: number, c?: number): number => {
  return a + b + (c ?? 0);
};
// refused: a third positional, given a default
export const thirdDefault = (a: number, b: number, c = 1): number => {
  return a + b + c;
};
// refused: options not last, and a fourth
export const fourth = (a: number, b: number, o?: IGoodOptions, d?: number): number => {
  return a + b + (o?.a ?? 0) + (d ?? 0);
};

// one optional positional, where no second could come, is review's
export const report = (error: Error, handle?: string): string => {
  return `${error.message} ${handle ?? ''}`;
};

// ── What the options object may be ───────────────────────────────────────────

export const unionUndefined = (
  a: number,
  b: number,
  options?: IGoodOptions | undefined
): number => {
  return a + b + (options?.a ?? 0);
};
export const intersection = (
  a: number,
  b: IClock,
  options?: Pick<IGoodOptions, 'a'> & { x?: 1 }
) => {
  return a + b.now() + (options?.a ?? 0);
};
export const parametersOf = (a: number, b: number, o?: Parameters<typeof twoThenOptions>[2]) => {
  return a + b + (o?.a ?? 0);
};
export const nested = (a: number, b: number, options?: Readonly<Partial<IGoodOptions>>): number => {
  return a + b + (options?.a ?? 0);
};
export const nestedLiteral = (a: number, b: number, o?: Readonly<Partial<{ x?: number }>>) => {
  return a + b + (o?.x ?? 0);
};
export const literal = (a: number, b: number, options?: { x?: number }): number => {
  return a + b + (options?.x ?? 0);
};
export const required = (a: number, b: number, options: { host: string; port?: number }) => {
  return `${String(a + b)} ${options.host}`;
};
export const destructured = (a: number, b: number, { x }: { x?: number } = {}): number => {
  return a + b + (x ?? 0);
};
export const inferred = (a: number, b: number, { x } = { x: 1 }): number => {
  return a + b + x;
};
export const inferredWhole = (a: number, b: number, options = { x: 1 }): number => {
  return a + b + options.x;
};
// refused: optional, of required members
export const ofEssentials = (a: number, b: number, o?: { procedure: string; key: number }) => {
  return a + b + (o?.key ?? 0);
};
// refused: optional, of a required member
export const ofReadonlyEssentials = (a: number, b: number, o?: Readonly<{ key: number }>) => {
  return a + b + (o?.key ?? 0);
};
// refused: given a default, of a required member
export const ofEssentialsGiven = (a: number, b: number, o: { key: number } = { key: 1 }) => {
  return a + b + o.key;
};
// refused: a function, whatever its name
export const callback = (a: number, b: number, callbackOptions?: (x: number) => void): number => {
  callbackOptions?.(a);
  return a + b;
};
// refused: a union with what is no object
export const unionOfOther = (a: number, b: number, options?: IGoodOptions | number): number => {
  return a + b + (typeof options === 'number' ? options : 0);
};

// a callback aliased under a name ending in `Options` passes: syntax cannot see what an alias is,
// and review holds it
export type AliasOptions = (x: number) => void;
export const aliasCallback = (a: number, b: number, options?: AliasOptions): number => {
  options?.(a);
  return a + b;
};

// ── Where the options object goes, and how many ──────────────────────────────

// refused: options first
export const optionsFirst = (options: IGoodOptions | undefined, b?: number): number => {
  return (options?.a ?? 0) + (b ?? 0);
};
// refused: an optional object first
export const optionalFirst = (bag?: { x?: number }, b?: number): number => {
  return (bag?.x ?? 0) + (b ?? 0);
};
// refused: options not last, then a second
export const twoOptions = (a: number, first?: IGoodOptions, second?: IOtherOptions) => {
  return a + (first?.a ?? 0) + (second?.b ?? 0);
};
export const bagFirst = ({ a }: { a: number; b: string }, callback: () => void): number => {
  callback();
  return a;
};
export const failure = (failure: IFailureLike & { origin?: string }, o?: IGoodOptions) => {
  return failure.code + (o?.a ?? 0);
};

// refused: options first, and a second options object after them
export const resolveRequestOptions = (options?: IGoodOptions, defaults: IOtherOptions = {}) => {
  return { ...defaults, ...options };
};

// ── Rests ────────────────────────────────────────────────────────────────────

// refused: a rest tuple of four
export const restTuple = (...[a, b, c, d]: [number, number, number, number]): number => {
  return a + b + c + d;
};
export const restTupleOfOptions = (...[a, b, o]: [number, number, o?: IGoodOptions]) => {
  return a + b + (o?.a ?? 0);
};
export const restOfOptions = (a: number, ...options: [IGoodOptions & { required: number }]) => {
  return a + options[0].required;
};
// refused: optional, of a required member
export const restOfOptional = (a: number, ...o: [o?: IGoodOptions & { required: number }]) => {
  return a + (o[0]?.required ?? 0);
};
// refused: a rest inside a rest tuple
export const restInTuple = (...[a, ...more]: [number, ...number[]]): number => {
  return a + more.length;
};
// refused: a rest of any count, not listed
export const restOfArray = (...values: number[]): number => {
  return values.length;
};

export interface IRequestLike {
  // refused: a rest tuple of four
  (payload: number): (...options: [a: number, b: number, c: number, d: number]) => void;
}

export interface IOtherBound<O extends unknown[]> {
  // refused: a generic rest, not listed
  (...options: O): void;
}

// listed generic rests: where their values are typed is judged
export type EmitterListener<P extends unknown[]> = (...params: P) => void;

export interface IBoundCall<Result, Options extends unknown[]> {
  (...options: Options): Promise<Result>;
}

export const nameAfter = <F extends (...params: never[]) => unknown>(callable: F): F => {
  return callable;
};

// an unannotated rest is the signature it implements, judged where that is typed
export const listener: EmitterListener<[a: number, b: number]> = (...params) => {
  void params;
};

// a rest of a tuple alias of the file is judged at the alias
type Pair = [first: number, second: number];
// refused: a third positional, where the tuple is written
type Triple = [first: number, second: number, third: number];

export const sumPair = (...[a, b]: Pair): number => {
  return a + b;
};
export const sumTriple = (...[a, b, c]: Triple): number => {
  return a + b + c;
};
export const sumTripleAgain = (...[a]: Triple): number => {
  return a;
};

// ── Events ───────────────────────────────────────────────────────────────────

export type ClockEventMap = {
  moved: [from: number, to: number];
  // refused: an event of three values
  stepped: [from: number, to: number, by: number];
  ticked: [at: number];
  // refused: an event of any count
  tickedMany: [...at: number[]];
};

export interface IDoorEventMap {
  closed: [door: string];
  // refused: an event of three values
  opened: [door: string, by: string, at: number];
}

// listed, each to go with the decision on events of three values
export type SessionManagerEventMap = {
  // refused: an event of three values, not listed
  created: [session: string, by: string, at: number];
  dataChanged: [session: string, newValue: number, oldValue: number];
};

// a rest of an event's values is judged at its map
export interface IEmitter<E extends EmitterEventMap<E>> {
  emit<K extends keyof E>(event: K, ...params: E[K]): boolean;
}

export interface IClockEmitter {
  emit<K extends keyof ClockEventMap>(event: K, ...params: ClockEventMap[K]): boolean;
}

export const onMoved = (...[, to]: ClockEventMap['moved']): number => {
  return to;
};

export interface IBag<E extends Record<string, unknown[]>> {
  // refused: a rest indexed into what is no event map
  put<K extends keyof E>(key: K, ...values: E[K]): void;
}

// ── The forms of a signature ─────────────────────────────────────────────────

export abstract class Abstract {
  // refused: a third positional, abstract
  abstract m(a: number, b: number, c: number): void;
  abstract n(a: number, b: number, options?: IGoodOptions): void;
}

export class Overloads {
  // refused: a third positional, an overload
  m(a: number, b: number, c: number): void;
  m(a: number): void;
  // refused: a third positional, optional
  m(a: number, b?: number, c?: number): void {
    void [a, b, c];
  }
}

export class Holder {
  constructor(
    private readonly a: number,
    b: number,
    // refused: a third positional, beside a parameter property
    c: number
  ) {
    void [this.a, b, c];
  }
}

export interface IServerLike {
  // refused: a third positional, a type's method
  listen(port: number, host: string, callback?: () => void): void;
  close(callback?: (error?: Error) => void): void;
}

export interface IMaker {
  // refused: a third positional, a construct signature
  new (a: number, b: number, c: number): object;
}

// refused: a third positional, a function type
export type Listener = (a: number, b: number, c: number) => void;
// refused: a third positional, a constructor type
export type Maker = new (a: number, b: number, c: number) => object;

// refused: a third positional, declared
export declare function declared(a: number, b: number, c: number): void;

// refused: a third positional
export function declaration(a: number, b: number, c: string): string {
  return `${String(a + b)}${c}`;
}

// refused: a third positional
export const expression = function (a: number, b: number, c: string): string {
  return `${String(a + b)}${c}`;
};

export function withThis(this: object, a: number, b: number, options?: IGoodOptions): number {
  void this;
  return a + b + (options?.a ?? 0);
}

// a signature this package does not own takes what it takes, with whose it is
export interface IPlatformLike {
  // oxlint-disable-next-line bead/options-last -- a platform's own, as Node's `listen` is
  listen(port: number, host: string, callback?: () => void): void;
}
