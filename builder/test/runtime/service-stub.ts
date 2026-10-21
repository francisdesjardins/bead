// ── The service layer, stood in for ───────────────────────────────────────────

// What a generated file imports of the service layer at run time, each a stand-in that hands back
// what it is given, so that the builder's tests load a generated file and call its descriptors'
// validators with no runtime's install: the layer itself is the TypeScript side's to test.

// definition

export const GENERATED_CODE_SUPPORTS_VERSION_4 = true;

export const PAYLOAD_CODECS = Object.freeze({ raw: {}, text: {}, json: {} });

export const payloadCodecOf = <Codec>(codec: Codec): Codec => {
  return codec;
};

export const requestOf = <Init>(init: Init): Init => {
  return init;
};

export const commandOf = <Init>(init: Init): Init => {
  return init;
};

export const failuresOf = <Init>(init: Init): Init => {
  return init;
};

export const createServiceServer = (): object => {
  return {};
};

export const createServiceClient = (): object => {
  return {};
};
