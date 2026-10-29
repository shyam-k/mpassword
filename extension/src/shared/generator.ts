import { randomInt } from './crypto';

export interface GeneratorOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
}

export const DEFAULT_GENERATOR: GeneratorOptions = {
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: true,
};

const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/~',
};
const AMBIGUOUS = /[Il1O0o]/g;

/** Generates a password with at least one character from each selected class, using unbiased randomness. */
export async function generatePassword(opts: GeneratorOptions = DEFAULT_GENERATOR): Promise<string> {
  const length = Math.max(8, Math.min(128, Math.floor(opts.length)));
  const pools: string[] = [];
  for (const k of ['lower', 'upper', 'digits', 'symbols'] as const) {
    if (opts[k]) pools.push(opts.avoidAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]);
  }
  if (pools.length === 0) pools.push(SETS.lower);
  const all = pools.join('');
  const chars: string[] = [];
  for (const pool of pools) chars.push(pool[await randomInt(pool.length)]!);
  while (chars.length < length) chars.push(all[await randomInt(all.length)]!);
  // Fisher-Yates shuffle so the guaranteed characters are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = await randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/** Rough strength estimate in bits, used only for UI hints and the master-password gate. */
export function estimateBits(password: string): number {
  if (!password) return 0;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  const unique = new Set(password).size;
  // Penalise heavy repetition (e.g. "aaaaaaaa").
  const effectiveLen = Math.min(password.length, unique * 2);
  return Math.round(effectiveLen * Math.log2(Math.max(pool, 2)));
}

export interface MasterCheck {
  ok: boolean;
  message: string;
}

/** Master password must be long and varied: at least 12 characters and about 60 bits by the estimate above. */
export function checkMasterPassword(password: string): MasterCheck {
  if (password.length < 12) return { ok: false, message: 'Use at least 12 characters (a 4-word passphrase works well).' };
  const bits = estimateBits(password);
  if (bits < 60) return { ok: false, message: 'Too predictable. Mix in more words, numbers or symbols.' };
  return { ok: true, message: bits >= 80 ? 'Strong' : 'Good' };
}
