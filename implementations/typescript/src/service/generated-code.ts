// ── Generated code ────────────────────────────────────────────────────────────

// The contract between generated code and this runtime, as a counter: a generated file names the
// highest it needs, and a runtime too old for it lacks the constant, so the file fails its
// type-check and its load. gRPC-Go's `SupportPackageIsVersion` counts the same way.

// constants

/**
 * The contract this runtime supports: the descriptors, the catalogue, the payload codecs and the
 * service layer of `./service`, its options typed by the service, a client side's Bead client
 * apart from them, and the check of a `proto` payload's records of `./proto`, which a codec calls
 * before its library reads. The counter moves only when generated code needs what the runtime did
 * not have. Before 1.0.0, an older constant goes once the code that names it no longer conforms
 * through this runtime, as code that reads a `proto` payload unchecked does not; from 1.0.0, it
 * stays for the whole major.
 *
 * @example
 * import { GENERATED_CODE_SUPPORTS_VERSION_3 } from '@francisdesjardins/bead/service';
 *
 * void GENERATED_CODE_SUPPORTS_VERSION_3;
 */
export const GENERATED_CODE_SUPPORTS_VERSION_3 = true;
