// ── Transcoding ───────────────────────────────────────────────────────────────

// The entry a route table imports (`bead_http.ts`, decision 0037), and the transcoding layer a
// gateway reads it with, pure: no socket, which `./http-gateway` holds.

export { GENERATED_CODE_SUPPORTS_VERSION_5, routeOf } from './routes';
export type { HttpMethod, HttpPayload, IHttpRouteInit, IHttpRouteTemplate } from './routes';
export {
  isTie,
  matchesTemplate,
  parseTemplate,
  rawPathOf,
  routeIndexOf,
  templateOf,
  variablesOf,
} from './templates';
export type {
  IRawPath,
  ITemplate,
  IVariable,
  Segment,
  TemplateReading,
  VariablesReading,
} from './templates';
export { bindRequest } from './binding';
export type { IBindingOptions } from './binding';
export {
  JsonFormError,
  MAXIMUM_DEPTH,
  readJsonText,
  readMessage,
  readProtoJson,
  typeRegistryOf,
  writeFieldJson,
  writeProtoJson,
} from './json-form';
export type {
  IJsonFormOptions,
  IJsonPlace,
  IJsonToken,
  ITypeRegistry,
  JsonNode,
  RequestPlace,
} from './json-form';
export {
  DEFAULT_CHALLENGE,
  PROBLEM_MEDIA_TYPE,
  problemOfFailure,
  problemOfOwn,
  problemOfRefusal,
  PROTOCOL_TYPES,
  STATUS_PHRASES,
} from './problems';
export type {
  Arose,
  Encoding,
  ICallFailure,
  IProblem,
  IProblemOptions,
  IProblemRoute,
  OwnFailure,
} from './problems';
export {
  createEventStream,
  EVENT_STREAM_MEDIA_TYPE,
  eventDataOf,
  eventOf,
  HEARTBEAT_COMMENT,
} from './events';
export type { IEventSink, IEventStream, IEventStreamOptions } from './events';
