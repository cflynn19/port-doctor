import { run } from './exec.js';

const isWin = process.platform === 'win32';

/** @typedef {{ pid: number, protocols: Set<string>, addresses: Set<string> }} Holder */

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
 * Who is listening on `port`?
 * @returns {Promise<Holder[]>}
 */
export async function findHolders(port) {
  const map = new Map();
  if (isWin) await scanWindows(port, map);
  else await scanUnix(port, map);
  return [...map.values()].sort((a, b) => a.pid - b.pid);
}

/**
 * Every listening socket on the machine, grouped by port.
 * @returns {Promise<Map<number, Holder[]>>}
 */
export async function findAllListeners() {
  const byPort = new Map();
  const rows = isWin ? await listWindows() : await listUnix();
  for (const { port, pid, protocol, address } of rows) {
    if (!byPort.has(port)) byPort.set(port, new Map());
    addHolder(byPort.get(port), pid, protocol, address);
  }
  return new Map(
    [...byPort.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([port, holders]) => [port, [...holders.values()].sort((a, b) => a.pid - b.pid)])
  );
}

/* ------------------------------- unix ---------------------------------- */

async function scanUnix(port, map) {
  try {
    await scanLsof(port, map);
    return;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    await scanSs(port, map);
    return;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  throw new Error(
    'Need `lsof` or `ss` to inspect ports. Install one (e.g. `apt install lsof` / `brew install lsof`).'
  );
}

async function scanLsof(port, map) {
  const specs = [
    { protocol: 'tcp', args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-FpcnP'] },
    { protocol: 'udp', args: ['-nP', `-iUDP:${port}`, '-FpcnP'] },
  ];
  for (const { protocol, args } of specs) {
    const out = await run('lsof', args);
    for (const { pid, name } of parseLsofFields(out)) {
      // lsof matches ":3000" loosely against some address forms; keep exact hits only.
      if (portOf(name) !== port) continue;
      addHolder(map, pid, protocol, name);
    }
  }
}

async function scanSs(port, map) {
  for (const [flag, protocol] of [['-ltnpH', 'tcp'], ['-lunpH', 'udp']]) {
    const out = await run('ss', [flag, `sport = :${port}`]);
    for (const line of out.split('\n')) {
      const local = line.trim().split(/\s+/)[3];
      for (const pid of parseSsPids(line)) addHolder(map, pid, protocol, local);
    }
  }
}

async function listUnix() {
  const rows = [];
  let out;
  try {
    out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpcnP']);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const ss = await run('ss', ['-ltnpH']);
    for (const line of ss.split('\n')) {
      const local = line.trim().split(/\s+/)[3];
      const port = portOf(local);
      if (port == null) continue;
      for (const pid of parseSsPids(line)) rows.push({ port, pid, protocol: 'tcp', address: local });
    }
    return rows;
  }
  for (const { pid, name } of parseLsofFields(out)) {
    const port = portOf(name);
    if (port == null) continue;
    rows.push({ port, pid, protocol: 'tcp', address: name });
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

async function scanWindows(port, map) {
  for (const row of await listWindows()) {
    if (row.port === port) addHolder(map, row.pid, row.protocol, row.address);
  }
}

async function listWindows() {
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

/** Pull the port out of `*:3000`, `127.0.0.1:3000`, `[::1]:3000`, `0.0.0.0:3000`. */
export function portOf(address) {
  if (!address) return null;
  const m = /:(\d+)$/.exec(address.trim());
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) ? port : null;
}
