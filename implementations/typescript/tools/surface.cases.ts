// ── The cases of `check-surface.mjs`'s options rule ──────────────────────────
// A line for each verdict: a line the rule refuses follows a comment of its own, `// refused:` and
// why, and every other line is one it accepts. `check-surface.mjs --cases` reads this file alone,
// through `surface.cases.tsconfig.json`, and fails unless the lines refused are exactly the ones
// marked: an exported function's or method's options parameter is required exactly when a member
// of its type is, a conditional one by each arm, at most two required. The package's own lint and
// `tsconfig` leave it out.

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
