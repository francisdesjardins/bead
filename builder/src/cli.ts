// ── beadc ─────────────────────────────────────────────────────────────────────

// beadc's command line: `check`, `blueprint`, `generate`, `breaking`, `init`, `wrapper` and `version`
// (decision 0022). It parses the call, runs the command, prints each finding a line, and exits 0, 1
// on an error — a warning too under `--fail-on-warning`, a difference under `blueprint --check` or
// `generate --check`, a breaking finding — or 2 when the input or the call is one beadc cannot
// take, a path the file system refuses among them, in one line. `generate` and `init` alone load the
// targets, by a dynamic import: they load a TypeScript compiler, which the other commands never
// need.
//
//   node src/cli.ts check [<root or blueprint>]
//   node src/cli.ts blueprint [<root or blueprint>] -o <file> [--descriptor-set-out <file>]
//   node src/cli.ts blueprint --check [<root or blueprint>] [-o <file>]
//   node src/cli.ts generate [--check]
//   node src/cli.ts breaking [<root or blueprint>] --against <folder, - or blueprint>
//     [--category WIRE|API]
//   node src/cli.ts init <name> [--language typescript|csharp]...
//   node src/cli.ts wrapper beadc.sh|beadc.ps1
//   node src/cli.ts version

// dependencies

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { readStandardInput, STANDARD_INPUT } from './breaking/against.ts';
import { breaking } from './breaking/breaking.ts';
import { checkBlueprintFile, checkRoots, type IChecked } from './check.ts';
import { findConfig, type IConfig, parseConfig, type Source } from './config.ts';
import {
  ErrorFormat,
  escapeData,
  escapeProperty,
  formatDiagnostic,
  githubFileOf,
  hasError,
  type IDiagnostic,
  InputError,
} from './diagnostics.ts';
import { formDifferencesOf, formOf, type IFormDifference } from './model/form.ts';
import { displayOf } from './roots.ts';
import { Category, isRuleName, RULES, Severity } from './rules.ts';
import { beadcVersion, versionLines } from './version.ts';
import { isWrapperName, WRAPPERS, wrapperText } from './wrappers.ts';

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
  /** `breaking`'s: the earlier, and the category its rules run under. */
  readonly against?: string;
  readonly category: Category;
}

// constants

const USAGE = [
  'usage: beadc <command> [<root or blueprint>] [flags]',
  '  check                         refuses a .proto or a blueprint by rule name',
  '  blueprint -o <file>           writes the blueprint in its form',
  '  blueprint --check [-o <file>] holds a blueprint to its form, writing nothing',
  "  generate                      writes beadc.yaml's outputs",
  '  generate --check              holds them to what generate writes, writing nothing',
  '  breaking --against <folder, - or blueprint>',
  '                                holds the input to an earlier release, writing nothing',
  '  init <name>                   writes a project here, its .proto, its beadc.yaml and its wrappers',
  "  wrapper beadc.sh|beadc.ps1    prints a wrapper that runs beadc's image",
  '  version                       beadc, its tools, the format, the spec and the options',
  'flags: --error-format text|json|github, --fail-on-warning, --except <RULE> (a warning),',
  '       --descriptor-set-out <file> (blueprint, from a .proto),',
  '       --category WIRE|API (breaking, API by default), --except <RULE>@<subject> or',
  '       buf:<RULE>@<path> (breaking, any finding: a subject as its line prints it)',
  '       --language typescript|csharp (init, repeated; both when none is named)',
].join('\n');

// what GitHub titles a difference under each --check
const OFF_FORM = 'off its form';
const NOT_GENERATED = 'not what beadc generates';

// the wrappers' own flag, which reads a git ref beadc on Node never sees
const AGAINST_REF = '--against-ref';

// the file system's refusals, each a call beadc cannot take: a folder missing or a file where one is
// meant, a file where a folder is meant, one there already, no right, no room
const FILE_SYSTEM = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EACCES', 'EPERM', 'ENOSPC']);

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

      print(
        `::error file=${escapeProperty(githubFileOf(file))}${line},title=${escapeProperty(title)}::${escapeData(message)}`
      );
      break;
    }
  }
};

// writes `data` beside `path` first, its folder made, then moves it over: a failure never shortens
// the file, and leaves no `.tmp` behind
const writeWhole = (path: string, data: Uint8Array): void => {
  const temporary = `${path}.tmp`;

  mkdirSync(dirname(path), { recursive: true });

  try {
    writeFileSync(temporary, data);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
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

    for (const { path, source } of plan.stale) {
      print(`beadc: generate takes out ${displayOf(path)}: ${source} no longer gives it`);
    }

    for (const { path, source } of plan.left) {
      print(
        `beadc: generate leaves ${displayOf(path)}: ${source} no longer gives it; take it out, or set clean: true`
      );
    }

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

const runBreaking = async (call: ICall): Promise<Exit> => {
  if (call.against === undefined) {
    throw new InputError('breaking names the earlier, with --against <folder, - or blueprint>');
  }

  const archive = call.against === STANDARD_INPUT ? await readStandardInput() : undefined;
  const run = breaking(call.source, {
    against: call.against,
    category: call.category,
    except: [...call.except],
    ...(call.config === undefined ? {} : { config: call.config }),
    ...(archive === undefined ? {} : { archive }),
  });

  return report(run.diagnostics, call) ? Exit.FINDINGS : Exit.DONE;
};

const runInit = async (name: string | undefined, languages: readonly string[]): Promise<Exit> => {
  // * the editor's copy is written as generate writes it, which loads the targets
  const { initLines, initProject } = await import('./init.ts');
  const initialized = initProject(name, {
    folder: process.cwd(),
    version: beadcVersion(),
    languages,
  });

  for (const line of initLines(initialized)) {
    print(line);
  }

  return Exit.DONE;
};

const runWrapper = (name: string | undefined): Exit => {
  if (name === undefined || !isWrapperName(name)) {
    throw new InputError(`wrapper names one of ${WRAPPERS.join(' and ')}, not ${String(name)}`);
  }

  process.stdout.write(wrapperText(name, { version: beadcVersion() }));

  return Exit.DONE;
};

// the call, its flags checked: a format beadc prints, and a rule it knows that is a warning; on
// `breaking`, its category, its waivers checked by breaking itself
const callOf = (
  values: Readonly<Record<string, string | boolean | string[] | undefined>>,
  details: { readonly input: string | undefined; readonly command: string }
): ICall => {
  const { input, command } = details;
  const format = values['error-format'] ?? ErrorFormat.TEXT;
  const except = (values['except'] ?? []) as string[];
  const category = values['category'] ?? Category.API;
  const against = values['against'];

  if (!(Object.values(ErrorFormat) as unknown[]).includes(format)) {
    throw new InputError(`--error-format is text, json or github, not ${String(format)}`);
  }

  if (!(Object.values(Category) as unknown[]).includes(category)) {
    throw new InputError(`--category is WIRE or API, not ${String(category)}`);
  }

  for (const rule of command === 'breaking' ? [] : except) {
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
    ...(typeof against === 'string' ? { against } : {}),
    category: category as Category,
  };
};

// definition

/** Runs beadc with `args`, its command first, and gives its exit code. */
export const run = async (args: readonly string[]): Promise<Exit> => {
  try {
    // ! a wrapper's flag, given to beadc on Node: named, with the form that does its work here
    if (
      args.some((arg) => {
        return arg === AGAINST_REF || arg.startsWith(`${AGAINST_REF}=`);
      })
    ) {
      throw new InputError(
        `${AGAINST_REF} is the wrappers' own: on Node, pipe git archive <ref> into --against -`
      );
    }

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
        language: { type: 'string', multiple: true },
        against: { type: 'string' },
        category: { type: 'string' },
      },
    });
    const [command, input, ...rest] = positionals;

    if (rest.length > 0) {
      throw new InputError(`one input at most, not ${String(rest.length + 1)}`);
    }

    if (command === undefined) {
      throw new InputError(USAGE);
    }

    if (values.language !== undefined && command !== 'init') {
      throw new InputError(`--language is init's, not ${command}'s`);
    }

    for (const flag of ['against', 'category'] as const) {
      if (values[flag] !== undefined && command !== 'breaking') {
        throw new InputError(`--${flag} is breaking's, not ${command}'s`);
      }
    }

    switch (command) {
      case 'version': {
        for (const line of versionLines()) {
          print(line);
        }
        return Exit.DONE;
      }
      case 'check': {
        return runCheck(callOf(values, { input, command }));
      }
      case 'blueprint': {
        return runBlueprint(callOf(values, { input, command }));
      }
      case 'generate': {
        return await runGenerate(callOf(values, { input, command }));
      }
      case 'breaking': {
        return await runBreaking(callOf(values, { input, command }));
      }
      case 'init': {
        return await runInit(input, values.language ?? []);
      }
      case 'wrapper': {
        return runWrapper(input);
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

    // * a path the file system refuses is a call beadc cannot take: one line, never a stack
    const { code, path, syscall } = error as { code?: unknown; path?: unknown; syscall?: unknown };

    if (typeof code === 'string' && FILE_SYSTEM.has(code)) {
      printError(
        `beadc: ${typeof path === 'string' ? displayOf(path) : 'a path'}: ${code}${typeof syscall === 'string' ? ` on ${syscall}` : ''}, which the file system refuses`
      );
      return Exit.INPUT;
    }

    throw error;
  }
};

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2));
}
