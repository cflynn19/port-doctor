import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run a command and return stdout. Tools like `lsof` and `ps` exit non-zero
 * when they simply have nothing to report, so a non-zero exit with usable
 * stdout is treated as success. A missing binary still throws (ENOENT).
 */
export async function run(cmd, args, opts = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
    });
    return stdout;
  } catch (err) {
    if (err && err.code === 'ENOENT') throw err;
    if (err && typeof err.stdout === 'string') return err.stdout;
    throw err;
  }
}

export async function has(cmd) {
  try {
    const out = await run(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
