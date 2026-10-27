// ── Service ───────────────────────────────────────────────────────────────────

// The entry generated code imports, alone of Bead's: the service layer, the descriptors, the
// failure catalogue, the payload codecs, a request's violations and the contract with generated
// code (decisions 0018, 0035).

export { commandOf, requestOf } from './descriptors';
export type {
  AdmissionRule,
  AnsweredName,
  CommandDescriptor,
  CommandName,
  FailureNameOf,
  GivenOf,
  HookName,
  IAdmissionHook,
  IDescriptorInit,
  IRequestInit,
  IServiceDescriptor,
  NotifyingName,
  RequestDescriptor,
  ServiceProcedures,
  ValueOf,
} from './descriptors';
export { failuresOf } from './failures';
export type { IFailureCatalogue, IListedFailure, IListedFailureError } from './failures';
export { GENERATED_CODE_SUPPORTS_VERSION_6 } from './generated-code';
export { createServiceClient } from './service-client';
export type { IServiceClient, IServiceClientOptions } from './service-client';
export { createServiceServer } from './service-server';
export type {
  IJudgingOptions,
  IServiceResponse,
  IServiceServer,
  ServiceResolverCallback,
  ServiceResolvers,
  ServiceServerOptions,
} from './service-server';
export { PAYLOAD_CODECS, payloadCodecOf } from '../router/shared/payloads';
export {
  detailBoundOf,
  violationsDetailOf,
  violationsOf,
  wordsOf,
} from '../router/shared/violations';
export type {
  IJudged,
  IReadViolations,
  IValidateOptions,
  IViolation,
} from '../router/shared/violations';
export type { IPayloadCodec, JsonValue } from '../router/shared/payloads';
export { ProcedureKind } from '../router/shared/constants';
export { FailureError } from '../router/shared/errors';
export { ProgrammerError } from '../transport/shared/errors';
export type {
  AdmissionFailure,
  IAdmissionRequest,
  IApplicationFailure,
  IBoundCall,
  ICallSession,
  INotification,
  INotificationRegistration,
  INotifyOptions,
  IProcedure,
  IRegistrar,
  IRequest,
  IRequestProps,
  ISubscriber,
} from '../router/shared/types';
