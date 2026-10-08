// ── Main ─────────────────────────────────────────────────────────────────────

// HelloService's TypeScript server and client, as the C# side's Program.cs runs them: `serve`, on
// any free port, `serve <port>`, on the port given, and `call <port>`, a port its digits alone, at
// most 65535; any other arguments, the usage, and exit 2.

// dependencies

import { call } from './calling.ts';
import { serve } from './serving.ts';

// constants

const DIGITS = /^[0-9]+$/u;

/** The highest port, the C# side's `ushort`. */
const HIGHEST_PORT = 65_535;

// helpers

// a port, its digits alone, at most 65535, as the C# side's `ushort.TryParse` reads one
const isPort = (text: string): boolean => {
  return DIGITS.test(text) && Number(text) <= HIGHEST_PORT;
};

const usage = (): number => {
  process.stderr.write('usage: hello serve [port] | hello call <port>\n');

  return 2;
};

// definition

// the verb read with the count of its arguments, as the C# side's list patterns read them
const run = async (args: readonly string[]): Promise<number> => {
  const [verb, port = ''] = args;

  if (verb === 'serve' && args.length === 1) {
    return serve(0);
  }

  if (verb === 'serve' && args.length === 2 && isPort(port)) {
    return serve(Number(port));
  }

  if (verb === 'call' && args.length === 2 && isPort(port)) {
    return call(Number(port));
  }

  return usage();
};

process.exitCode = await run(process.argv.slice(2));
