// ── Generated code ────────────────────────────────────────────────────────────

// The contract between generated code and this runtime, as a counter: a generated file names the
// highest it needs, and a runtime too old for it lacks the constant, so the file fails its
// type-check and its load. gRPC-Go's `SupportPackageIsVersion` counts the same way.

// constants

/**
 * The contract this runtime supports: the descriptors, the catalogue, the payload codecs and the
 * service layer of `./service`, its options typed by the service, a client side's Bead client
 * apart from them, a descriptor's `validate` judged into its violations, and of `./proto` a `proto`
 * payload's codec of its schema, `protoCodecOf`, which checks its records before its library reads
 * and refuses a required field unset both ways, and the validators a request's rules are generated
 * over. The counter moves only when generated code needs what the runtime did not have. Before
 * 1.0.0, an older constant goes once the code that names it no longer conforms through this
 * runtime, as code whose codec lets a required field unset through does not; from 1.0.0, it stays
 * for the whole major.
 *
 * @example
 * import { GENERATED_CODE_SUPPORTS_VERSION_6 } from '@francisdesjardins/bead/service';
 *
 * void GENERATED_CODE_SUPPORTS_VERSION_6;
 */
export const GENERATED_CODE_SUPPORTS_VERSION_6 = true;

/**
 * Beside the contract 6, a service's catalogue made of its id and its codes by name, two
 * parameters: `failuresOf(serviceId, codes)`.
 *
 * @example
 * import { GENERATED_CODE_SUPPORTS_VERSION_7 } from '@francisdesjardins/bead/service';
 *
 * void GENERATED_CODE_SUPPORTS_VERSION_7;
 */
export const GENERATED_CODE_SUPPORTS_VERSION_7 = true;

/**
 * Beside the contract 7, a server transport's option `procedures`, the addresses it takes, which
 * a generated `bead_served.ts` gives each transport of a server, by the key `beadc.yaml` names it
 * (decision 0048).
 *
 * @example
 * import { GENERATED_CODE_SUPPORTS_VERSION_8 } from '@francisdesjardins/bead/service';
 *
 * void GENERATED_CODE_SUPPORTS_VERSION_8;
 */
export const GENERATED_CODE_SUPPORTS_VERSION_8 = true;
