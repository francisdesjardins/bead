/**
 * The shape of `check-a11y.mjs`'s audit, declared beside it for the TypeScript side's tests, which
 * `tsc` type-checks: without it an import of the script would be an implicit `any`.
 */
import type { Browser, Page } from '@playwright/test';

/** One violation: its rule, axe's id or the script's own, the element, what is wrong, and where. */
export interface IViolation {
  rule: string;
  element: string;
  message: string;
  page: string;
}

/** An exception: the rule it lifts, the elements it lifts it on, and why. */
export interface IException {
  rule: string;
  selector: string;
  reason: string;
}

/** How a page in its state is audited. */
export interface IAuditOptions {
  /** What names the page in each violation; its address where none is given. */
  label?: string;
  /** Which of CHECKS run; all of them where none is given. */
  checks?: readonly string[];
  /** The exceptions; the file's where none are given. */
  exceptions?: readonly IException[];
}

/** How an address is audited. */
export interface IAddressOptions {
  schemes?: readonly ('dark' | 'light')[];
  widths?: readonly number[];
  exceptions?: readonly IException[];
  /** What brings each load to its state, before it is audited. */
  prepare?: (page: Page) => Promise<void>;
  label?: string;
}

export declare const CHECKS: readonly string[];
export declare const SCHEMES: readonly ('dark' | 'light')[];
export declare const WIDTHS: readonly number[];
export declare const TAGS: readonly string[];
/** What a scheme changes: run at every width of every scheme. */
export declare const EACH_SCHEME: readonly string[];
/** What a width changes: run at every width of the first scheme. */
export declare const EACH_WIDTH: readonly string[];
/** What neither changes: run once. */
export declare const ONCE: readonly string[];

export declare function auditPage(page: Page, options?: IAuditOptions): Promise<IViolation[]>;

export declare function auditAddress(
  browser: Browser,
  url: string,
  options?: IAddressOptions
): Promise<IViolation[]>;

export declare function exceptionsOf(path?: string): IException[];

export declare function reportOf(found: readonly IViolation[]): string[];
