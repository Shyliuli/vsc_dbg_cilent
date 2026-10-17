import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeLaunchConfigurations,
  parseJsonc,
  readLaunchFile,
  splitCommandLine,
  substituteVariables,
  writeLaunchFile,
} from '../server/launchConfig.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = path.join(ROOT, '.scratch');
await mkdir(SCRATCH, { recursive: true });

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(SCRATCH, 'launch-config-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('splitCommandLine honors quotes and escapes', () => {
  assert.deepEqual(splitCommandLine('-ex "set pagination off"'), ['-ex', 'set pagination off']);
  assert.deepEqual(splitCommandLine("--eval='a b' c\\ d"), ['--eval=a b', 'c d']);
  assert.deepEqual(splitCommandLine('  one   two  '), ['one', 'two']);
  assert.throws(() => splitCommandLine('"unterminated'), /unterminated quote/);
});

test('substituteVariables expands workspace, file and env variables', () => {
  const warnings: string[] = [];
  process.env.GDB_CLIENT_TEST_VALUE = 'from-env';
  const result = substituteVariables(
    '${workspaceFolder}/build/${fileBasenameNoExtension} ${env:GDB_CLIENT_TEST_VALUE} ${unknown:thing}',
    { workspaceFolder: '/work', focusedFile: '/work/src/main.cpp' },
    warnings,
  );
  assert.equal(result, '/work/build/main from-env ${unknown:thing}');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unsupported variable/);
  delete process.env.GDB_CLIENT_TEST_VALUE;
});

test('parseJsonc accepts comments and trailing commas', () => {
  const { value, errors } = parseJsonc(`{
    // a comment
    "configurations": [ { "name": "x", }, ],
  }`);
  assert.deepEqual(errors, []);
  assert.equal((value as { configurations: unknown[] }).configurations.length, 1);
});

test('normalizes a launch configuration', () => {
  const { configs, errors } = normalizeLaunchConfigurations(
    {
      version: '0.2.0',
      configurations: [
        {
          name: 'launch demo',
          type: 'cppdbg',
          request: 'launch',
          program: '${workspaceFolder}/build/demo',
          args: ['one', '${workspaceFolder}/two'],
          cwd: '${workspaceFolder}/examples',
          env: { A: '1', B: null },
          environment: [{ name: 'C', value: '3' }],
          stopAtEntry: true,
          miDebuggerPath: '/usr/bin/gdb',
          miDebuggerArgs: '-q -nx',
          additionalSOLibSearchPath: ['/libs', '/more'],
          sourceFileMap: { '/build': '/home/me/build' },
          setupCommands: [{ text: 'set pagination off', ignoreFailures: true }],
        },
      ],
    },
    '/work',
  );
  assert.deepEqual(errors, []);
  const config = configs[0];
  assert.equal(config.program, '/work/build/demo');
  assert.equal(config.cwd, '/work/examples');
  assert.deepEqual(config.args, ['one', '/work/two']);
  assert.deepEqual(config.env, { C: '3', A: '1' });
  assert.equal(config.stopAtBeginningOfMainSubprogram, true);
  assert.equal(config.console, 'internalConsole');
  assert.equal(config.miDebuggerPath, '/usr/bin/gdb');
  assert.deepEqual(config.miDebuggerArgs, ['-q', '-nx']);
  assert.equal(config.setupCommands[0].text, 'set solib-search-path /libs:/more');
  assert.equal(config.setupCommands[1].text, 'set pagination off');
  assert.equal(config.setupCommands[1].ignoreFailures, true);
  assert.deepEqual(config.sourceFileMap, { '/build': '/home/me/build' });
  assert.ok(config.warnings.some((warning) => warning.includes('cannot unset environment variable B')));
});

test('reports invalid configurations individually', () => {
  const { configs, errors } = normalizeLaunchConfigurations(
    {
      configurations: [
        { name: 'no program', request: 'launch' },
        { name: 'attach with picker', request: 'attach', processId: '${command:pickProcess}' },
        { name: 'attach without pid', request: 'attach' },
      ],
    },
    '/work',
  );
  assert.equal(configs.length, 1);
  assert.equal(configs[0].name, 'attach with picker');
  assert.equal(configs[0].pickProcess, true);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /program/);
  assert.match(errors[1], /processId/);
});

test('accepts integratedTerminal and rejects external terminals with a warning', () => {
  const { configs, errors } = normalizeLaunchConfigurations(
    {
      configurations: [
        { name: 'pty', request: 'launch', program: '/work/a.out', console: 'integratedTerminal' },
        {
          name: 'external',
          request: 'launch',
          program: '/work/a.out',
          console: 'externalTerminal',
          externalConsole: true,
        },
        {
          name: 'attach pty',
          request: 'attach',
          processId: '${command:pickProcess}',
          console: 'integratedTerminal',
        },
      ],
    },
    '/work',
  );
  assert.deepEqual(errors, []);
  assert.equal(configs[0].console, 'integratedTerminal');
  assert.equal(configs[1].console, 'internalConsole');
  assert.ok(configs[1].warnings.some((warning) => warning.includes('externalTerminal')));
  assert.equal(configs[2].console, 'internalConsole');
  assert.ok(
    configs[2].warnings.some((warning) => warning.includes('only available for launch')),
  );
});

test('applyPlatformOverrides merges the current platform block', () => {
  const { configs } = normalizeLaunchConfigurations(
    {
      configurations: [
        {
          name: 'platform',
          request: 'launch',
          program: '/base',
          linux: { program: '/linux' },
        },
      ],
    },
    '/work',
  );
  const expected = process.platform === 'linux' ? '/linux' : '/base';
  assert.equal(configs[0].program, expected);
});

test('reads and writes .vscode/launch.json', async () => {
  await withWorkspace(async (root) => {
    const content = `{
  // comment preserved for humans
  "version": "0.2.0",
  "configurations": [
    { "name": "demo", "request": "launch", "program": "\${workspaceFolder}/a.out" },
  ],
}`;
    const written = await writeLaunchFile(root, content);
    assert.equal(written.configs.length, 1);
    assert.equal(written.configs[0].program, path.join(root, 'a.out'));
    assert.equal(await readFile(path.join(root, '.vscode', 'launch.json'), 'utf8'), content);

    const readBack = await readLaunchFile(root);
    assert.equal(readBack.configs.length, 1);

    const missingRoot = await mkdtemp(path.join(SCRATCH, 'launch-empty-'));
    try {
      const missing = await readLaunchFile(missingRoot);
      assert.equal(missing.exists, false);
      assert.deepEqual(missing.configs, []);
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
    }
  });
});

test('writeLaunchFile reports parse errors without dropping the file', async () => {
  await withWorkspace(async (root) => {
    const result = await writeLaunchFile(root, '{ "configurations": [ }');
    assert.ok(result.errors.length > 0);
    assert.equal(result.exists, true);
    assert.match(await readFile(path.join(root, '.vscode', 'launch.json'), 'utf8'), /configurations/);
  });
});
