// ── The proto module, stood in for ────────────────────────────────────────────

// What a generated file imports of the `proto` module at run time: the validators' contract, played
// by `validate.ts`, and a codec of a schema that hands back its schema, which the TypeScript side
// tests.

// definition

export * from './validate.ts';

export const protoCodecOf = <Schema>(schema: Schema): Schema => {
  // the TypeScript side's to read and write
  return schema;
};
