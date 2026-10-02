/**
 * The formatter helper's shape, declared beside it rather than inferred.
 *
 * The module is `.mjs` like the rest of `tools/`, and its caller, `tools/check-examples.mjs`, is
 * never compiled; this declaration gives a typed caller `formatAs` rather than an implicit `any`.
 */
export declare function formatAs(fileName: string, text: string): Promise<string>;
