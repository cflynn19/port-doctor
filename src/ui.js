import readline from 'node:readline/promises';

const ESC = String.fromCharCode(27);
const SGR = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
};

let colorEnabled = true;

export function setColor(enabled) {
  colorEnabled = enabled;
}

export function shouldUseColor({ noColor }) {
  if (noColor) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

function paint(name, text) {
  return colorEnabled ? `${SGR[name]}${text}${SGR.reset}` : String(text);
}

export const c = {
  bold: (t) => paint('bold', t),
  dim: (t) => paint('dim', t),
  red: (t) => paint('red', t),
  green: (t) => paint('green', t),
  yellow: (t) => paint('yellow', t),
  cyan: (t) => paint('cyan', t),
};

/** 8043 -> "2h 14m", 45 -> "45s", 400000 -> "4d 15h" */
export function formatAge(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return 'unknown';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const units = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  const parts = [];
  let rest = s;
  for (const [label, size] of units) {
    const value = Math.floor(rest / size);
    rest -= value * size;
    if (value > 0 || parts.length > 0) parts.push(`${value}${label}`);
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/** Shorten to at most `max` characters, ellipsis included. */
export function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, Math.max(0, max));
  return `${value.slice(0, max - 3)}...`;
}

/** Two-column "label   value" block, padded to a shared gutter. */
export function detailBlock(rows, indent = '  ') {
  const visible = rows.filter(([, value]) => value != null && value !== '');
  const width = Math.max(0, ...visible.map(([label]) => label.length));
  return visible
    .map(([label, value]) => `${indent}${c.dim(label.padEnd(width))}  ${value}`)
    .join('\n');
}

/**
 * Ask a yes/no question. Returns `null` when there is no terminal to ask on,
 * which callers treat as "do nothing" rather than as "no".
 */
export async function confirm(question, { defaultYes = false, input, output } = {}) {
  const stdin = input || process.stdin;
  const stdout = output || process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) return null;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${question} ${c.dim(hint)} `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  } catch {
    return false;
  } finally {
    rl.close();
  }
}
