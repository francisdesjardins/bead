// ── The cases of `check-surface.mjs`'s options, record and tuple rules ───────
// A line for each verdict: a line a rule refuses follows a comment of its own, `// refused:` and
// why, and every other line is one it accepts. `check-surface.mjs --cases` reads this file alone,
// through `surface.cases.tsconfig.json`, and fails unless the lines refused are exactly the ones
// marked: an exported function's or method's options parameter is required exactly when a member
// of its type is, a conditional one by each arm, at most two required; no exported function or
// method takes an inline object that is not its options; and no export takes or gives a tuple, at
// any depth, but a parameter list, every element labeled, or a rest's own. The package's own lint
// and `tsconfig` leave it out.

export interface IAllOptionalOptions {
  a?: number;
  b?: string | undefined;
}

export interface IOneRequiredOptions {
  a?: number;
  server: string;
}

export interface ITwoRequiredOptions {
  host: string;
  port: number;
}

export interface IThreeRequiredOptions {
  host: string;
  path: string;
  port: number;
}

/** Not an options type by its name: a parameter like any other, never judged. */
export interface ISettings {
  a?: number;
}

// ── A function's options ─────────────────────────────────────────────────────

export const optionalOfOptional = (options?: IAllOptionalOptions): number => {
  return options?.a ?? 0;
};
export const defaultOfOptional = (options: IAllOptionalOptions = {}): number => {
  return options.a ?? 0;
};
export const requiredOfRequired = (a: number, options: IOneRequiredOptions): number => {
  return a + options.server.length;
};
export const requiredOfTwo = (options: ITwoRequiredOptions): number => {
  return options.port;
};
export const requiredOfIntersection = (options: IAllOptionalOptions & { node: string }): number => {
  return options.node.length;
};
export const notOptions = (settings: ISettings): number => {
  return settings.a ?? 0;
};
export const lastNotOptions = (options: IAllOptionalOptions, callback: () => void): void => {
  callback();
  void options;
};
export const generic = <O extends IAllOptionalOptions>(options: O): O => {
  return options;
};

export const requiredOfOptional = (
  a: number,
  // refused: options of which every member is optional, required
  options: IAllOptionalOptions
): number => {
  return a + (options.a ?? 0);
};
export const optionalOfRequired = (
  // refused: options with a required member, optional
  options?: IOneRequiredOptions
): number => {
  return options?.server.length ?? 0;
};
export const undefinedOfOptional = (
  // refused: options that may be undefined, yet a parameter to pass
  options: IAllOptionalOptions | undefined
): number => {
  return options?.a ?? 0;
};
export const threeRequired = (
  // refused: three members required, where two are the most
  options: IThreeRequiredOptions
): number => {
  return options.port;
};
export const threeInIntersection = (
  // refused: a third required member, in an intersection
  options: ITwoRequiredOptions & { path: string }
): number => {
  return options.port;
};
export const wrappedRequired = (
  // refused: a wrapper keeps the options named, and all optional
  options: Readonly<IAllOptionalOptions>
): number => {
  return options.a ?? 0;
};

// ── A rest's tuple, and each arm of a conditional one ────────────────────────

type ConnectParameters<O extends IAllOptionalOptions> =
  Record<never, never> extends O ? [options?: O] : [options: O];

export type HookParameters<S> = [S] extends [never]
  ? [options?: IAllOptionalOptions]
  : [options: IOneRequiredOptions];

export type WrongParameters<S> = [S] extends [never]
  ? [options?: IAllOptionalOptions]
  : [options: IAllOptionalOptions];

export const restOfTuple = (...[options]: [options?: IAllOptionalOptions]): number => {
  return options?.a ?? 0;
};
export const hooked = <S>(...[options]: HookParameters<S>): number => {
  return options?.a ?? 0;
};
export const restOfAny = (...values: IAllOptionalOptions[]): number => {
  return values.length;
};
// refused: a tuple's options of which every member is optional, required
export const restOfRequired = (...[options]: [options: IAllOptionalOptions]): number => {
  return options.a ?? 0;
};
// refused: one arm of the conditional takes options of which every member is optional, required
export const wrongArm = <S>(...[options]: WrongParameters<S>): number => {
  return options?.a ?? 0;
};

// ── A type's methods, and a factory's return type's ──────────────────────────

export interface IClient<O extends IAllOptionalOptions> {
  connect(...[options]: ConnectParameters<O>): Promise<void>;
  disconnect(options?: IAllOptionalOptions): Promise<void>;
  // refused: a method's options of which every member is optional, required
  reconnect(options: IAllOptionalOptions): Promise<void>;
  // options of a type parameter, judged where an instantiation is exported
  // refused: required, and all optional in `AllOptionalClient`
  start(options: O): Promise<void>;
}

export type AllOptionalClient = IClient<IAllOptionalOptions>;

export type OneRequiredClient = IClient<IAllOptionalOptions & { server: string }>;

/** A tuple named on its own: its array's methods are the platform's, never judged. */
export type Parameters = [options?: IAllOptionalOptions];

export const createClient = () => {
  return {
    close: (options?: IAllOptionalOptions): number => {
      return options?.a ?? 0;
    },
    // refused: a factory's method, its options of which every member is optional, required
    open: (options: IAllOptionalOptions): number => {
      return options.a ?? 0;
    },
  };
};

// ── An inline object taken, and the options ──────────────────────────────────

export const dropAll = (
  // refused: two things in one inline object, where two parameters are
  connection: { failure: string; handle: string }
): number => {
  return connection.handle.length + connection.failure.length;
};

export interface IDropper {
  drop(
    // refused: a method's record of the call, inline and unnamed
    call: { failure: string; handle: string },
    reason: string
  ): void;
}

export const detailOf = (judged: string, { maximumBytes }: { maximumBytes: number }): number => {
  return judged.length + maximumBytes;
};

export const optionalLast = (settings?: { a?: number }): number => {
  return settings?.a ?? 0;
};

export const namedOptions = (options: { a: number }): number => {
  return options.a;
};

export const byKey = (map: { readonly [key: string]: number }): number => {
  return Object.keys(map).length;
};

// ── A tuple taken or given, and a parameter list ─────────────────────────────

export interface IHeld {
  // refused: a member holding tuples
  pairs: [number, number][];
}

// refused: a tuple named on its own, no element labeled
export type Pair = [number, number];

// refused: an array taken apart, its type a tuple
export const pair = ([a, b]: [number, number]): number => {
  return a + b;
};
// refused: a parameter's own type a tuple, labeled though it is
export const labeled = (pair: [a: number, b: number]): number => {
  return pair[0] + pair[1];
};
// refused: a tuple given
export const twice = (): [number, number] => {
  return [1, 2];
};
// refused: a tuple given at depth
export const later = (): Promise<[number, number]> => {
  return Promise.resolve([1, 2]);
};
// refused: a labeled tuple given, a tuple all the same
export const labeledBack = (): [a: number, b: number] => {
  return [1, 2];
};
// refused: a tuple given that the checker infers, none written
export const inferred = () => {
  return [1, 2] as const;
};

// refused: an alias of ours judged by what it names, where an export takes it
type Hidden = [number, number];

export const first = (pair: Hidden): number => {
  return pair[0];
};

export const createPairs = () => {
  return {
    // refused: a factory's method giving a tuple
    first: (): [number, number] => {
      return [1, 2];
    },
  };
};

export const rest = (...[options]: [options?: IAllOptionalOptions]): number => {
  return options?.a ?? 0;
};
export type EventMap = { changed: [settings: ISettings, newValue: number] };
export const mapped = (pairs: ReadonlyMap<string, number>): number => {
  return pairs.size;
};
