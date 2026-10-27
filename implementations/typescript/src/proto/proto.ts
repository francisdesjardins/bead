// ── Proto ─────────────────────────────────────────────────────────────────────

// The entry a `proto` binding's generated code imports beside `./service`: a payload's codec of its
// schema, which checks its records before protobuf-es reads them and refuses a required field unset
// (decisions 0028, 0042), and what its rules are judged with (decision 0035), the validators, their
// sink and a pattern's walk.

export { protoCodecOf } from './codec';
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
