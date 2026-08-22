#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(core, '..');
const ledger = join(repository, 'juno_kanban');
const python = join(ledger, '.venv', 'bin', 'python');
const temporary = mkdtempSync(join(tmpdir(), 'yylo-ledger-release-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repository,
    env: options.env ?? process.env,
    input: options.input ?? '',
    encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.error?.code ?? result.status ?? result.signal}):\n${result.stderr || result.stdout || result.error?.message}`);
  }
  return result;
}

try {
  const wheels = join(temporary, 'wheels'); const packs = join(temporary, 'packs');
  mkdirSync(wheels); mkdirSync(packs);
  run(python, ['-m', 'build', '--wheel', '--outdir', wheels], { cwd: ledger });
  const wheel = join(wheels, readdirSync(wheels).find((name) => /^yylo_ledger-0\.1\.0rc1-.*\.whl$/u.test(name)) ?? 'missing');
  const packed = run('npm', ['pack', '--silent', '--json', '--pack-destination', packs], { cwd: core });
  const records = JSON.parse(packed.stdout.slice(Math.max(0, packed.stdout.lastIndexOf('\n[') + 1)));
  const archive = join(packs, records[0].filename);
  const venv = join(temporary, 'venv'); const prefix = join(temporary, 'prefix');
  run(python, ['-m', 'venv', venv]);
  run(join(venv, 'bin', 'python'), ['-m', 'pip', 'install', wheel]);
  run('npm', ['install', '--ignore-scripts', '--prefix', prefix, archive]);
  const bin = join(prefix, 'node_modules', '.bin');
  const env = { ...process.env, PATH: `${join(venv, 'bin')}${delimiter}${bin}${delimiter}${process.env.PATH ?? ''}` };
  const standalone = join(venv, 'bin', 'yylo-ledger'); const yy = join(bin, 'yy'); const yylo = join(bin, 'yylo');
  for (const args of [['--version'], ['--help']]) {
    const expected = run(standalone, args, { env });
    for (const launcher of [yy, yylo]) {
      const delegated = run(launcher, ['ledger', ...args], { env });
      if (delegated.stdout !== expected.stdout || delegated.stderr !== expected.stderr) {
        throw new Error(`${launcher} ledger ${args.join(' ')} differs from standalone YYLO Ledger`);
      }
    }
  }
  process.stdout.write('YYLO Ledger packed standalone/delegate parity passed\n');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
