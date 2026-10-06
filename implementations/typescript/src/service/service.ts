// ── Service ───────────────────────────────────────────────────────────────────

// The entry generated code imports, alone of Bead's: the service layer, the descriptors, the
// failure catalogue, the payload codecs and the contract with generated code (decision 0018).

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
export type { IFailureCatalogue, IListedFailure } from './failures';
export { GENERATED_CODE_SUPPORTS_VERSION_1 } from './generated-code';
export { createServiceClient } from './service-client';
export type { IServiceClient } from './service-client';
export { createServiceServer } from './service-server';
export type {
  IServiceResponse,
  IServiceServer,
  ServiceResolverCallback,
  ServiceResolvers,
  ServiceServerOptions,
} from './service-server';
export { PAYLOAD_CODECS, payloadCodecOf } from '../router/shared/payloads';
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
