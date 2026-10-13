/**
 * The addresses a server listens on, and the forms it refuses (spec 15.12), as the C# side's
 * tests hold them alike: a name; the short, hexadecimal, octal, padded and one-number forms; a
 * leading zero; a final dot; brackets; a zone; an IPv4-mapped address.
 */

export const LISTENING_ADDRESSES: readonly string[] = ['127.0.0.1', '0.0.0.0', '::1', '::'];

export const NO_LISTENING_ADDRESSES: readonly string[] = [
  'localhost',
  '127.1',
  '0x7f.0.0.1',
  '0177.0.0.1',
  '127.000.000.001',
  '2130706433',
  '1',
  '0',
  '1.2.3.04',
  '127.0.0.1.',
  '[::1]',
  'fe80::1%4',
  '::ffff:127.0.0.1',
];
