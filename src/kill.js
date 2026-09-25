import { run } from './exec.js';
import { isAlive } from './proc.js';

const isWin = process.platform === 'win32';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop a process. Sends SIGTERM first and gives it a moment to shut down
 * cleanly. `force` does not escalate — it makes SIGKILL the *first* signal.
 * Without it, a process that outlives the timeout is reported, not escalated
 * on: the choice to SIGKILL stays with the caller.
 *
 * @param {number} pid
 * @param {{ force?: boolean, timeoutMs?: number }} opts
 * @returns {Promise<{ killed: boolean, signal: string, error?: string }>}
 */
export async function killProcess(pid, { force = false, timeoutMs = 3000 } = {}) {
  if (isWin) return killWindows(pid, force);

  const first = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(pid, first);
  } catch (err) {
    if (err.code === 'ESRCH') return { killed: true, signal: first };
    return { killed: false, signal: first, error: explain(err) };
  }

  if (await waitForExit(pid, timeoutMs)) {
    return { killed: true, signal: first };
  }
  if (!force) {
    return {
      killed: false,
      signal: first,
      error: `still running ${timeoutMs}ms after SIGTERM (retry with --force)`,
    };
  }
  return { killed: false, signal: first, error: 'survived SIGKILL' };
}

async function killWindows(pid, force) {
  // Deliberately no `/T`. That kills the whole process tree, which made Windows
  // silently more destructive than the Unix path's single-process signal. One
  // port, one process.
  const args = ['/PID', String(pid)];
  if (force) args.push('/F');
  try {
    await run('taskkill', args);
  } catch (err) {
    return { killed: false, signal: force ? 'TERM/F' : 'TERM', error: explain(err) };
  }
  const killed = await waitForExit(pid, 3000);
  return {
    killed,
    signal: force ? 'TERM/F' : 'TERM',
    error: killed ? undefined : 'still running (retry with --force)',
  };
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(75);
  }
  return !isAlive(pid);
}

function explain(err) {
  if (err.code === 'EPERM') return 'permission denied (owned by another user — try sudo)';
  if (err.code === 'ESRCH') return 'no such process';
  return err.message || String(err);
}
