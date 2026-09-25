import { run as defaultRun } from './exec.js';

const isWin = process.platform === 'win32';

/**
 * @typedef {object} ProcInfo
 * @property {number} pid
 * @property {number|null} ppid
 * @property {string|null} user
 * @property {string|null} name     short process name, e.g. "node"
 * @property {string|null} command  full command line, e.g. "next dev"
 * @property {number|null} ageSeconds
 */

/**
 * Look up details for a set of pids in as few subprocess calls as possible.
 * @param {number[]} pids
 * @returns {Promise<Map<number, ProcInfo>>}
 */
export async function describe(pids) {
  const unique = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  const out = new Map(unique.map((pid) => [pid, blank(pid)]));
  if (unique.length === 0) return out;
  try {
    if (isWin) await describeWindows(unique, out);
    else await describeUnix(unique, out);
  } catch {
    // Details are a nicety; a pid with no details still beats no answer at all.
  }
  return out;
}

function blank(pid) {
  return { pid, ppid: null, user: null, name: null, command: null, ageSeconds: null };
}

async function describeUnix(pids, out) {
  const list = pids.join(',');

  // Two calls: fixed-width-ish fields first, then the free-form command line.
  const meta = await defaultRun('ps', ['-o', 'pid=,ppid=,user=,etime=,comm=', '-p', list]);
  for (const line of meta.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const info = out.get(Number(m[1]));
    if (!info) continue;
    info.ppid = Number(m[2]);
    info.user = m[3];
    info.ageSeconds = parseEtime(m[4]);
    info.name = basename(m[5].trim());
  }

  const cmds = await defaultRun('ps', ['-o', 'pid=,command=', '-p', list]);
  for (const line of cmds.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const info = out.get(Number(m[1]));
    if (!info) continue;
    info.command = m[2].trim();
    if (!info.name) info.name = basename(info.command.split(/\s+/)[0]);
  }
}

async function describeWindows(pids, out) {
  const script = [
    `Get-CimInstance Win32_Process -Filter "${pids.map((p) => `ProcessId=${p}`).join(' or ')}"`,
    '| Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate',
    '| ConvertTo-Json -Compress -Depth 2',
  ].join(' ');
  const raw = await defaultRun('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const text = raw.trim();
  if (!text) return;
  const parsed = JSON.parse(text);
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    const info = out.get(Number(row.ProcessId));
    if (!info) continue;
    info.ppid = Number(row.ParentProcessId) || null;
    info.name = row.Name || null;
    info.command = row.CommandLine || row.Name || null;
    const started = parseWmiDate(row.CreationDate);
    if (started) info.ageSeconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  }
}

/** `[[DD-]HH:]MM:SS` as printed by `ps -o etime` -> seconds. */
export function parseEtime(etime) {
  if (!etime) return null;
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const [, d = 0, h = 0, min, s] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
}

/** PowerShell serialises CIM dates as `/Date(1700000000000)/` or ISO-8601. */
export function parseWmiDate(value) {
  if (!value) return null;
  const epoch = /\/Date\((\d+)\)\//.exec(String(value));
  if (epoch) return Number(epoch[1]);
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function basename(p) {
  if (!p) return null;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Does this pid still exist? EPERM means "yes, but not yours". */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Walk up the ppid chain from the current process so we never kill our own shell.
 *
 * Every platform walks the whole chain. Windows used to stop at `ppid`, which
 * left a grandparent shell killable — and `taskkill` is the more destructive of
 * the two backends, so that was the wrong place to cut the corner.
 *
 * @param {{ run?: typeof defaultRun, platform?: string, pid?: number, ppid?: number }} [options]
 *   Injectable so tests can walk a synthetic tree on any host.
 * @returns {Promise<Set<number>>}
 */
export async function selfAncestry({
  run = defaultRun,
  platform = process.platform,
  pid = process.pid,
  ppid = process.ppid,
} = {}) {
  const chain = new Set([pid, ppid]);
  try {
    const parents = platform === 'win32' ? await parentMapWindows(run) : await parentMapUnix(run);
    let cur = pid;
    for (let i = 0; i < 64 && cur && cur > 1; i += 1) {
      cur = parents.get(cur);
      if (!cur) break;
      chain.add(cur);
    }
  } catch {
    // Best effort only.
  }
  chain.delete(0);
  chain.delete(undefined);
  return chain;
}

/** pid -> ppid for every process, from `ps`. */
async function parentMapUnix(run) {
  const out = await run('ps', ['-eo', 'pid=,ppid=']);
  const parents = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) parents.set(Number(m[1]), Number(m[2]));
  }
  return parents;
}

/**
 * pid -> ppid for every process, from PowerShell.
 *
 * Windows does not clear `ParentProcessId` when a parent exits, and it recycles
 * pids aggressively, so the raw pointer can name an unrelated live process. Left
 * unchecked the ancestry walk would climb into that stranger's branch and mark
 * it protected — which, since `--force` deliberately cannot override protection,
 * would leave a port with no way to free it. A parent is always older than its
 * child, so a younger "parent" is a stale pointer and the edge gets dropped.
 */
async function parentMapWindows(run) {
  const script = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,ParentProcessId,CreationDate',
    '| ConvertTo-Json -Compress -Depth 2',
  ].join(' ');
  const raw = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const text = String(raw ?? '').trim();
  if (!text) return new Map();

  const parsed = JSON.parse(text);
  const rows = new Map();
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    const child = Number(row.ProcessId);
    const parent = Number(row.ParentProcessId);
    if (Number.isInteger(child) && Number.isInteger(parent)) {
      rows.set(child, { ppid: parent, created: parseWmiDate(row.CreationDate) });
    }
  }

  const parents = new Map();
  for (const [pid, { ppid, created }] of rows) {
    const parent = rows.get(ppid);
    // Only reject on positive evidence: absent timestamps keep the edge.
    if (parent && created != null && parent.created != null && parent.created > created) continue;
    parents.set(pid, ppid);
  }
  return parents;
}
