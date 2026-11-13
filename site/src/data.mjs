// What the page draws from data rather than prose, in both its languages: the byte examples, the
// header's words, the protocol's failures and the status a gateway answers each with, and the table
// of the three implementations, each part by the rows of the support matrix it stands for. Each
// label is a pair, `[english, french]`; a byte's role is one of prefix, kind, block, record or
// payload.

// ── Byte examples ─────────────────────────────────────────────────────────────

const LAYOUT = ['A1', ['layout', 'disposition'], 'prefix'];

export const EXAMPLES = Object.freeze({
  request: {
    label: [
      'A REQUEST, byte by byte: A1 10 00 03, 00 00 00 03, 00 02 00 01, then the payload 68 69',
      'Une REQUEST, octet par octet : A1 10 00 03, 00 00 00 03, 00 02 00 01, puis la charge 68 69',
    ],
    segments: [
      LAYOUT,
      ['10', ['REQUEST', 'REQUEST'], 'prefix'],
      ['00', ['no block', 'aucun bloc'], 'prefix'],
      ['03', ['3 words: 12 bytes', '3 mots : 12 octets'], 'prefix'],
      [
        '00 00 00 03',
        ['callId 3, odd: the client calls', 'callId 3, impair : le client appelle'],
        'prefix',
      ],
      ['00 02', ['service 2', 'service 2'], 'kind'],
      ['00 01', ['procedure 1', 'procédure 1'], 'kind'],
      ['68 69', ['payload: “hi”', 'charge : « hi »'], 'payload'],
    ],
  },
  result: {
    label: [
      'A RESULT that announces the session: A1 11 08 07, 00 00 00 03, 00 01 00 10, the 16-byte token, then the payload',
      'Un RESULT qui annonce la session : A1 11 08 07, 00 00 00 03, 00 01 00 10, le jeton de 16 octets, puis la charge',
    ],
    segments: [
      LAYOUT,
      ['11', ['RESULT', 'RESULT'], 'prefix'],
      ['08', ['CREDENTIAL', 'CREDENTIAL'], 'prefix'],
      ['07', ['7 words: 28 bytes', '7 mots : 28 octets'], 'prefix'],
      ['00 00 00 03', ['callId 3: the same request', 'callId 3 : la même requête'], 'prefix'],
      ['00 01', ['scheme: OPAQUE', 'schéma : OPAQUE'], 'block'],
      ['00 10', ['length: 16', 'longueur : 16'], 'block'],
      ['9F 3C 51 … 0B', ['the token, 16 bytes', 'le jeton, 16 octets'], 'block'],
      ['48 49', ['payload: “HI”', 'charge : « HI »'], 'payload'],
    ],
  },
  subscribe: {
    label: [
      'A REQUEST that opens a subscription: A1 10 10 03, 00 00 00 07, 00 02 00 05, then the payload',
      'Une REQUEST qui ouvre un abonnement : A1 10 10 03, 00 00 00 07, 00 02 00 05, puis la charge',
    ],
    segments: [
      LAYOUT,
      ['10', ['REQUEST', 'REQUEST'], 'prefix'],
      ['10', ['SUBSCRIPTION', 'SUBSCRIPTION'], 'prefix'],
      ['03', ['3 words: 12 bytes', '3 mots : 12 octets'], 'prefix'],
      [
        '00 00 00 07',
        ['callId 7: the subscription’s', 'callId 7 : celui de l’abonnement'],
        'prefix',
      ],
      ['00 02', ['service 2', 'service 2'], 'kind'],
      ['00 05', ['procedure 5', 'procédure 5'], 'kind'],
      ['7B 7D', ['payload', 'charge'], 'payload'],
    ],
  },
  notification: {
    label: [
      'A NOTIFICATION: A1 13 00 02, 00 00 00 07, then the payload',
      'Une NOTIFICATION : A1 13 00 02, 00 00 00 07, puis la charge',
    ],
    segments: [
      LAYOUT,
      ['13', ['NOTIFICATION', 'NOTIFICATION'], 'prefix'],
      ['00', ['no block', 'aucun bloc'], 'prefix'],
      ['02', ['2 words: 8 bytes', '2 mots : 8 octets'], 'prefix'],
      [
        '00 00 00 07',
        ['callId 7: the subscription’s', 'callId 7 : celui de l’abonnement'],
        'prefix',
      ],
      ['7B 22 … 7D', ['payload', 'charge'], 'payload'],
    ],
  },
  failure: {
    label: [
      'A FAILURE: A1 12 00 02, 00 00 00 05, then the failure 00 15 00 01 and its detail',
      'Une FAILURE : A1 12 00 02, 00 00 00 05, puis l’échec 00 15 00 01 et son détail',
    ],
    segments: [
      LAYOUT,
      ['12', ['FAILURE', 'FAILURE'], 'prefix'],
      ['00', ['no block', 'aucun bloc'], 'prefix'],
      ['02', ['2 words: 8 bytes', '2 mots : 8 octets'], 'prefix'],
      ['00 00 00 05', ['callId 5', 'callId 5'], 'prefix'],
      ['00 15', ['code 21', 'code 21'], 'record'],
      ['00', ['0 relays', '0 relais'], 'record'],
      ['01', ['APPLICATION', 'APPLICATION'], 'record'],
      ['65 6D 70 74 79', ['detail: “empty”', 'détail : « empty »'], 'payload'],
    ],
  },
  invalid: {
    label: [
      'A PAYLOAD_INVALID FAILURE: A1 12 00 02, 00 00 00 09, then the failure 00 34 00 00 and its detail, one violation a line',
      'Une FAILURE PAYLOAD_INVALID : A1 12 00 02, 00 00 00 09, puis l’échec 00 34 00 00 et son détail, une violation par ligne',
    ],
    segments: [
      LAYOUT,
      ['12', ['FAILURE', 'FAILURE'], 'prefix'],
      ['00', ['no block', 'aucun bloc'], 'prefix'],
      ['02', ['2 words: 8 bytes', '2 mots : 8 octets'], 'prefix'],
      ['00 00 00 09', ['callId 9', 'callId 9'], 'prefix'],
      ['00 34', ['code 52', 'code 52'], 'record'],
      ['00', ['0 relays', '0 relais'], 'record'],
      ['00', ['PROTOCOL', 'PROTOCOL'], 'record'],
      [
        '7B 22 62 6F …',
        ['detail: {"bo…, one violation a line', 'détail : {"bo…, une violation par ligne'],
        'payload',
      ],
      ['0A 7B 22 6D …', ['then {"more":0}', 'puis {"more":0}'], 'payload'],
    ],
  },
  cancel: {
    label: [
      'A CANCEL: A1 16 00 02, then 00 00 00 05, and nothing after',
      'Un CANCEL : A1 16 00 02, puis 00 00 00 05, et rien après',
    ],
    segments: [
      LAYOUT,
      ['16', ['CANCEL', 'CANCEL'], 'prefix'],
      ['00', ['no block', 'aucun bloc'], 'prefix'],
      ['02', ['2 words: 8 bytes', '2 mots : 8 octets'], 'prefix'],
      ['00 00 00 05', ['callId 5: the call given up', 'callId 5 : l’appel abandonné'], 'prefix'],
    ],
  },
  paced: {
    label: [
      'A REQUEST that opens a paced subscription: A1 10 30 03, 00 00 00 07, 00 02 00 05, then the payload',
      'Une REQUEST qui ouvre un abonnement cadencé : A1 10 30 03, 00 00 00 07, 00 02 00 05, puis la charge',
    ],
    segments: [
      LAYOUT,
      ['10', ['REQUEST', 'REQUEST'], 'prefix'],
      ['30', ['SUBSCRIPTION and PACED', 'SUBSCRIPTION et PACED'], 'prefix'],
      ['03', ['3 words: 12 bytes', '3 mots : 12 octets'], 'prefix'],
      [
        '00 00 00 07',
        ['callId 7: the subscription’s', 'callId 7 : celui de l’abonnement'],
        'prefix',
      ],
      ['00 02', ['service 2', 'service 2'], 'kind'],
      ['00 05', ['procedure 5', 'procédure 5'], 'kind'],
      ['7B 7D', ['payload', 'charge'], 'payload'],
    ],
  },
  pacedCredit: {
    label: [
      'A CREDIT of notifications: A1 15 20 04, 00 00 00 07, then the count on 8 bytes',
      'Un CREDIT de notifications : A1 15 20 04, 00 00 00 07, puis le compte sur 8 octets',
    ],
    segments: [
      LAYOUT,
      ['15', ['CREDIT', 'CREDIT'], 'prefix'],
      ['20', ['PACED: notifications', 'PACED : des notifications'], 'prefix'],
      ['04', ['4 words: 16 bytes', '4 mots : 16 octets'], 'prefix'],
      [
        '00 00 00 07',
        ['callId 7: the subscription’s', 'callId 7 : celui de l’abonnement'],
        'prefix',
      ],
      ['00 00 00 00 00 00 00 02', ['two sent at most', 'deux envoyées au plus'], 'kind'],
    ],
  },
  jwt: {
    label: [
      'A REQUEST that presents a JWT: A1 10 08 4F, 00 00 00 03, 00 02 00 01, 00 02 01 2A, the 298-byte token, 00 00, then the payload',
      'Une REQUEST qui présente un JWT : A1 10 08 4F, 00 00 00 03, 00 02 00 01, 00 02 01 2A, le jeton de 298 octets, 00 00, puis la charge',
    ],
    segments: [
      LAYOUT,
      ['10', ['REQUEST', 'REQUEST'], 'prefix'],
      ['08', ['CREDENTIAL', 'CREDENTIAL'], 'prefix'],
      ['4F', ['79 words: 316 bytes', '79 mots : 316 octets'], 'prefix'],
      ['00 00 00 03', ['callId 3', 'callId 3'], 'prefix'],
      ['00 02', ['service 2', 'service 2'], 'kind'],
      ['00 01', ['procedure 1', 'procédure 1'], 'kind'],
      ['00 02', ['scheme: JWT', 'schéma : JWT'], 'block'],
      ['01 2A', ['length: 298', 'longueur : 298'], 'block'],
      ['65 79 4A …', ['the token: eyJ…, 298 bytes', 'le jeton : eyJ…, 298 octets'], 'block'],
      ['00 00', ['padding to the word', 'bourrage jusqu’au mot'], 'block'],
      ['68 69', ['payload: “hi”', 'charge : « hi »'], 'payload'],
    ],
  },
  ended: {
    label: [
      'A FAILURE that announces the session’s end: A1 12 08 03, 00 00 00 05, 00 00 00 00, then the failure 00 20 00 00',
      'Une FAILURE qui annonce la fin de la session : A1 12 08 03, 00 00 00 05, 00 00 00 00, puis l’échec 00 20 00 00',
    ],
    segments: [
      LAYOUT,
      ['12', ['FAILURE', 'FAILURE'], 'prefix'],
      ['08', ['CREDENTIAL', 'CREDENTIAL'], 'prefix'],
      ['03', ['3 words: 12 bytes', '3 mots : 12 octets'], 'prefix'],
      ['00 00 00 05', ['callId 5: the subscription', 'callId 5 : l’abonnement'], 'prefix'],
      ['00 00', ['scheme: NONE', 'schéma : NONE'], 'block'],
      ['00 00', ['length: 0', 'longueur : 0'], 'block'],
      ['00 20', ['code 32', 'code 32'], 'record'],
      ['00', ['0 relays', '0 relais'], 'record'],
      ['00', ['PROTOCOL', 'PROTOCOL'], 'record'],
    ],
  },
  opening: {
    label: [
      'A REQUEST that opens a transfer: A1 10 04 05, 00 00 00 07, 00 02 00 05, the total on 8 bytes, then the first bytes',
      'Une REQUEST qui ouvre un transfert : A1 10 04 05, 00 00 00 07, 00 02 00 05, le total sur 8 octets, puis les premiers octets',
    ],
    segments: [
      LAYOUT,
      ['10', ['REQUEST', 'REQUEST'], 'prefix'],
      ['04', ['TRANSFER', 'TRANSFER'], 'prefix'],
      ['05', ['5 words: 20 bytes', '5 mots : 20 octets'], 'prefix'],
      ['00 00 00 07', ['callId 7', 'callId 7'], 'prefix'],
      ['00 02', ['service 2', 'service 2'], 'kind'],
      ['00 05', ['procedure 5', 'procédure 5'], 'kind'],
      [
        '00 00 00 00 01 40 00 00',
        ['the total: 20,971,520 bytes', 'le total : 20 971 520 octets'],
        'block',
      ],
      [
        '…',
        ['the first 1,048,556, with no credit', 'les 1 048 556 premiers, sans crédit'],
        'payload',
      ],
    ],
  },
  credit: {
    label: [
      'A CREDIT: A1 15 00 04, 00 00 00 07, then the end granted on 8 bytes',
      'Un CREDIT : A1 15 00 04, 00 00 00 07, puis la fin accordée sur 8 octets',
    ],
    segments: [
      LAYOUT,
      ['15', ['CREDIT', 'CREDIT'], 'prefix'],
      ['00', ['no block', 'aucun bloc'], 'prefix'],
      ['04', ['4 words: 16 bytes', '4 mots : 16 octets'], 'prefix'],
      ['00 00 00 07', ['callId 7', 'callId 7'], 'prefix'],
      ['00 00 00 00 00 4F FF EC', ['send up to 5,242,860', 'envoyer jusqu’à 5 242 860'], 'kind'],
    ],
  },
  chunk: {
    label: [
      'A CHUNK: A1 14 40 04, 00 00 00 07, its offset on 8 bytes, then its bytes',
      'Un CHUNK : A1 14 40 04, 00 00 00 07, sa position sur 8 octets, puis ses octets',
    ],
    segments: [
      LAYOUT,
      ['14', ['CHUNK', 'CHUNK'], 'prefix'],
      ['40', ['MORE: others follow', 'MORE : d’autres suivent'], 'prefix'],
      ['04', ['4 words: 16 bytes', '4 mots : 16 octets'], 'prefix'],
      ['00 00 00 07', ['callId 7', 'callId 7'], 'prefix'],
      ['00 00 00 00 00 0F FF EC', ['from 1,048,556', 'depuis 1 048 556'], 'kind'],
      ['…', ['1,048,560 bytes', '1 048 560 octets'], 'payload'],
    ],
  },
  last: {
    label: [
      'The last CHUNK: A1 14 00 04, 00 00 00 07, its offset on 8 bytes, then its bytes',
      'Le dernier CHUNK : A1 14 00 04, 00 00 00 07, sa position sur 8 octets, puis ses octets',
    ],
    segments: [
      LAYOUT,
      ['14', ['CHUNK', 'CHUNK'], 'prefix'],
      ['00', ['no MORE: the last', 'sans MORE : le dernier'], 'prefix'],
      ['04', ['4 words: 16 bytes', '4 mots : 16 octets'], 'prefix'],
      ['00 00 00 07', ['callId 7', 'callId 7'], 'prefix'],
      ['00 00 00 00 01 3F FE BC', ['from 20,971,196', 'depuis 20 971 196'], 'kind'],
      ['…', ['324 bytes: the total reached', '324 octets : le total atteint'], 'payload'],
    ],
  },
});

// ── The header, one 32-bit word a row ─────────────────────────────────────────

export const HEADER = Object.freeze({
  label: [
    'The 32-bit words of a REQUEST that carries DESTINATION, TRANSFER and CREDENTIAL, here OPAQUE',
    'Les mots de 32 bits d’une REQUEST qui porte DESTINATION, TRANSFER et CREDENTIAL, ici OPAQUE',
  ],
  words: [
    [
      ['bytes 0-3', 'octets 0-3'],
      [
        [['layout', 'layout'], 8],
        [['kind', 'kind'], 8],
        [['flags', 'flags'], 8],
        [['headerWords', 'headerWords'], 8],
      ],
    ],
    [['bytes 4-7', 'octets 4-7'], [[['callId', 'callId'], 32]]],
    [
      ['bytes 8-11', 'octets 8-11'],
      [
        [['serviceId', 'serviceId'], 16],
        [['procedureId', 'procedureId'], 16],
      ],
    ],
    [['DESTINATION', 'DESTINATION'], [[['destinationId', 'destinationId'], 32]]],
    [['TRANSFER 1/2', 'TRANSFER 1/2'], [[['total, high', 'total, poids fort'], 32]]],
    [['TRANSFER 2/2', 'TRANSFER 2/2'], [[['total, low', 'total, poids faible'], 32]]],
    [
      ['CREDENTIAL 1/5', 'CREDENTIAL 1/5'],
      [
        [['scheme: OPAQUE', 'schéma : OPAQUE'], 16],
        [['length: 16', 'longueur : 16'], 16],
      ],
    ],
    [['CREDENTIAL 2/5', 'CREDENTIAL 2/5'], [[['token, bits 0-31', 'jeton, bits 0-31'], 32]]],
    [['CREDENTIAL 3/5', 'CREDENTIAL 3/5'], [[['token, bits 32-63', 'jeton, bits 32-63'], 32]]],
    [['CREDENTIAL 4/5', 'CREDENTIAL 4/5'], [[['token, bits 64-95', 'jeton, bits 64-95'], 32]]],
    [['CREDENTIAL 5/5', 'CREDENTIAL 5/5'], [[['token, bits 96-127', 'jeton, bits 96-127'], 32]]],
  ],
});

// ── The protocol's failures, by the stage the request reached ─────────────────

export const STAGES = Object.freeze([
  [1, 15, ['envelope', 'enveloppe']],
  [16, 31, ['route', 'route']],
  [32, 47, ['admission', 'admission']],
  [48, 63, ['payload', 'charge']],
  [64, 79, ['procedure', 'procédure']],
]);

// a failure's fate: answered to the peer, reported locally, rejected before it goes, or as the gate
// lets it; a code may have two
export const FATES = Object.freeze({
  answered: ['answered', 'répondu'],
  reported: ['reported', 'signalé'],
  rejected: ['rejected', 'rejeté'],
  gate: ['gate', 'porte'],
});

export const FAILURES = Object.freeze([
  [
    'ENVELOPE_MALFORMED',
    1,
    'gate',
    [
      'The bytes do not form an envelope this layout reads.',
      'Les octets ne forment pas une enveloppe que cette disposition lit.',
    ],
  ],
  [
    'LAYOUT_UNSUPPORTED',
    2,
    'gate',
    [
      'A layout to come, 0xA2 to 0xAF; the detail says the ones read.',
      'Une disposition à venir, de 0xA2 à 0xAF ; le détail dit celles lues.',
    ],
  ],
  [
    'KIND_UNSUPPORTED',
    3,
    'reported',
    [
      'A kind to come, 0x17 to 0x7F; a NOTIFICATION a server received, or a credit of notifications a client received.',
      'Un genre à venir, de 0x17 à 0x7F ; une NOTIFICATION reçue par un serveur, ou un crédit de notifications reçu par un client.',
    ],
  ],
  [
    'ENVELOPE_TOO_LARGE',
    4,
    'gate',
    [
      'A request past chunkBytes, or another envelope past maximumEnvelopeBytes.',
      'Une requête au-delà de chunkBytes, ou une autre enveloppe au-delà de maximumEnvelopeBytes.',
    ],
  ],
  [
    'DESTINATION_UNKNOWN',
    16,
    'answered',
    [
      'A destination the relay does not have, or a peer that relays nothing.',
      'Une destination que le relais n’a pas, ou un pair qui ne relaie rien.',
    ],
  ],
  [
    'DESTINATION_UNREACHABLE',
    17,
    ['answered', 'rejected'],
    [
      'The request could not leave for its destination: nothing was tried.',
      'La requête n’a pas pu partir vers sa destination : rien n’a été tenté.',
    ],
  ],
  [
    'SERVICE_UNKNOWN',
    18,
    'answered',
    [
      'No procedure is registered for this service.',
      'Aucune procédure n’est enregistrée pour ce service.',
    ],
  ],
  [
    'PROCEDURE_UNKNOWN',
    19,
    'answered',
    ['The service exists, not the procedure.', 'Le service existe, pas la procédure.'],
  ],
  [
    'CALL_UNKNOWN',
    20,
    'reported',
    [
      'A RESULT, a FAILURE or a CHUNK no call awaits.',
      'Un RESULT, une FAILURE ou un CHUNK qu’aucun appel n’attend.',
    ],
  ],
  [
    'SUBSCRIPTION_UNKNOWN',
    21,
    'reported',
    ['A NOTIFICATION under no subscription.', 'Une NOTIFICATION sous aucun abonnement.'],
  ],
  [
    'SUBSCRIPTION_UNSUPPORTED',
    22,
    'answered',
    [
      'A subscription on a path with no notification: a relay, an HTTP connection that does not listen.',
      'Un abonnement sur un chemin sans notification : un relais, une connexion HTTP qui n’écoute pas.',
    ],
  ],
  [
    'SESSION_REQUIRED',
    32,
    ['answered', 'rejected'],
    [
      'The credential does not hold, or the procedure wants a session the call lacks; also sent when a session ends.',
      'Le justificatif ne tient pas, ou la procédure veut une session que l’appel n’a pas ; envoyé aussi quand une session finit.',
    ],
  ],
  [
    'ACCESS_DENIED',
    33,
    'answered',
    [
      'The admission refuses the call, on its header and its session.',
      'L’admission refuse l’appel, sur son en-tête et sa session.',
    ],
  ],
  [
    'PAYLOAD_TOO_LARGE',
    34,
    ['answered', 'rejected'],
    [
      'The payload, or a transfer’s total, is past its procedure’s or its router’s limit, 16 MiB by default.',
      'La charge, ou le total d’un transfert, dépasse la limite de sa procédure ou du routeur, 16 Mio par défaut.',
    ],
  ],
  [
    'CAPACITY_EXCEEDED',
    35,
    ['answered', 'rejected'],
    [
      'Too many calls at once, no free callId left, or a full queue or budget.',
      'Trop d’appels à la fois, plus aucun callId libre, ou une file ou un budget plein.',
    ],
  ],
  [
    'CREDENTIAL_UNSUPPORTED',
    36,
    'answered',
    [
      'A credential scheme this peer does not take; the detail names its own.',
      'Un schéma de justificatif que ce pair ne prend pas ; le détail nomme les siens.',
    ],
  ],
  [
    'CHUNK_INVALID',
    48,
    'answered',
    [
      'A chunk outside the rules: empty, misplaced, of the wrong size or past the total.',
      'Un morceau hors des règles : vide, mal placé, de la mauvaise taille ou au-delà du total.',
    ],
  ],
  [
    'CREDIT_EXCEEDED',
    49,
    'answered',
    ['A chunk past the credit granted.', 'Un morceau dépasse le crédit accordé.'],
  ],
  [
    'PAYLOAD_UNDECODABLE',
    50,
    'answered',
    ['The procedure’s codec refuses the payload.', 'Le codec de la procédure refuse la charge.'],
  ],
  [
    'TRANSFER_STALLED',
    51,
    'answered',
    [
      'Nothing came for a transfer for 30 s, by default.',
      'Rien n’est venu pour un transfert pendant 30 s, par défaut.',
    ],
  ],
  [
    'PAYLOAD_INVALID',
    52,
    ['answered', 'rejected'],
    [
      'The payload reads, but breaks a rule of its message.',
      'La charge se lit, mais enfreint une règle de son message.',
    ],
  ],
  [
    'PROCEDURE_FAILED',
    64,
    'answered',
    [
      'The procedure, its admission or a credential’s verifier failed.',
      'La procédure, son admission ou le vérificateur d’un justificatif a échoué.',
    ],
  ],
  [
    'DESTINATION_LOST',
    65,
    'answered',
    [
      'The relay lost its destination after sending: the procedure may have run.',
      'Le relais a perdu sa destination après l’envoi : la procédure a peut-être tourné.',
    ],
  ],
]);

export const FAILURE_HEADINGS = Object.freeze([
  ['Code', 'Code'],
  ['Name', 'Nom'],
  ['Stage', 'Étape'],
  ['Fate', 'Sort'],
  ['When', 'Quand'],
]);

// ── The status a gateway answers a failure with, by where it arose ────────────

export const STATUSES = Object.freeze([
  [
    400,
    [
      'PAYLOAD_UNDECODABLE, a reading refused; an application’s failure',
      'PAYLOAD_UNDECODABLE, une lecture refusée ; un échec de l’application',
    ],
  ],
  [
    401,
    [
      'SESSION_REQUIRED, its challenge in www-authenticate',
      'SESSION_REQUIRED, son défi dans www-authenticate',
    ],
  ],
  [403, ['ACCESS_DENIED', 'ACCESS_DENIED']],
  [413, ['ENVELOPE_TOO_LARGE, PAYLOAD_TOO_LARGE', 'ENVELOPE_TOO_LARGE, PAYLOAD_TOO_LARGE']],
  [
    422,
    ['PAYLOAD_INVALID, its violations in errors', 'PAYLOAD_INVALID, ses violations dans errors'],
  ],
  [429, ['CAPACITY_EXCEEDED, retry-after: 1', 'CAPACITY_EXCEEDED, retry-after: 1']],
  [
    500,
    [
      'PROCEDURE_FAILED, and what is said only between the gateway and its server',
      'PROCEDURE_FAILED, et ce qui ne se dit qu’entre la passerelle et son serveur',
    ],
  ],
  [501, ['SERVICE_UNKNOWN, PROCEDURE_UNKNOWN', 'SERVICE_UNKNOWN, PROCEDURE_UNKNOWN']],
  [
    502,
    [
      'an answer the gateway could not take; DESTINATION_LOST',
      'une réponse que la passerelle n’a pas pu prendre ; DESTINATION_LOST',
    ],
  ],
  [503, ['DESTINATION_UNREACHABLE, retry-after: 1', 'DESTINATION_UNREACHABLE, retry-after: 1']],
  [
    504,
    [
      'TRANSFER_STALLED, or the call’s timeout, 5 s by default',
      'TRANSFER_STALLED, ou le délai de l’appel, 5 s par défaut',
    ],
  ],
]);

export const STATUS_HEADINGS = Object.freeze([
  ['Status', 'Statut'],
  ['What raised it', 'Ce qui l’a levé'],
]);

// ── The wire's files, each linked where the repository keeps it ───────────────

export const WIRE = Object.freeze([
  [
    'implementations/typescript/src/router/shared/constants.ts',
    [
      'Layouts, kinds, flags, schemes, codes, limits',
      'Dispositions, genres, drapeaux, schémas, codes, limites',
    ],
  ],
  [
    'implementations/typescript/src/router/shared/header.ts',
    ['The header: written and read at fixed offsets', 'L’en-tête : écrit et lu à positions fixes'],
  ],
  [
    'implementations/typescript/src/router/shared/envelope.ts',
    [
      'The whole envelope, and a failure’s record',
      'L’enveloppe entière, et l’enregistrement d’un échec',
    ],
  ],
  [
    'implementations/typescript/src/router/shared/transfer.ts',
    [
      'Transfers: the chunks sent, placed, and the credit',
      'Les transferts : les morceaux envoyés, placés, et le crédit',
    ],
  ],
  [
    'implementations/typescript/src/router/shared/identifiers.ts',
    ['The callIds and the session tokens', 'Les callId et les jetons de session'],
  ],
  [
    'implementations/typescript/src/router/shared/errors.ts',
    ['FailureError: a failure received, readable', 'FailureError : un échec reçu, lisible'],
  ],
  [
    'implementations/typescript/src/router/shared/violations.ts',
    [
      'A PAYLOAD_INVALID’s violations: written as lines of JSON, read back',
      'Les violations d’un PAYLOAD_INVALID : écrites en lignes de JSON, relues',
    ],
  ],
  [
    'implementations/typescript/src/transport/shared/broker-parcel.ts',
    [
      'A broker’s parcel: written and read at fixed offsets',
      'La parcelle d’un courtier : écrite et lue à positions fixes',
    ],
  ],
  [
    'implementations/typescript/src/transport/shared/mqtt-packets.ts',
    [
      'An MQTT 5 PUBLISH counted to the byte, its topics and its group',
      'Une PUBLISH de MQTT 5 comptée à l’octet, ses sujets et son groupe',
    ],
  ],
  [
    'implementations/typescript/src/transport/shared/amqp-messages.ts',
    [
      'An AMQP 1.0 message counted to the byte, its profile, its subjects and its addresses',
      'Un message d’AMQP 1.0 compté à l’octet, son profil, ses sujets et ses adresses',
    ],
  ],
]);

// ── The three implementations, each part held to the support matrix ───────────

// ! every row of docs/support.md's Features and Transports is in exactly one list, a part's `rows`
// or OFF_THE_PAGE, by its title; each cell declares the stages its words say are ahead for its
// sides, `ahead`, and `whole` where they say the part is ahead whole, which the build holds to the
// tokens `ahead: <stage>` of that part's rows
export const SIDES = Object.freeze([
  ['TypeScript', ['TypeScript', 'TypeScript']],
  ['C#', ['C#, on .NET 10', 'C#, sur .NET 10']],
  ['Rust', ['Rust', 'Rust']],
]);

export const PART_HEADING = Object.freeze(['Part', 'Partie']);

export const PARTS = Object.freeze([
  {
    name: ['The wire', 'Le fil'],
    rows: ['The envelope codec and its refusals'],
    cells: [
      {
        sides: ['TypeScript'],
        ahead: [],
        says: ['The envelope, the headers, the failures', 'L’enveloppe, les en-têtes, les échecs'],
      },
      {
        sides: ['C#'],
        ahead: [],
        says: ['The same, byte for byte', 'Les mêmes, octet pour octet'],
      },
      {
        sides: ['Rust'],
        ahead: ["Rust's AMQP 1.0 binding"],
        says: [
          'The same, byte for byte, but AMQP 1.0’s messages, ahead with its binding',
          'Les mêmes, octet pour octet, sauf les messages d’AMQP 1.0, à venir avec sa liaison',
        ],
      },
    ],
  },
  {
    name: ['Above the wire', 'Au-dessus du fil'],
    rows: [
      'Calls, results and failures',
      'What an application does with a side from within a telling, taken in a later turn behind what that turn sends and among what it defers, in one queue of turns per router; a call made before a dispose goes, one made after fails unsent',
      "A request handed to its resolver in a later turn than the one it came in, whether its resolver waits or not, so a later request's refusal in its own turn goes before an answer its resolver gives at once",
      "A connection's reads paused once what its router has not taken reaches `maximumUntakenEnvelopes` or `maximumUntakenBytes`, what its transport received meanwhile held in order, and resumed at half; the envelope that reached the bound taken, the router's own jobs never counted; a broker's participant holding to `maximumHeldEnvelopeBytes`",
      "The calls a peer has a side answer at once, `maximumAnsweringCalls`: a request past them refused before anything else of it is read, a requester's call past them failed before it goes, and a request that came whole held to `chunkBytes`",
      'Cancel and reservation',
      'Subscriptions and their pacing',
      'Transfers under credit',
      "A connection's session",
      "A request's credential, resolved to its call's session",
      "A `JWT`'s verification, its keys and its key set",
      "A credential's session, its end, and an `ELSEWHERE`'s verifier",
      "The client's credential, its withdrawal, and a call failed before it goes",
      'Relays',
      'The identity rules: what a side refuses as it declares a procedure',
      "Payloads: `raw`, `text` and `json`, read and written in one form, and `proto`, through each side's stock protobuf library",
      "A codec's refusal as it reads: a `SyntaxError` on the TypeScript side, a `FormatException` on the C# side, a `CodecRefusal` on the Rust side, its words its reason, which a request's `PAYLOAD_UNDECODABLE` carries as its detail; anything else a codec throws, or panics with, is not a refusal",
      "Payload rules: protovalidate's rules on a `proto` request, generated by beadc, judged before the resolver and, when asked, before a call goes; `PAYLOAD_INVALID` and its violations; the detail bounded",
      "Commands, the server's calls to a client",
      'The service layer: typed descriptors, served and called, with their admissions and failures',
      'Health and gauges',
      'The trace of calls and of envelopes',
      'The trace of parcels',
      "A listener's error, reported and never changing a call; what a listener of an `error` event throws, dropped, the listeners after it told",
      'The debug filter',
      'The metrics registry: its declarations, its ceiling and its exposition',
      "The metrics' gates: every exit of a call, the notifications and the durations",
      'Debugging costs nothing while off',
      'Debugging left out at build time, the trace and the filter or the registry, as a constrained profile builds it',
    ],
    cells: [
      {
        sides: ['TypeScript', 'C#'],
        ahead: [],
        says: [
          'The routers, the services, sessions and JWTs, a payload’s rules, subscriptions, transfers, relays, debugging and metrics',
          'Les routeurs, les services, les sessions et les JWT, les règles d’une charge, les abonnements, les transferts, les relais, le débogage et les métriques',
        ],
      },
      {
        sides: ['Rust'],
        ahead: [
          "Rust's beadc target",
          "Rust's service manager over a router of the application's own",
        ],
        says: [
          'The same, but a payload’s rules, whose validators come with <code>beadc</code>’s Rust target, and a service manager over a router of the application’s own',
          'Les mêmes, sauf les règles d’une charge, dont les validateurs viendront avec la cible Rust de <code>beadc</code>, et un gestionnaire de services sur un routeur propre à l’application',
        ],
      },
    ],
  },
  {
    name: ['The transports', 'Les transports'],
    rows: [
      "The procedures a server's transport takes, `procedures`, and a broker's per name, `proceduresByName`: a request to any other answered at step 5 as one to no resolver, `SERVICE_UNKNOWN` or `PROCEDURE_UNKNOWN`, its detail the same, before its credential, its admission and its payload, and counted under its procedure; absent every procedure, empty none; a joined transport's each transport's own, so two transports of one type, which a join does not take, are two routers",
      "A call to a client before its transport's open, uninitialized or connecting, refused by its ready state and counted `error`; one to a connection its side no longer holds, or to a client once its transport's state is a close's, closing, closed or reconnecting, a failed connect's among them, or on a connection that closes, failed as a disconnection and counted `closed`, never as a cancel: a `ReadyStateError`, and a `DisconnectError`, never a `CancelError`, on the TypeScript side; a `ReadyStateException`, and a `DisconnectException`, never the platform's `OperationCanceledException`, on the C# side; a `CallError::ReadyState`, and a `CallError::Disconnected`, never a `CallError::Cancelled`, on the Rust side",
      "The transport's credential: `Authorization` over HTTP, an upgrade's from no page over a WebSocket, and no redirect followed; what stands in front of a server, `secure`",
      'WebSocket',
      'WebSocket over TLS (`wss`)',
      'HTTP/1.1',
      'HTTP/2 over TLS, beside HTTP/1.1 by ALPN',
      'HTTP/2 in clear',
      'Web Worker',
      'In memory',
      "Joined, a server's transports through one",
      'Broker, in memory (the core)',
      'MQTT 5',
      'MQTT 5 over TLS (`mqtts`, `wss`), a client certificate among it',
      'AMQP 1.0 on RabbitMQ 4',
      'AMQP 1.0 over TLS (`amqps`), SASL EXTERNAL among it',
    ],
    cells: [
      {
        sides: ['TypeScript'],
        ahead: [],
        says: [
          'WebSocket, HTTP, Web Worker, in memory, a broker over MQTT 5 or AMQP 1.0, and joined',
          'WebSocket, HTTP, Web Worker, en mémoire, un courtier sur MQTT 5 ou AMQP 1.0, et joints',
        ],
      },
      {
        sides: ['C#'],
        ahead: ['The Web Worker transport'],
        says: [
          'WebSocket, HTTP on Kestrel, in memory, a broker over MQTT 5 or AMQP 1.0, and joined',
          'WebSocket, HTTP sur Kestrel, en mémoire, un courtier sur MQTT 5 ou AMQP 1.0, et joints',
        ],
      },
      {
        sides: ['Rust'],
        ahead: ["Rust's AMQP 1.0 binding", 'The Web Worker transport'],
        says: [
          'WebSocket on tungstenite, HTTP on hyper, in memory, a broker over MQTT 5, and joined',
          'WebSocket sur tungstenite, HTTP sur hyper, en mémoire, un courtier sur MQTT 5, et joints',
        ],
      },
    ],
  },
  {
    name: ['The HTTP/JSON gateway', 'La passerelle HTTP/JSON'],
    rows: [
      "HTTP/JSON transcoding: a gateway that answers a service's procedures as HTTP routes — its default routes and its `google.api.http` rules by their precedence, its binding, its problems, its streams as Server-Sent Events — one Bead connection per exchange, through the in-memory transport into its server, joined, its gates and its bounds",
      "protobuf's JSON mapping, read and written by Bead's own mapping over each side's descriptors, the binary payload its stock library's",
      "The OpenAPI document of a blueprint, or of the procedures an output's `gateway` selects, written once by beadc in the blueprint's form, embedded byte for byte in an output with `gateway`, served by a gateway",
      "The typed HTTP client of a service's default routes, written by an output with `gateway` of the procedures it selects: its problems, its gateway's own and a status with none read as Bead failures, its stream an async sequence, never reconnected",
    ],
    cells: [
      {
        sides: ['TypeScript'],
        ahead: [],
        says: [
          'On <code>node:http</code>, or mounted into a server',
          'Sur <code>node:http</code> ou montée dans un serveur',
        ],
      },
      {
        sides: ['C#'],
        ahead: [],
        says: [
          'On Kestrel, or mounted by its <code>HttpContext</code>',
          'Sur Kestrel, ou montée par son <code>HttpContext</code>',
        ],
      },
      {
        sides: ['Rust'],
        ahead: ["Rust's gateway"],
        whole: true,
        says: ['Ahead', 'À venir'],
      },
    ],
  },
]);

// the rows of the matrix the table stands for none of: what a server judges of a request over HTTP
// and tells of its refusals, its policy, beadc's outputs and each side's public surface
export const OFF_THE_PAGE = Object.freeze([
  'A `Retry-After` on a refused upgrade or exchange, which a client may wait for',
  "A server's tell of each refusal it judges of its own, and a client naming the one it reads",
  "An access a server refuses, told: its stage, its code, its reason, what was called, the connection and the request's address and port, never the credential",
  "A request's field values in visible ASCII, spaces and tabs, none at either end of a value, 400 unmarked or a stream reset otherwise",
  "A request's target in visible ASCII, its path's percent-decoding holding no NUL, 400 unmarked or a stream reset otherwise",
  'CORS over HTTP, to the origins a server names: its preflight, and every answer once the origin is judged naming it and exposing every field',
  "The client's address behind the proxies a server names, `trustedProxies`, and counts, `unnamedProxies`, over HTTP and over WebSocket, and the connections of each address on both",
  "What waits for a client's socket, held to `minimumSendBytesPerSecond` past `sendGracePeriod`, and at a WebSocket's address to `maximumUnsentBytes`, a client behind them dropped and reported",
  "A request's head held to `headersTimeout`, and a body to `minimumBodyBytesPerSecond` past `bodyGracePeriod`, each answered 408; an answer written before its body is whole closed in stages",
  'An output of beadc that holds what it selects: `server`, `client`, `gateway`, each class over its own pick, and the procedures each transport of its server takes, `SERVED_PROCEDURES` and `ServedProcedures`, under the rules `SELECTOR_UNMATCHED`, `SELECTION_EMPTY` and `GATEWAY_EMPTY`',
  "The HTTP transport's and a gateway's policy: one object of hosts, origins, proxies and bounds, built and checked once and frozen, which either takes, a member given in it and beside it refused, its three durations held as 1.4 states, a way of their places",
  "Each side's public surface, pinned to its list with its members: what an application and generated code call, the envelope's codec and a router's core internal; an options object required exactly when a member of it is, at most two members required; no tuple taken or given, a parameter list and a map's entries aside; every public name mapped term for term, each with its kind ([0047](decisions/0047-every-side-shows-one-public-surface.md)). `tools/check-names.mjs` holds the three sides' lists to `tools/names.tsv`, its cases in `tools/__tests__/check-names.test.mjs`",
]);
