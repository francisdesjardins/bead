// ── Proto ─────────────────────────────────────────────────────────────────────

// The entry a `proto` binding's generated code imports beside `./service`: the check of a payload's
// records before protobuf-es reads it (decision 0028), and what its rules are judged with (decision
// 0035), the validators, their sink and a pattern's walk.

export { checkProtoRecords } from './records';
export { matchesPattern } from './pattern';
export type { IPatternTable } from './pattern';
export {
  bytesContain,
  bytesEndWith,
  bytesEqual,
  bytesStartWith,
  codePointLength,
  entriesByKey,
  isUnique,
  judgeRules,
  utf8Length,
  validatorOf,
} from './validate';
export type { IViolationRule, IViolationSink, MessageRules, Validator } from './validate';
export type { IJudged, IValidateOptions, IViolation } from '../router/shared/violations';
