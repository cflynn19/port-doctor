import { createRequire } from 'node:module';

import { scanListeners, findAllListeners } from './scan.js';
import { describe, selfAncestry, isAlive } from './proc.js';
import { killProcess } from './kill.js';
import { c, setColor, shouldUseColor, formatAge, truncate, detailBlock, confirm } from './ui.js';

// Read from package.json rather than restating it, so `--version` cannot drift.
// `createRequire` instead of a JSON import attribute: attributes are unavailable
// on Node 18, which is the floor declared in `engines`.
const { version: VERSION } = createRequire(import.meta.url)('../package.json');
const isWin = process.platform === 'win32';
const SYM = isWin ? { ok: '+', bad: 'x', info: '-' } : { ok: '✔', bad: '✖', info: '•' };

const help = () => `
${c.bold('port-doctor')} — find out what is squatting on a port, and kill it.

${c.bold('Usage')}
  port-doctor <port...>          diagnose one or more ports
  port-doctor                    list every listening port

${c.bold('Options')}
  -k, --kill           kill the offender without asking
  -f, --force          escalate straight to SIGKILL (implies a hard stop)
  -j, --json           machine-readable output
  -t, --timeout <ms>   how long to wait after SIGTERM (default 3000)
      --no-color       disable ANSI colour
  -h, --help           show this help
  -v, --version        print the version

${c.bold('Ports')}
  3000                 a single port
  3000-3010            an inclusive range
  :3000                leading colon is fine
  http://localhost:5173  so is a whole URL

${c.bold('Exit codes')}
  0  every requested port ended up free
  1  a port is still occupied (declined, or the kill failed)
  2  bad usage or an internal error

${c.bold('Examples')}
  port-doctor 3000
  port-doctor 3000 5173 --kill
  port-doctor 8080 --kill --force
  port-doctor --json | jq '.ports[].processes[].pid'
`.trimStart();

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    setColor(shouldUseColor({ noColor: false }));
    process.stderr.write(`${c.red(`${SYM.bad} ${err.message}`)}\n\nRun ${c.bold('port-doctor --help')} for usage.\n`);
    return 2;
  }

  setColor(shouldUseColor(opts));

  if (opts.help) {
    process.stdout.write(help());
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    if (opts.ports.length === 0) return await listAll(opts);
    return await diagnose(opts);
  } catch (err) {
    process.stderr.write(`${c.red(`${SYM.bad} ${err.message}`)}\n`);
    return 2;
  }
}

/* ------------------------------ commands -------------------------------- */

async function diagnose(opts) {
  const protectedPids = await selfAncestry();
  const report = [];

  // Scan and describe up front: two `lsof` calls and two `ps` calls total,
  // whether that is one port or a thousand-port range.
  const byPort = await scanListeners({ ports: opts.ports });
  const details = await describe([...byPort.values()].flat().map((h) => h.pid));

  for (const port of opts.ports) {
    const holders = byPort.get(port) ?? [];
    const processes = holders.map((h) => ({
      ...details.get(h.pid),
      pid: h.pid,
      protocols: [...h.protocols],
      addresses: [...h.addresses],
      age: formatAge(details.get(h.pid)?.ageSeconds),
      killed: undefined,
      error: undefined,
    }));

    if (processes.length === 0) {
      if (!opts.json) process.stdout.write(`${c.green(`${SYM.ok} Port ${c.bold(port)} is free`)}\n`);
      report.push({ port, free: true, processes: [] });
      continue;
    }

    if (!opts.json) printOccupied(port, processes);

    const decision = opts.kill ? 'yes' : await askToKill(port, processes, opts, protectedPids);
    if (decision === 'yes') {
      await killAll(port, processes, opts, protectedPids);
      const stillHeld = processes.some((p) => p.killed === false);
      report.push({ port, free: !stillHeld, processes });
    } else {
      if (decision === 'no') printSkipHint(port, opts);
      report.push({ port, free: false, processes });
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ports: report }, null, 2)}\n`);
  }
  return report.every((r) => r.free) ? 0 : 1;
}

async function listAll(opts) {
  const byPort = await findAllListeners();
  const allPids = [...byPort.values()].flat().map((h) => h.pid);
  const details = await describe(allPids);

  const rows = [...byPort.entries()].map(([port, holders]) => ({
    port,
    processes: holders.map((h) => ({
      ...details.get(h.pid),
      pid: h.pid,
      protocols: [...h.protocols],
      addresses: [...h.addresses],
      age: formatAge(details.get(h.pid)?.ageSeconds),
    })),
  }));

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ports: rows.map((r) => ({ ...r, free: false })) }, null, 2)}\n`);
    return 0;
  }

  if (rows.length === 0) {
    process.stdout.write(`${c.dim('Nothing is listening.')}\n`);
    return 0;
  }

  const width = process.stdout.columns || 100;
  const portW = Math.max(4, ...rows.map((r) => String(r.port).length));
  const nameW = Math.min(20, Math.max(7, ...rows.flatMap((r) => r.processes.map((p) => (p.name || '?').length))));
  const pidW = Math.max(5, ...rows.flatMap((r) => r.processes.map((p) => String(p.pid).length)));

  process.stdout.write(
    `${c.dim(`${'PORT'.padEnd(portW)}  ${'PID'.padEnd(pidW)}  ${'PROCESS'.padEnd(nameW)}  AGE     COMMAND`)}\n`
  );
  for (const row of rows) {
    for (const p of row.processes) {
      const head = `${c.bold(String(row.port).padEnd(portW))}  ${String(p.pid).padEnd(pidW)}  ${truncate(p.name || '?', nameW).padEnd(nameW)}  ${p.age.padEnd(6)}`;
      const budget = Math.max(10, width - (portW + pidW + nameW + 12));
      process.stdout.write(`${head}  ${c.dim(truncate(p.command || '', budget))}\n`);
    }
  }
  process.stdout.write(
    `\n${c.dim(`${rows.length} port${rows.length === 1 ? '' : 's'} in use. Inspect one with `)}${c.bold(`port-doctor ${rows[0].port}`)}\n`
  );
  return 0;
}

/* ------------------------------ rendering ------------------------------- */

function printOccupied(port, processes) {
  const width = process.stdout.columns || 100;
  process.stdout.write(`${c.yellow(`${SYM.bad} Port ${c.bold(port)} is occupied`)}\n\n`);
  processes.forEach((p, i) => {
    if (i > 0) process.stdout.write('\n');
    const where = p.addresses.length
      ? `${p.addresses.join(', ')} ${c.dim(`(${p.protocols.join('/') || 'tcp'})`)}`
      : null;
    process.stdout.write(
      `${detailBlock([
        ['PID', c.bold(p.pid)],
        ['Process', p.name || 'unknown'],
        ['Command', truncate(p.command || 'unknown', Math.max(20, width - 14))],
        ['User', p.user],
        ['Age', p.age],
        ['Listening', where],
      ])}\n`
    );
  });
  process.stdout.write('\n');
}

function printSkipHint(port, opts) {
  const flag = opts.force ? ' --kill --force' : ' --kill';
  process.stdout.write(`${c.dim(`Left running. Kill it later with `)}${c.bold(`port-doctor ${port}${flag}`)}\n`);
}

/* ------------------------------- killing -------------------------------- */

/** @returns {Promise<'yes'|'no'|'skip'>} */
async function askToKill(port, processes, opts, protectedPids) {
  // In JSON mode there is nobody to ask and no safe place to print the question.
  if (opts.json) return 'skip';

  const blocked = processes.filter((p) => protectedPids.has(p.pid) || p.pid === 1);
  if (blocked.length === processes.length) {
    process.stdout.write(
      `${c.red(`${SYM.info} Refusing to kill PID ${blocked.map((p) => p.pid).join(', ')} — that is this shell or a system process.`)}\n`
    );
    return 'skip';
  }
  const foreign = processes.filter((p) => p.user && p.user !== currentUser());
  if (foreign.length) {
    process.stdout.write(
      `${c.yellow(`${SYM.info} Owned by ${[...new Set(foreign.map((p) => p.user))].join(', ')} — killing it may need sudo.`)}\n`
    );
  }

  const answer = await confirm(`  Kill it?`);
  if (answer === null) {
    process.stdout.write(
      `${c.dim('Not a TTY, so nothing was killed. Re-run with ')}${c.bold(`port-doctor ${port} --kill`)}${c.dim(' to act.')}\n`
    );
    return 'skip';
  }
  return answer ? 'yes' : 'no';
}

async function killAll(port, processes, opts, protectedPids) {
  // The scan happened a moment ago. Re-read the port so a holder that has since
  // exited cannot get its pid recycled onto an unrelated process that we then
  // signal. Cheap now that a scan is a single pass.
  const stillHolding = new Set((await scanListeners({ ports: [port] })).get(port)?.map((h) => h.pid) ?? []);

  for (const p of processes) {
    if (protectedPids.has(p.pid) || p.pid === 1) {
      p.killed = false;
      p.error = 'refused: this is the current shell or a system process';
      if (!opts.json) process.stdout.write(`${c.red(`${SYM.bad} ${p.pid} — ${p.error}`)}\n`);
      continue;
    }
    if (!isAlive(p.pid)) {
      p.killed = true;
      continue;
    }
    if (!stillHolding.has(p.pid)) {
      // Alive, but no longer on this port — so this pid is not our business.
      p.killed = true;
      p.error = `skipped: pid ${p.pid} no longer holds port ${port}`;
      if (!opts.json) process.stdout.write(`${c.dim(`${SYM.info} ${p.error}`)}\n`);
      continue;
    }
    const result = await killProcess(p.pid, { force: opts.force, timeoutMs: opts.timeout });
    p.killed = result.killed;
    p.error = result.error;
    if (opts.json) continue;
    if (result.killed) {
      process.stdout.write(
        `${c.green(`${SYM.ok} Killed ${c.bold(p.pid)} (${p.name || 'process'}) with ${result.signal}`)}\n`
      );
    } else {
      process.stdout.write(`${c.red(`${SYM.bad} Could not kill ${p.pid}: ${result.error}`)}\n`);
    }
  }
}

function currentUser() {
  return process.env.USER || process.env.USERNAME || null;
}

/* ------------------------------ arg parsing ----------------------------- */

export function parseArgs(argv) {
  const opts = {
    ports: [],
    kill: false,
    force: false,
    json: false,
    help: false,
    version: false,
    noColor: false,
    timeout: 3000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      argv.slice(i + 1).forEach((rest) => opts.ports.push(...parsePortArg(rest)));
      break;
    }
    switch (arg) {
      case '-k':
      case '--kill':
      case '-y':
      case '--yes':
        opts.kill = true;
        break;
      case '-f':
      case '--force':
        opts.force = true;
        break;
      case '-j':
      case '--json':
        opts.json = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      case '--no-color':
      case '--no-colour':
        opts.noColor = true;
        break;
      case '-a':
      case '--all':
        break; // listing everything is what no-port already does
      case '-t':
      case '--timeout': {
        const value = Number(argv[i + 1]);
        if (!Number.isFinite(value) || value < 0) throw new Error(`--timeout needs a number of milliseconds`);
        opts.timeout = value;
        i += 1;
        break;
      }
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        opts.ports.push(...parsePortArg(arg));
    }
  }

  opts.ports = [...new Set(opts.ports)];
  return opts;
}

/** Accepts `3000`, `:3000`, `3000-3010`, `localhost:3000`, `http://host:3000/path`. */
export function parsePortArg(token) {
  const raw = String(token).trim();
  const range = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(raw);
  if (range) {
    const [from, to] = [Number(range[1]), Number(range[2])];
    if (from > to) throw new Error(`Empty port range: ${raw}`);
    if (to - from > 1000) throw new Error(`Port range too wide: ${raw} (max 1000 ports)`);
    return Array.from({ length: to - from + 1 }, (_, i) => validPort(from + i, raw));
  }

  const cleaned = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
  const m = /(?::|^)(\d{1,5})$/.exec(cleaned);
  if (!m) throw new Error(`Not a port: ${raw}`);
  return [validPort(Number(m[1]), raw)];
}

function validPort(port, raw) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Port out of range (1-65535): ${raw}`);
  }
  return port;
}
