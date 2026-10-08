// ── beadc ─────────────────────────────────────────────────────────────────────

// beadc's command line: `check`, `blueprint`, `generate` and `version` (decision 0022). It parses
// the call, runs the command, prints each finding a line, and exits 0, 1 on an error — a warning too
// under `--fail-on-warning`, a difference under `blueprint --check` or `generate --check` — or 2 when
// the input or the call is one beadc cannot take. `generate` alone loads the targets, by a dynamic
// import: they load a TypeScript compiler, which the other commands never need.
//
//   node src/cli.ts check [<root or blueprint>]
//   node src/cli.ts blueprint [<root or blueprint>] -o <file> [--descriptor-set-out <file>]
//   node src/cli.ts blueprint --check [<root or blueprint>] [-o <file>]
//   node src/cli.ts generate [--check]
//   node src/cli.ts version

// dependencies

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { checkBlueprintFile, checkRoots, type IChecked } from './check.ts';
import { findConfig, type IConfig, parseConfig, type Source } from './config.ts';
import {
  ErrorFormat,
  formatDiagnostic,
  hasError,
  type IDiagnostic,
  InputError,
} from './diagnostics.ts';
import { formDifferencesOf, formOf, type IFormDifference } from './model/form.ts';
import { displayOf } from './roots.ts';
import { isRuleName, RULES, Severity } from './rules.ts';
import { versionLines } from './version.ts';

// types

/** How beadc exits. */
export const Exit = Object.freeze({
  DONE: 0,
  FINDINGS: 1,
  INPUT: 2,
} as const);

export type Exit = (typeof Exit)[keyof typeof Exit];

// what a command reads, and what the call asks of it
interface ICall {
  readonly source: Source;
  /** `beadc.yaml`, when the call named no input. */
  readonly config?: IConfig;
  readonly output?: string;
  readonly format: ErrorFormat;
  readonly failOnWarning: boolean;
  readonly except: ReadonlySet<string>;
  readonly check: boolean;
  readonly descriptorSetOut?: string;
}

// constants

const USAGE = [
  'usage: beadc <command> [<root or blueprint>] [flags]',
  '  check                         refuses a .proto or a blueprint by rule name',
  '  blueprint -o <file>           writes the blueprint in its form',
  '  blueprint --check [-o <file>] holds a blueprint to its form, writing nothing',
  "  generate                      writes beadc.yaml's outputs",
  '  generate --check              holds them to what generate writes, writing nothing',
  '  version                       beadc, its tools, the format, the spec and the options',
  'flags: --error-format text|json|github, --fail-on-warning, --except <RULE> (a warning),',
  '       --descriptor-set-out <file> (blueprint, from a .proto)',
].join('\n');

// what GitHub titles a difference under each --check
const OFF_FORM = 'off its form';
const NOT_GENERATED = 'not what beadc generates';

// helpers

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const printError = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

// the call's source: the input named, a folder of .proto files or a blueprint's file; else beadc.yaml's
const sourceOf = (
  input: string | undefined
): { source: Source; output?: string; config?: IConfig } => {
  if (input !== undefined) {
    if (!existsSync(input)) {
      throw new InputError(`${input}: no such file or folder`);
    }

    return statSync(input).isDirectory()
      ? { source: { proto: [resolve(input)] } }
      : { source: { blueprint: resolve(input) } };
  }

  const config = findConfig(process.cwd());

  if (config === undefined) {
    throw new InputError('name a root or a blueprint, or run beadc where a beadc.yaml is');
  }

  const parsed = parseConfig(readFileSync(config, 'utf8'), { folder: dirname(config) });

  return {
    source: parsed.source,
    config: parsed,
    ...(parsed.blueprint === undefined ? {} : { output: parsed.blueprint }),
  };
};

const checkSource = (source: Source): IChecked => {
  return 'proto' in source
    ? checkRoots(source.proto)
    : checkBlueprintFile(source.blueprint, { file: displayOf(source.blueprint) });
};

// prints the findings a call keeps, and whether they fail it
const report = (diagnostics: readonly IDiagnostic[], call: ICall): boolean => {
  const kept = diagnostics.filter((diagnostic) => {
    return !call.except.has(diagnostic.rule);
  });

  for (const diagnostic of kept) {
    print(formatDiagnostic(diagnostic, call.format));
  }

  return (
    hasError(kept) ||
    (call.failOnWarning &&
      kept.some((diagnostic) => {
        return diagnostic.severity === Severity.WARNING;
      }))
  );
};

// prints a file that differs from what beadc writes, `difference.message` saying what and the fix,
// `title` naming the check for GitHub
const printDifference = (
  difference: IFormDifference,
  details: { readonly file: string; readonly call: ICall; readonly title: string }
): void => {
  const { file, call, title } = details;
  const { message } = difference;

  switch (call.format) {
    case ErrorFormat.TEXT: {
      const where =
        difference.pointer === undefined
          ? `${file}:${String(difference.line ?? 1)}`
          : `${file}#${difference.pointer}`;

      print(`${where}: ${message}`);
      break;
    }
    case ErrorFormat.JSON: {
      print(JSON.stringify({ file, ...difference, message }));
      break;
    }
    case ErrorFormat.GITHUB: {
      const line = difference.line === undefined ? '' : `,line=${String(difference.line)}`;

      print(`::error file=${file}${line},title=${title}::${message}`);
      break;
    }
  }
};

// writes `text` beside `path` first, then moves it over: a failure never shortens the file
const writeWhole = (path: string, data: Uint8Array): void => {
  const temporary = `${path}.tmp`;

  writeFileSync(temporary, data);
  renameSync(temporary, path);
};

// a difference under `blueprint --check`, with its fix
const formDifferenceOf = (difference: IFormDifference, file: string): IFormDifference => {
  return {
    ...difference,
    message: `${difference.message}; beadc blueprint -o ${file} writes it in its form`,
  };
};

const runCheck = (call: ICall): Exit => {
  return report(checkSource(call.source).diagnostics, call) ? Exit.FINDINGS : Exit.DONE;
};

const runBlueprint = (call: ICall): Exit => {
  const checked = checkSource(call.source);
  const failed = report(checked.diagnostics, call);

  if (checked.blueprint === undefined || failed) {
    return Exit.FINDINGS;
  }

  if (call.check) {
    const target = call.output ?? ('blueprint' in call.source ? call.source.blueprint : undefined);

    if (target === undefined) {
      throw new InputError(
        'blueprint --check over a .proto names the file to hold to its form, with -o'
      );
    }

    const file = displayOf(target);

    if (!existsSync(target)) {
      printDifference(formDifferenceOf({ message: 'no such file' }, file), {
        file,
        call,
        title: OFF_FORM,
      });
      return Exit.FINDINGS;
    }

    const differences = formDifferencesOf(
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(readFileSync(target)),
      checked.blueprint
    );

    for (const difference of differences) {
      printDifference(formDifferenceOf(difference, file), { file, call, title: OFF_FORM });
    }

    return differences.length === 0 ? Exit.DONE : Exit.FINDINGS;
  }

  if (call.output === undefined) {
    throw new InputError("blueprint names the file it writes, with -o or beadc.yaml's blueprint");
  }

  writeWhole(call.output, new TextEncoder().encode(formOf(checked.blueprint)));

  if (call.descriptorSetOut !== undefined && checked.set !== undefined) {
    writeWhole(call.descriptorSetOut, checked.set);
  }

  return Exit.DONE;
};

const runGenerate = async (call: ICall): Promise<Exit> => {
  const { config } = call;

  if (config === undefined) {
    throw new InputError("generate writes beadc.yaml's outputs, and takes no input of its own");
  }

  const checked = checkSource(call.source);

  if (report(checked.diagnostics, call)) {
    return Exit.FINDINGS;
  }

  // * the targets, and the compiler protoplugin loads, for generate alone
  const { differencesOf, planOf, writePlan } = await import('./generate.ts');
  const plan = planOf(config, checked);

  if (!call.check) {
    writePlan(plan, config);
    return Exit.DONE;
  }

  const differences = differencesOf(plan);

  for (const difference of differences) {
    printDifference(
      {
        message: difference.message,
        ...(difference.line === undefined ? {} : { line: difference.line }),
      },
      { file: displayOf(difference.path), call, title: NOT_GENERATED }
    );
  }

  return differences.length === 0 ? Exit.DONE : Exit.FINDINGS;
};

// the call, its flags checked: a format beadc prints, and a rule it knows that is a warning
const callOf = (
  values: Readonly<Record<string, string | boolean | string[] | undefined>>,
  input: string | undefined
): ICall => {
  const format = values['error-format'] ?? ErrorFormat.TEXT;
  const except = (values['except'] ?? []) as string[];

  if (!(Object.values(ErrorFormat) as unknown[]).includes(format)) {
    throw new InputError(`--error-format is text, json or github, not ${String(format)}`);
  }

  for (const rule of except) {
    if (!isRuleName(rule)) {
      throw new InputError(`--except ${rule}: no rule beadc knows`);
    }

    if (RULES[rule].severity !== Severity.WARNING) {
      throw new InputError(`--except ${rule}: an error, which --except never leaves out`);
    }
  }

  const { source, output, config } = sourceOf(input);
  const given = values['output'];
  const descriptorSetOut = values['descriptor-set-out'];

  return {
    source,
    ...(config === undefined ? {} : { config }),
    format: format as ErrorFormat,
    failOnWarning: values['fail-on-warning'] === true,
    except: new Set(except),
    check: values['check'] === true,
    ...(typeof given === 'string'
      ? { output: resolve(given) }
      : output === undefined
        ? {}
        : { output }),
    ...(typeof descriptorSetOut === 'string'
      ? { descriptorSetOut: resolve(descriptorSetOut) }
      : {}),
  };
};

// definition

/** Runs beadc with `args`, its command first, and gives its exit code. */
export const run = async (args: readonly string[]): Promise<Exit> => {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        'error-format': { type: 'string' },
        'fail-on-warning': { type: 'boolean' },
        except: { type: 'string', multiple: true },
        output: { type: 'string', short: 'o' },
        check: { type: 'boolean' },
        'descriptor-set-out': { type: 'string' },
      },
    });
    const [command, input, ...rest] = positionals;

    if (rest.length > 0) {
      throw new InputError(`one input at most, not ${String(rest.length + 1)}`);
    }

    if (command === undefined) {
      throw new InputError(USAGE);
    }

    switch (command) {
      case 'version': {
        for (const line of versionLines()) {
          print(line);
        }
        return Exit.DONE;
      }
      case 'check': {
        return runCheck(callOf(values, input));
      }
      case 'blueprint': {
        return runBlueprint(callOf(values, input));
      }
      case 'generate': {
        return await runGenerate(callOf(values, input));
      }
      default: {
        throw new InputError(`${command}: no command of beadc's\n${USAGE}`);
      }
    }
  } catch (error) {
    if (
      error instanceof InputError ||
      (error as { code?: unknown }).code?.toString().startsWith('ERR_PARSE_ARGS')
    ) {
      printError(`beadc: ${(error as Error).message}`);
      return Exit.INPUT;
    }

    throw error;
  }
};

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2));
}
