import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { parseArgs, parsePortArg, portFreedom } from '../src/cli.js';
import { parseEtime, parseWmiDate, basename, selfAncestry } from '../src/proc.js';
import { parseLsofFields, parseSsPids, portOf, scanListeners, isConnected } from '../src/scan.js';
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

/* ------------------------- scanListeners (injected) ----------------------- */

/** A fake `run` that returns canned output and records every invocation. */
function fakeRunner(responses) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    for (const [match, value] of responses) {
      if (match(cmd, args)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    return '';
  };
  return { run, calls };
}

const enoent = () => Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });

const lsofTcp = (cmd, args) => cmd === 'lsof' && args.includes('-iTCP');
const lsofUdp = (cmd, args) => cmd === 'lsof' && args.includes('-iUDP');

test('scanListeners buckets one payload across several ports', async () => {
  const { run } = fakeRunner([
    [lsofTcp, ['p48192', 'cnode', 'n*:3000', 'n127.0.0.1:5173', 'p99', 'cpostgres', 'n*:5432', ''].join('\n')],
    [lsofUdp, ''],
  ]);
  const byPort = await scanListeners({ run, platform: 'darwin' });

  assert.deepEqual([...byPort.keys()], [3000, 5173, 5432]);
  assert.deepEqual(byPort.get(3000).map((h) => h.pid), [48192]);
  assert.deepEqual(byPort.get(5173).map((h) => h.pid), [48192]);
  assert.deepEqual(byPort.get(5432).map((h) => h.pid), [99]);
  assert.deepEqual([...byPort.get(3000)[0].protocols], ['tcp']);
});

test('scanListeners costs the same two calls for 1 port as for 500', async () => {
  const payload = ['p48192', 'cnode', 'n*:3000', ''].join('\n');
  const one = fakeRunner([[lsofTcp, payload], [lsofUdp, '']]);
  await scanListeners({ ports: [3000], run: one.run, platform: 'darwin' });

  const many = fakeRunner([[lsofTcp, payload], [lsofUdp, '']]);
  const ports = Array.from({ length: 500 }, (_, i) => 3000 + i);
  const byPort = await scanListeners({ ports, run: many.run, platform: 'darwin' });

  // Two calls (TCP + UDP) regardless of port count. Guards against anyone
  // reintroducing a per-port scan loop.
  assert.equal(one.calls.length, 2);
  assert.equal(many.calls.length, 2);
  assert.deepEqual([...byPort.keys()], [3000]);
});

test('scanListeners filters to the requested ports', async () => {
  const { run } = fakeRunner([
    [lsofTcp, ['p1', 'n*:3000', 'p2', 'n*:9999', ''].join('\n')],
    [lsofUdp, ''],
  ]);
  const byPort = await scanListeners({ ports: [3000], run, platform: 'darwin' });
  assert.deepEqual([...byPort.keys()], [3000]);
});

test('scanListeners ignores connected sockets, so a remote :443 is not a local listener', async () => {
  // Regression: `lsof -iUDP` returns established flows too. Reading the trailing
  // number off `...:51605->160.79.104.10:443` once made an outbound QUIC
  // connection look like a local server on 443 — and --kill would signal it.
  const { run } = fakeRunner([
    [lsofTcp, ''],
    [
      lsofUdp,
      ['p722', 'cGoogle Chrome Helper', 'n192.168.11.122:51605->160.79.104.10:443', 'n*:5353', ''].join('\n'),
    ],
  ]);
  const byPort = await scanListeners({ run, platform: 'darwin' });

  assert.equal(byPort.has(443), false, 'a remote port must never register as held');
  assert.deepEqual([...byPort.keys()], [5353], 'the genuinely bound UDP port still shows');
});

test('isConnected distinguishes flows from listeners', () => {
  assert.equal(isConnected('192.168.1.5:51605->160.79.104.10:443'), true);
  assert.equal(isConnected('*:3000'), false);
  assert.equal(isConnected('127.0.0.1:5432'), false);
  assert.equal(isConnected(undefined), false);
});

test('scanListeners falls back to ss when lsof is missing', async () => {
  const { run, calls } = fakeRunner([
    [(cmd) => cmd === 'lsof', enoent()],
    [(cmd, args) => cmd === 'ss' && args.includes('-ltnpH'), 'LISTEN 0 511 *:3000 *:* users:(("node",pid=48192,fd=20))'],
    [(cmd, args) => cmd === 'ss' && args.includes('-lunpH'), ''],
  ]);
  const byPort = await scanListeners({ run, platform: 'linux' });

  assert.ok(calls.some((k) => k.cmd === 'ss'), 'ss should be attempted');
  assert.deepEqual(byPort.get(3000).map((h) => h.pid), [48192]);
});

test('scanListeners explains itself when neither lsof nor ss exists', async () => {
  const { run } = fakeRunner([[() => true, enoent()]]);
  await assert.rejects(() => scanListeners({ run, platform: 'linux' }), /Need `lsof` or `ss`/);
});

/* ----------------------------- windows paths ----------------------------- */

test('scanListeners parses netstat output and keeps only LISTENING rows', async () => {
  const netstat = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       48192',
    '  TCP    127.0.0.1:52000        93.184.216.34:443      ESTABLISHED     7777',
    '  TCPv6  [::]:5432              [::]:0                 LISTENING       99',
    '  UDP    0.0.0.0:5353           *:*                                    1234',
  ].join('\n');
  const { run, calls } = fakeRunner([[(cmd) => cmd === 'netstat', netstat]]);
  const byPort = await scanListeners({ run, platform: 'win32' });

  assert.equal(calls.length, 1, 'one netstat call for the whole machine');
  assert.deepEqual([...byPort.keys()], [3000, 5353, 5432]);
  assert.equal(byPort.has(443), false, 'an ESTABLISHED row is not a listener');
  assert.deepEqual([...byPort.get(5432)[0].protocols], ['tcp'], 'tcpv6 normalises to tcp');
  assert.deepEqual([...byPort.get(5353)[0].protocols], ['udp']);
});

test('parseWmiDate reads both PowerShell date encodings', () => {
  assert.equal(parseWmiDate('/Date(1700000000000)/'), 1700000000000);
  assert.equal(parseWmiDate('2026-09-20T21:00:00.000Z'), Date.parse('2026-09-20T21:00:00.000Z'));
  assert.equal(parseWmiDate('not a date'), null);
  assert.equal(parseWmiDate(null), null);
});

test('basename handles both separators', () => {
  assert.equal(basename('C:\\Program Files\\nodejs\\node.exe'), 'node.exe');
  assert.equal(basename('/usr/local/bin/node'), 'node');
  assert.equal(basename('node'), 'node');
  assert.equal(basename(null), null);
});

/* --------------------------- assorted edge cases ------------------------- */

test('truncate copes with budgets too small for an ellipsis', () => {
  assert.equal(truncate('abcdef', 3), 'abc');
  assert.equal(truncate('abcdef', 0), '');
  assert.equal(truncate(null, 5), '');
});

test('formatAge does not emit negative durations', () => {
  assert.equal(formatAge(-5), '0s');
  assert.equal(formatAge(Number.NaN), 'unknown');
});

/* ----------------------------- self-protection --------------------------- */

// pid 100 (the CLI) <- 90 (node) <- 80 (the shell) <- 1
const WIN_TREE = JSON.stringify([
  { ProcessId: 100, ParentProcessId: 90 },
  { ProcessId: 90, ParentProcessId: 80 },
  { ProcessId: 80, ParentProcessId: 1 },
]);
const UNIX_TREE = ['  100    90', '   90    80', '   80     1', '    1     0'].join('\n');

test('selfAncestry walks the whole chain on unix', async () => {
  const { run } = fakeRunner([[(cmd) => cmd === 'ps', UNIX_TREE]]);
  const chain = await selfAncestry({ run, platform: 'linux', pid: 100, ppid: 90 });
  assert.deepEqual([...chain].sort((a, b) => a - b), [1, 80, 90, 100]);
});

test('selfAncestry walks the whole chain on windows too', async () => {
  // Regression: Windows used to return only {pid, ppid}, leaving the grandparent
  // shell (80) killable — and taskkill is the more destructive backend.
  const { run, calls } = fakeRunner([[(cmd) => cmd === 'powershell', WIN_TREE]]);
  const chain = await selfAncestry({ run, platform: 'win32', pid: 100, ppid: 90 });

  assert.equal(calls[0].cmd, 'powershell', 'windows asks PowerShell for the tree');
  assert.ok(chain.has(80), 'the grandparent shell must be protected');
  assert.deepEqual([...chain].sort((a, b) => a - b), [1, 80, 90, 100]);
});

test('selfAncestry still protects the immediate pair when the tree lookup fails', async () => {
  const { run } = fakeRunner([[() => true, new Error('boom')]]);
  const chain = await selfAncestry({ run, platform: 'win32', pid: 100, ppid: 90 });
  assert.deepEqual([...chain].sort((a, b) => a - b), [90, 100], 'degrades, never empties');
});

test('selfAncestry tolerates a single-object PowerShell response', async () => {
  // ConvertTo-Json emits a bare object, not an array, for one row.
  const { run } = fakeRunner([[(cmd) => cmd === 'powershell', JSON.stringify({ ProcessId: 100, ParentProcessId: 90 })]]);
  const chain = await selfAncestry({ run, platform: 'win32', pid: 100, ppid: 90 });
  assert.ok(chain.has(90));
});

/* --------------------------- post-kill port state ------------------------- */

test('portFreedom reports free only when the port really is', () => {
  // The holder was killed and nothing replaced it.
  assert.deepEqual(portFreedom([{ pid: 100, killed: true }], new Set([100])), {
    free: true,
    strangers: [],
  });

  // A kill failed.
  assert.deepEqual(portFreedom([{ pid: 100, killed: false }], new Set([100])), {
    free: false,
    strangers: [],
  });

  // Skipped (killed undefined) and the port is genuinely empty now.
  assert.deepEqual(portFreedom([{ pid: 100 }], new Set()), { free: true, strangers: [] });
});

test('portFreedom catches a respawn taking over a skipped holder', () => {
  // Regression: a skipped pid used to be recorded as killed, so this reported
  // free with exit 0 while pid 200 still held the port.
  assert.deepEqual(portFreedom([{ pid: 100 }], new Set([200])), {
    free: false,
    strangers: [200],
  });
});

test('portFreedom falls back to kill results when the port cannot be re-read', () => {
  assert.deepEqual(portFreedom([{ pid: 100, killed: true }], null), { free: true, strangers: [] });
  assert.deepEqual(portFreedom([{ pid: 100, killed: false }], null), { free: false, strangers: [] });
});

test('selfAncestry drops a stale Windows parent pointer instead of protecting a stranger', () => {
  // Windows keeps ParentProcessId after the parent dies and reuses pids, so 80
  // here is an unrelated process that merely inherited the number. Climbing into
  // it would mark a stranger protected — and --force cannot override protection,
  // so the user would have no way to free the port.
  const stale = JSON.stringify([
    { ProcessId: 100, ParentProcessId: 90, CreationDate: '/Date(300)/' },
    { ProcessId: 90, ParentProcessId: 80, CreationDate: '/Date(200)/' },
    { ProcessId: 80, ParentProcessId: 1, CreationDate: '/Date(400)/' }, // younger than its "child"
  ]);
  const { run } = fakeRunner([[(cmd) => cmd === 'powershell', stale]]);
  return selfAncestry({ run, platform: 'win32', pid: 100, ppid: 90 }).then((chain) => {
    assert.equal(chain.has(80), false, 'a younger "parent" is a recycled pid, not an ancestor');
    assert.deepEqual([...chain].sort((a, b) => a - b), [90, 100]);
  });
});

test('selfAncestry keeps the chain when Windows omits creation dates', async () => {
  // No timestamps means no evidence of staleness, so edges must survive.
  const { run } = fakeRunner([[(cmd) => cmd === 'powershell', WIN_TREE]]);
  const chain = await selfAncestry({ run, platform: 'win32', pid: 100, ppid: 90 });
  assert.ok(chain.has(80), 'absent dates must not cause under-protection');
});
