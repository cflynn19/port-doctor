import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { findHolders } from '../src/scan.js';
import { describe as describeProcs, isAlive } from '../src/proc.js';

const execFileAsync = promisify(execFile);
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'port-doctor.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run the CLI, tolerating the non-zero exit codes it uses as signal. */
async function cli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

/** A listening server in *this* process, so we know exactly which pid should show up. */
async function listenHere() {
  const server = http.createServer((_, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/** A listening server in a *child* process, so the CLI has something safe to kill. */
async function listenElsewhere() {
  const child = spawn(
    process.execPath,
    ['-e', "const s=require('http').createServer((_,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => resolve(Number(String(d).trim())));
    child.once('error', reject);
  });
  return { child, port };
}

test('findHolders finds the process holding a port, and nobody on a free one', async () => {
  const { server, port } = await listenHere();
  try {
    const holders = await findHolders(port);
    assert.ok(
      holders.some((h) => h.pid === process.pid),
      `expected pid ${process.pid} among ${JSON.stringify(holders.map((h) => h.pid))}`
    );
    const info = (await describeProcs([process.pid])).get(process.pid);
    assert.equal(info.name, 'node');
    assert.ok(info.ageSeconds >= 0);
    assert.ok(info.command.length > 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
  // Once the listener is gone the port reads as free.
  assert.deepEqual(await findHolders(port), []);
});

test('the CLI reports a free port with exit code 0', async () => {
  const { server, port } = await listenHere();
  await new Promise((r) => server.close(r));
  const { code, stdout } = await cli([String(port)]);
  assert.equal(code, 0);
  assert.match(stdout, /is free/);
});

test('the CLI reports an occupied port with exit code 1 and leaves it running', async () => {
  const { child, port } = await listenElsewhere();
  try {
    const { code, stdout } = await cli([String(port)]);
    assert.equal(code, 1);
    assert.match(stdout, /is occupied/);
    assert.match(stdout, new RegExp(String(child.pid)));
    assert.ok(isAlive(child.pid), 'process should survive a plain diagnosis');
  } finally {
    child.kill('SIGKILL');
  }
});

test('--json emits parseable JSON and nothing else', async () => {
  const { child, port } = await listenElsewhere();
  try {
    const { stdout } = await cli([String(port), '--json']);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ports.length, 1);
    assert.equal(parsed.ports[0].port, port);
    assert.equal(parsed.ports[0].free, false);
    assert.deepEqual(
      parsed.ports[0].processes.map((p) => p.pid),
      [child.pid]
    );
  } finally {
    child.kill('SIGKILL');
  }
});

test('--kill frees the port and exits 0', async () => {
  const { child, port } = await listenElsewhere();
  const { code, stdout } = await cli([String(port), '--kill']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /Killed/);
  await sleep(100);
  assert.equal(isAlive(child.pid), false);
  assert.deepEqual(await findHolders(port), []);
});

test('--kill --force works on a process that ignores SIGTERM', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM',()=>{});const s=require('http').createServer((_,r)=>r.end());s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const port = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));

  // Without --force we give up after the timeout and say so.
  const polite = await cli([String(port), '--kill', '--timeout', '400']);
  assert.equal(polite.code, 1);
  assert.match(polite.stdout, /Could not kill/);
  assert.ok(isAlive(child.pid));

  const forced = await cli([String(port), '--kill', '--force']);
  assert.equal(forced.code, 0, forced.stdout);
  await sleep(100);
  assert.equal(isAlive(child.pid), false);
});

test('the CLI refuses to kill its own process tree', async () => {
  const { server, port } = await listenHere();
  try {
    // The test process listens on the port; the CLI it spawns is its child, so
    // the test process is an ancestor and must be protected.
    const { code, stdout } = await cli([String(port), '--kill']);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /refused/i);
    assert.ok(isAlive(process.pid));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('bad usage exits 2', async () => {
  const { code, stderr } = await cli(['banana']);
  assert.equal(code, 2);
  assert.match(stderr, /Not a port/);
});
