import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { parseArgs, parsePortArg } from '../src/cli.js';
import { parseEtime } from '../src/proc.js';
import { parseLsofFields, parseSsPids, portOf } from '../src/scan.js';
import { formatAge, truncate, confirm, setColor } from '../src/ui.js';

setColor(false);

test('parsePortArg accepts the shapes people actually paste', () => {
  assert.deepEqual(parsePortArg('3000'), [3000]);
  assert.deepEqual(parsePortArg(':3000'), [3000]);
  assert.deepEqual(parsePortArg('localhost:5173'), [5173]);
  assert.deepEqual(parsePortArg('http://localhost:5173/some/path'), [5173]);
  assert.deepEqual(parsePortArg('127.0.0.1:8080'), [8080]);
  assert.deepEqual(parsePortArg('3000-3003'), [3000, 3001, 3002, 3003]);
});

test('parsePortArg rejects nonsense', () => {
  assert.throws(() => parsePortArg('nope'), /Not a port/);
  assert.throws(() => parsePortArg('0'), /out of range/);
  assert.throws(() => parsePortArg('70000'), /out of range/);
  assert.throws(() => parsePortArg('3010-3000'), /Empty port range/);
  assert.throws(() => parsePortArg('1-9999'), /too wide/);
});

test('parseArgs reads flags and dedupes ports', () => {
  const opts = parseArgs(['3000', '--kill', '5173', '-f', '3000', '--timeout', '500']);
  assert.deepEqual(opts.ports, [3000, 5173]);
  assert.equal(opts.kill, true);
  assert.equal(opts.force, true);
  assert.equal(opts.timeout, 500);
});

test('parseArgs rejects unknown options and bad timeouts', () => {
  assert.throws(() => parseArgs(['--wat']), /Unknown option/);
  assert.throws(() => parseArgs(['--timeout', 'soon']), /milliseconds/);
});

test('parseArgs treats everything after -- as a port', () => {
  assert.deepEqual(parseArgs(['--', '3000']).ports, [3000]);
});

test('parseEtime understands the ps elapsed-time format', () => {
  assert.equal(parseEtime('45'), null); // ps always prints at least MM:SS
  assert.equal(parseEtime('00:45'), 45);
  assert.equal(parseEtime('02:14:03'), 8043);
  assert.equal(parseEtime('1-03:00:00'), 97200);
  assert.equal(parseEtime('garbage'), null);
  assert.equal(parseEtime(''), null);
});

test('formatAge stays to two units', () => {
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(45), '45s');
  assert.equal(formatAge(8043), '2h 14m');
  assert.equal(formatAge(400000), '4d 15h');
  assert.equal(formatAge(null), 'unknown');
});

test('truncate never exceeds its budget', () => {
  assert.equal(truncate('next dev', 20), 'next dev');
  assert.equal(truncate('a'.repeat(30), 10).length, 10);
  assert.ok(truncate('a'.repeat(30), 10).endsWith('...'));
});

test('portOf handles every address form lsof/netstat emit', () => {
  assert.equal(portOf('*:3000'), 3000);
  assert.equal(portOf('127.0.0.1:3000'), 3000);
  assert.equal(portOf('[::1]:3000'), 3000);
  assert.equal(portOf('0.0.0.0:8080'), 8080);
  assert.equal(portOf('not-an-address'), null);
  assert.equal(portOf(''), null);
});

test('parseLsofFields groups socket names under their pid', () => {
  const out = ['p48192', 'cnode', 'n*:3000', 'n127.0.0.1:5173', 'p99', 'cpostgres', 'n*:5432', ''].join('\n');
  assert.deepEqual(parseLsofFields(out), [
    { pid: 48192, name: '*:3000' },
    { pid: 48192, name: '127.0.0.1:5173' },
    { pid: 99, name: '*:5432' },
  ]);
});

test('parseSsPids pulls pids out of the users:(...) column', () => {
  assert.deepEqual(parseSsPids('LISTEN 0 511 *:3000 *:* users:(("node",pid=48192,fd=20))'), [48192]);
  assert.deepEqual(parseSsPids('LISTEN 0 511 *:3000 *:*'), []);
});

test('confirm resolves from a fake tty and returns null without one', async () => {
  const ask = (answer) => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    output.isTTY = true;
    output.resume();
    const pending = confirm('Kill it?', { input, output });
    input.write(answer);
    return pending;
  };
  assert.equal(await ask('y\n'), true);
  assert.equal(await ask('yes\n'), true);
  assert.equal(await ask('n\n'), false);
  assert.equal(await ask('\n'), false); // default is no
  assert.equal(await confirm('Kill it?', { input: new PassThrough(), output: new PassThrough() }), null);
});
