// ── Options ───────────────────────────────────────────────────────────────────

// Bead's options as a `.proto` states them, read through protoc-gen-es's code for
// bead/options.proto: `(bead.file)`, `(bead.service)` and `(bead.procedure)`. A `oneof`'s case gives
// a procedure's kind and an admission's rule.

// dependencies

import {
  type DescFile,
  type DescMethod,
  type DescService,
  getOption,
  hasOption,
} from '@bufbuild/protobuf';

import {
  type Admission,
  type File,
  file as fileOption,
  type Procedure,
  procedure as procedureOption,
  type Service,
  service as serviceOption,
} from '../generated/bead/options_pb.ts';
import { OPTIONS_NUMBER } from '../version.ts';

// constants

/** The fields of descriptor.proto that hold a declaration's options, by their numbers. */
export const OPTIONS_FIELD = Object.freeze({ FILE: 8, SERVICE: 3, METHOD: 4 } as const);

/** The fields of Bead's options, by their numbers, for a finding's place. */
export const FIELD = Object.freeze({
  FILE_ADMISSION: 1,
  FILE_RESERVED_SERVICES: 2,
  FILE_RESERVED_SERVICE_NAMES: 3,
  SERVICE_ID: 1,
  SERVICE_REVISION: 2,
  SERVICE_ADMISSION: 3,
  SERVICE_FAILURES: 4,
  SERVICE_DEPRECATION_MESSAGE: 5,
  SERVICE_RESERVED_IDS: 6,
  SERVICE_RESERVED_NAMES: 7,
  PROCEDURE_ID: 1,
  PROCEDURE_NOTIFIES: 2,
  PROCEDURE_COMMAND: 3,
  PROCEDURE_ADMISSION: 4,
  PROCEDURE_MAXIMUM_PAYLOAD_BYTES: 5,
  PROCEDURE_DEPRECATION_MESSAGE: 6,
  PROCEDURE_FAILURES: 7,
} as const);

// types

/** An admission's rule as a blueprint writes it, or `empty` for one that states none. */
export type AdmissionOf = 'none' | 'session' | { readonly hook: string } | 'empty';

// definition

/** `(bead.file)`, when the file states it. */
export const fileOptionsOf = (desc: DescFile): File | undefined => {
  return hasOption(desc, fileOption) ? getOption(desc, fileOption) : undefined;
};

/** `(bead.service)`, when the service states it: a Bead service. */
export const serviceOptionsOf = (desc: DescService): Service | undefined => {
  return hasOption(desc, serviceOption) ? getOption(desc, serviceOption) : undefined;
};

/** `(bead.procedure)`, when the rpc states it. */
export const procedureOptionsOf = (desc: DescMethod): Procedure | undefined => {
  return hasOption(desc, procedureOption) ? getOption(desc, procedureOption) : undefined;
};

/** An admission's rule, by its `oneof`'s case. */
export const admissionOf = (admission: Admission): AdmissionOf => {
  switch (admission.rule.case) {
    case 'none': {
      return 'none';
    }
    case 'session': {
      return 'session';
    }
    case 'hook': {
      return { hook: admission.rule.value };
    }
    case undefined: {
      return 'empty';
    }
  }
};

/** The source info path of a declaration's Bead option, then of `fields` within it. */
export const optionPathOf = (
  declaration: readonly number[],
  details: { readonly options: number; readonly fields?: readonly number[] }
): number[] => {
  return [...declaration, details.options, OPTIONS_NUMBER, ...(details.fields ?? [])];
};
