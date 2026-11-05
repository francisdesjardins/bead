// ── Transcoding ───────────────────────────────────────────────────────────────

// The entry a route table and its clients import (`bead_http.ts`, decision 0037): the mapping,
// routes, problems, events and HTTP caller. The gateway's listener is in `./http-gateway`.

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
export { createHTTPBinding } from './binding';
export type { IBindingOptions, IHTTPBinding } from './binding';
export { createJsonForm, JsonFormError, MAXIMUM_DEPTH } from './json-form';
export type { IJsonForm, IJsonPlace, IJsonToken, RequestPlace } from './json-form';
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
  IOwnProblemOptions,
  IProblem,
  IProblemOptions,
  IProblemRoute,
  OwnFailure,
} from './problems';
export type { IServerSentEvent } from './events';
export { createHTTPCaller, httpRequesterOf, httpSubscriberOf } from './http-caller';
export type {
  HTTPEvent,
  IHTTPCaller,
  IHTTPCallerOptions,
  IHTTPCallOptions,
  IHTTPRequester,
  IHTTPSubscriber,
} from './http-caller';
