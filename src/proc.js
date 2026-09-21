import { run } from './exec.js';

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
  const meta = await run('ps', ['-o', 'pid=,ppid=,user=,etime=,comm=', '-p', list]);
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

  const cmds = await run('ps', ['-o', 'pid=,command=', '-p', list]);
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
  const raw = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
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
function parseWmiDate(value) {
  if (!value) return null;
  const epoch = /\/Date\((\d+)\)\//.exec(String(value));
  if (epoch) return Number(epoch[1]);
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function basename(p) {
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

/** Walk up the ppid chain from the current process so we never kill our own shell. */
export async function selfAncestry() {
  const chain = new Set([process.pid, process.ppid]);
  if (isWin) return chain;
  try {
    const out = await run('ps', ['-eo', 'pid=,ppid=']);
    const parents = new Map();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) parents.set(Number(m[1]), Number(m[2]));
    }
    let cur = process.pid;
    for (let i = 0; i < 64 && cur && cur > 1; i += 1) {
      cur = parents.get(cur);
      if (!cur) break;
      chain.add(cur);
    }
  } catch {
    // Best effort only.
  }
  chain.delete(0);
  return chain;
}
