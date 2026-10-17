import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { InputError } from '../../diagnostics.ts';
import { Category, Severity } from '../../rules.ts';
import { againstOf, againstOfFolder, type IEarlier } from '../against.ts';
import { breaking } from '../breaking.ts';

const INTEROP = fileURLToPath(new URL('../../../../spec/interop-blueprint.json', import.meta.url));
const EARLIER = fileURLToPath(new URL('../../../test/breaking/proto/earlier/', import.meta.url));
const SHOP_BLUEPRINT = fileURLToPath(
  new URL(
    '../../../test/breaking/proto/PROTO_SKIPPED/against-a-blueprint/earlier/shop.blueprint.json',
    import.meta.url
  )
);
const SHOP = 'shop/v1/shop.proto';

// a copy of the .proto cases' earlier in the running test's output folder, its beadc.yaml `config`
// when given, a blueprint committed beside it when `committed` gives one
const project = (
  name: string,
  options: { readonly config?: string; readonly committed?: string } = {}
): string => {
  const folder = test.info().outputPath(name);

  cpSync(join(EARLIER, 'proto'), join(folder, 'proto'), { recursive: true });

  if (options.config !== undefined) {
    writeFileSync(join(folder, 'beadc.yaml'), options.config);
  }

  if (options.committed !== undefined) {
    mkdirSync(join(folder, 'gen'), { recursive: true });
    writeFileSync(join(folder, 'gen', 'shop.blueprint.json'), options.committed);
  }

  return folder;
};

const WITH_BLUEPRINT =
  'version: 1\nsource:\n  proto: [proto]\nblueprint: gen/shop.blueprint.json\n';

// the shop's blueprint as a release committed it, procedure 1 named as an earlier beadc named it
const committedBlueprint = (): string => {
  return readFileSync(SHOP_BLUEPRINT, 'utf8').replace('"getPrice"', '"getThePrice"');
};

test("a folder gives its committed blueprint to Bead's rules and its .proto to buf's", () => {
  const folder = project('committed', { config: WITH_BLUEPRINT, committed: committedBlueprint() });
  const earlier = againstOfFolder(folder, { current: { proto: [folder] }, name: 'earlier' });

  expect(earlier.blueprint.services[0]?.procedures[0]?.procedureName).toBe('getThePrice');
  expect(earlier.image).toBeDefined();
  expect(earlier.fromProto).toBe(true);
  expect(earlier.skipped).toBeUndefined();
});

test("a folder without one is compiled by its own beadc.yaml, else by the current one's roots", () => {
  const own = project('own', { config: WITH_BLUEPRINT });
  const bare = project('bare');
  const named = test.info().outputPath('named');

  cpSync(join(EARLIER, 'proto'), named, { recursive: true });

  // its own beadc.yaml, the blueprint it names not committed
  expect(
    againstOfFolder(own, { current: { proto: [own] }, name: 'own' }).blueprint.services[0]
      ?.procedures[0]?.procedureName
  ).toBe('getPrice');

  // none: the current beadc.yaml's roots, taken from its folder into this one
  const config = { folder: '/project', source: { proto: [join('/project', 'proto')] } };
  const fromConfig = againstOfFolder(bare, {
    current: config.source,
    config,
    name: 'bare',
  });

  expect(
    fromConfig.blueprint.services.map((service) => {
      return service.serviceName;
    })
  ).toEqual(['Shop', 'Ledger']);
  expect(fromConfig.image).toBeDefined();

  // none, and a root named on the command line: the folder itself as that root
  expect(
    againstOfFolder(named, {
      current: { proto: [EARLIER] },
      name: 'named',
    }).blueprint.proto?.files.map((file) => {
      return file.path;
    })
  ).toEqual([SHOP]);

  expect(() => {
    return againstOfFolder(named, { current: { blueprint: INTEROP }, name: 'named' });
  }).toThrow(InputError);
});

test('an earlier .proto this beadc refuses is PROTO_SKIPPED beside a committed blueprint, exit 2 without one', () => {
  const refused = (name: string, committed?: string): string => {
    const folder = project(name, {
      config: WITH_BLUEPRINT,
      ...(committed === undefined ? {} : { committed }),
    });
    const path = join(folder, 'proto', ...SHOP.split('/'));

    // an option an earlier beadc took, which this one does not know
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('      id: 1\n', '      id: 1\n      weight: 3\n')
    );
    return folder;
  };
  const beside = refused('beside', readFileSync(SHOP_BLUEPRINT, 'utf8'));
  const earlier = againstOfFolder(beside, { current: { proto: [EARLIER] }, name: 'beside' });

  expect(earlier.image).toBeUndefined();
  expect(earlier.skipped).toMatch(/shop\.proto:36:7/u);

  const run = breaking(
    { proto: [join(EARLIER, 'proto')] },
    { against: beside, category: Category.API }
  );

  expect(
    run.diagnostics.map((diagnostic) => {
      return diagnostic.rule;
    })
  ).toEqual(['PROTO_SKIPPED']);
  expect(run.diagnostics[0]?.message).toMatch(/does not compile: .*shop\.proto:36:7/u);
  expect(() => {
    return againstOfFolder(refused('alone'), { current: { proto: [EARLIER] }, name: 'alone' });
  }).toThrow(/^the earlier, alone: .*shop\.proto:36:7/u);
});

test('a blueprint against a .proto gives PROTO_SKIPPED; the interop against itself gives none', () => {
  const run = breaking(
    { proto: [join(EARLIER, 'proto')] },
    { against: SHOP_BLUEPRINT, category: Category.API }
  );

  expect(
    run.diagnostics.map((diagnostic) => {
      return diagnostic.rule;
    })
  ).toEqual(['PROTO_SKIPPED']);
  expect(run.diagnostics[0]?.message).toMatch(/a blueprint alone/u);
  expect(
    breaking({ blueprint: INTEROP }, { against: INTEROP, category: Category.API }).diagnostics
  ).toEqual([]);
});

test('a .binpb is refused, exit 2', () => {
  const set = test.info().outputPath('earlier.binpb');
  const text = test.info().outputPath('earlier.json');

  writeFileSync(set, new Uint8Array([0x0a, 0x02, 0x08, 0x01]));
  writeFileSync(text, 'no JSON');

  for (const path of [set, text]) {
    expect(() => {
      return againstOf(path, { current: { blueprint: INTEROP } });
    }, path).toThrow(/its tag's: name its folder, pipe its git archive to --against -/u);
  }
});

test('an earlier blueprint is read through its schema, never its rules', () => {
  const twice = test.info().outputPath('twice.json');
  const outOfRange = test.info().outputPath('out-of-range.json');
  const interop = readFileSync(INTEROP, 'utf8');

  // two names one as 16.6 folds them, which NAME_UNIQUE refuses today
  writeFileSync(twice, interop.replace('"procedureName": "fail"', '"procedureName": "eCho"'));
  writeFileSync(outOfRange, interop.replace('"serviceId": 1', '"serviceId": 0'));

  expect(
    againstOf(twice, { current: { blueprint: INTEROP } }).blueprint.services[0]?.procedures[1]
      ?.procedureName
  ).toBe('eCho');
  expect(() => {
    return againstOf(outOfRange, { current: { blueprint: INTEROP } });
  }).toThrow(
    /is no bead-blueprint\/1 this beadc reads: SERVICE_ID_RANGE at \/services\/0\/serviceId/u
  );
});

test('an earlier beadc.yaml is read for its source and blueprint alone', () => {
  const folder = project('later', {
    config: [
      'version: 1',
      'source:',
      '  proto: [proto]',
      'blueprint: gen/shop.blueprint.json',
      'lint: strict',
      'outputs:',
      '  - language: typescript',
      '    out: gen/typescript',
      '    dropped: true',
      '',
    ].join('\n'),
    committed: committedBlueprint(),
  });

  expect(
    againstOfFolder(folder, { current: { proto: [folder] }, name: 'later' }).blueprint.services[0]
      ?.procedures[0]?.procedureName
  ).toBe('getThePrice');
});

test("a committed blueprint its .proto contradicts, or one named and missing, is AGAINST_BLUEPRINT's warning", () => {
  const read = (folder: string, name: string): IEarlier => {
    return againstOfFolder(folder, { current: { proto: [EARLIER] }, name });
  };
  const contradicted = read(
    project('contradicted', { config: WITH_BLUEPRINT, committed: committedBlueprint() }),
    'contradicted'
  );
  const agreeing = read(
    project('agreeing', {
      config: WITH_BLUEPRINT,
      committed: readFileSync(SHOP_BLUEPRINT, 'utf8'),
    }),
    'agreeing'
  );
  const missing = read(project('missing', { config: WITH_BLUEPRINT }), 'missing');

  // * the release's blueprint and its .proto compared by id, the first finding named
  expect(contradicted.diagnostics).toEqual([
    {
      rule: 'AGAINST_BLUEPRINT',
      severity: Severity.WARNING,
      file: 'contradicted',
      message: expect.stringMatching(
        /^the earlier's committed blueprint, gen\/shop\.blueprint\.json, and its \.proto disagree, PROCEDURE_SAME_NAME first: procedure 1 getThePrice of service 1 Shop is getPrice now/u
      ),
    },
  ]);
  expect(agreeing.diagnostics).toBeUndefined();
  expect(
    missing.diagnostics?.map((diagnostic) => {
      return diagnostic.message;
    })
  ).toEqual([
    "the earlier's beadc.yaml names its blueprint, gen/shop.blueprint.json, which is not there: Bead's rules read its .proto",
  ]);

  // a warning among the run's findings, which --fail-on-warning holds
  const run = breaking(
    { proto: [join(EARLIER, 'proto')] },
    {
      against: project('run', { config: WITH_BLUEPRINT, committed: committedBlueprint() }),
      category: Category.API,
      except: [
        'PROCEDURE_SAME_NAME@service:1/procedure:1',
        'NAME_NO_DELETE@service:1/procedure:1',
        'SERVICE_REVISION@service:1',
      ],
    }
  );

  expect(
    run.diagnostics.map((diagnostic) => {
      return `${diagnostic.rule} ${diagnostic.severity}`;
    })
  ).toEqual(['AGAINST_BLUEPRINT warning']);
});

test('--except PROTO_SKIPPED and --except AGAINST_BLUEPRINT leave their warnings out, bare, and no waiver goes unused', () => {
  const skipped = breaking(
    { proto: [join(EARLIER, 'proto')] },
    { against: SHOP_BLUEPRINT, category: Category.API, except: ['PROTO_SKIPPED'] }
  );
  const contradicted = breaking(
    { proto: [join(EARLIER, 'proto')] },
    {
      against: project('waived', { config: WITH_BLUEPRINT, committed: committedBlueprint() }),
      category: Category.API,
      except: [
        'AGAINST_BLUEPRINT',
        'PROCEDURE_SAME_NAME@service:1/procedure:1',
        'NAME_NO_DELETE@service:1/procedure:1',
        'SERVICE_REVISION@service:1',
      ],
    }
  );

  expect(skipped.diagnostics).toEqual([]);
  expect(contradicted.diagnostics).toEqual([]);
});
