import { run as defaultRun } from './exec.js';

/** @typedef {{ pid: number, protocols: Set<string>, addresses: Set<string> }} Holder */
/** @typedef {{ port: number, pid: number, protocol: string, address: string }} Row */

function emptyHolder(pid) {
  return { pid, protocols: new Set(), addresses: new Set() };
}

function addHolder(map, pid, protocol, address) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!map.has(pid)) map.set(pid, emptyHolder(pid));
  const h = map.get(pid);
  if (protocol) h.protocols.add(protocol);
  if (address) h.addresses.add(address);
}

/**
 * Every listening socket, bucketed by port.
 *
 * One pass over the machine's sockets regardless of how many ports are asked
 * about: a whole-machine `lsof` costs the same as a single-port one, so asking
 * about 500 ports is the same two subprocess calls as asking about one.
 *
 * @param {{ ports?: number[] | null, run?: typeof defaultRun, platform?: string }} [options]
 *   `ports` filters the result in-process; omit it for everything.
 *   `run` and `platform` are injectable so tests can drive either platform's
 *   parsing with canned output.
 * @returns {Promise<Map<number, Holder[]>>} sorted by port, holders sorted by pid
 */
export async function scanListeners({ ports = null, run = defaultRun, platform = process.platform } = {}) {
  const wanted = ports ? new Set(ports) : null;
  const rows = platform === 'win32' ? await listWindows(run) : await listUnix(run);

  const byPort = new Map();
  for (const { port, pid, protocol, address } of rows) {
    if (wanted && !wanted.has(port)) continue;
    if (!byPort.has(port)) byPort.set(port, new Map());
    addHolder(byPort.get(port), pid, protocol, address);
  }

  return new Map(
    [...byPort.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([port, holders]) => [port, [...holders.values()].sort((a, b) => a.pid - b.pid)])
  );
}

/**
 * Who is listening on `port`?
 * @returns {Promise<Holder[]>}
 */
export async function findHolders(port) {
  return (await scanListeners({ ports: [port] })).get(port) ?? [];
}

/**
 * Every listening socket on the machine, grouped by port.
 * @returns {Promise<Map<number, Holder[]>>}
 */
export function findAllListeners() {
  return scanListeners();
}

/* ------------------------------- unix ---------------------------------- */

/** @returns {Promise<Row[]>} */
async function listUnix(run) {
  try {
    return await listLsof(run);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    return await listSs(run);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  throw new Error(
    'Need `lsof` or `ss` to inspect ports. Install one (e.g. `apt install lsof` / `brew install lsof`).'
  );
}

async function listLsof(run) {
  const specs = [
    { protocol: 'tcp', args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpcnP'] },
    { protocol: 'udp', args: ['-nP', '-iUDP', '-FpcnP'] },
  ];
  const rows = [];
  for (const { protocol, args } of specs) {
    const out = await run('lsof', args);
    for (const { pid, name } of parseLsofFields(out)) {
      if (isConnected(name)) continue;
      const port = portOf(name);
      if (port == null) continue;
      rows.push({ port, pid, protocol, address: name });
    }
  }
  return rows;
}

async function listSs(run) {
  const rows = [];
  for (const [flag, protocol] of [['-ltnpH', 'tcp'], ['-lunpH', 'udp']]) {
    const out = await run('ss', [flag]);
    for (const line of out.split('\n')) {
      const local = line.trim().split(/\s+/)[3];
      if (isConnected(local)) continue;
      const port = portOf(local);
      if (port == null) continue;
      for (const pid of parseSsPids(line)) rows.push({ port, pid, protocol, address: local });
    }
  }
  return rows;
}

/** Parse `lsof -F` machine output into {pid, name} pairs (one per open socket). */
export function parseLsofFields(out) {
  const results = [];
  let pid = null;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') pid = Number(value);
    else if (tag === 'n' && pid != null) results.push({ pid, name: value });
  }
  return results;
}

/** `users:(("node",pid=48192,fd=20))` -> [48192] */
export function parseSsPids(line) {
  return [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
}

/* ------------------------------ windows -------------------------------- */

/** @returns {Promise<Row[]>} */
async function listWindows(run) {
  const out = await run('netstat', ['-ano']);
  const rows = [];
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const protocol = parts[0].toLowerCase();
    if (protocol !== 'tcp' && protocol !== 'udp' && protocol !== 'tcpv6' && protocol !== 'udpv6') continue;
    const local = parts[1];
    const pid = Number(parts[parts.length - 1]);
    const state = protocol.startsWith('tcp') ? parts[3] : null;
    if (state && state.toUpperCase() !== 'LISTENING') continue;
    const port = portOf(local);
    if (port == null || !Number.isInteger(pid)) continue;
    rows.push({ port, pid, protocol: protocol.replace('v6', ''), address: local });
  }
  return rows;
}

/* ------------------------------- shared -------------------------------- */

/**
 * Is this a connected socket rather than a listener?
 *
 * UDP has no LISTEN state, so `lsof -iUDP` also returns established flows like
 * `192.168.1.5:51605->160.79.104.10:443`. Those must never count as holding a
 * port: `portOf` reads the trailing number, which for a connected socket is the
 * *remote* port. Without this guard an outbound QUIC connection makes the local
 * machine look like it is serving 443 — and `--kill` would then signal an
 * innocent process that merely had a tab open.
 */
export function isConnected(address) {
  return typeof address === 'string' && address.includes('->');
}

/** Pull the port out of `*:3000`, `127.0.0.1:3000`, `[::1]:3000`, `0.0.0.0:3000`. */
export function portOf(address) {
  if (!address) return null;
  const m = /:(\d+)$/.exec(address.trim());
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) ? port : null;
}
