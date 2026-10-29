/**
 * Crypto core. Every primitive comes from libsodium; this file only composes them.
 *
 *  - Key derivation: Argon2id (crypto_pwhash, ALG_ARGON2ID13)
 *  - Symmetric encryption: XChaCha20-Poly1305 IETF AEAD with 24-byte random nonces
 *  - Randomness: randombytes_buf / randombytes_uniform (no modulo bias)
 */
import sodiumModule from 'libsodium-wrappers-sumo';

export type Sodium = typeof sodiumModule;

let readyPromise: Promise<Sodium> | null = null;

/** Resolve libsodium once (it loads WASM). */
export function sodium(): Promise<Sodium> {
  if (!readyPromise) {
    readyPromise = sodiumModule.ready.then(() => sodiumModule);
  }
  return readyPromise;
}

export const KEY_BYTES = 32;
export const SALT_BYTES = 16;
export const NONCE_BYTES = 24;

export interface KdfParams {
  alg: 'argon2id13';
  /** base64 salt */
  salt: string;
  /** iterations (opslimit) */
  ops: number;
  /** memory in bytes (memlimit) */
  mem: number;
}

/** Defaults: 64 MiB, 3 passes (OWASP-recommended range for Argon2id). */
export const DEFAULT_KDF_OPS = 3;
export const DEFAULT_KDF_MEM = 64 * 1024 * 1024;

/** Lower and upper bounds accepted from stored headers, so a tampered header cannot weaken or DoS the KDF. */
const MIN_OPS = 2;
const MAX_OPS = 20;
const MIN_MEM = 16 * 1024 * 1024;
const MAX_MEM = 1024 * 1024 * 1024;

export interface Sealed {
  /** base64 nonce */
  n: string;
  /** base64 ciphertext incl. 16-byte tag */
  c: string;
}

export async function newKdfParams(ops = DEFAULT_KDF_OPS, mem = DEFAULT_KDF_MEM): Promise<KdfParams> {
  const s = await sodium();
  return { alg: 'argon2id13', salt: toB64(s.randombytes_buf(SALT_BYTES)), ops, mem };
}

export function validateKdfParams(p: unknown): KdfParams {
  const k = p as KdfParams;
  if (
    !k ||
    k.alg !== 'argon2id13' ||
    typeof k.salt !== 'string' ||
    !Number.isInteger(k.ops) ||
    !Number.isInteger(k.mem) ||
    k.ops < MIN_OPS ||
    k.ops > MAX_OPS ||
    k.mem < MIN_MEM ||
    k.mem > MAX_MEM
  ) {
    throw new CryptoError('Unsupported or unsafe key-derivation parameters');
  }
  if (fromB64(k.salt).length !== SALT_BYTES) throw new CryptoError('Bad salt');
  return k;
}

/** Derive a 32-byte key from a password. Slow on purpose. */
export async function deriveKey(password: string, params: KdfParams): Promise<Uint8Array> {
  const s = await sodium();
  validateKdfParams(params);
  return s.crypto_pwhash(
    KEY_BYTES,
    s.from_string(password.normalize('NFKC')),
    fromB64(params.salt),
    params.ops,
    params.mem,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function randomKey(): Promise<Uint8Array> {
  const s = await sodium();
  return s.randombytes_buf(KEY_BYTES);
}

export async function randomId(bytes = 16): Promise<string> {
  const s = await sodium();
  return s.to_hex(s.randombytes_buf(bytes));
}

/** Encrypt bytes with associated data (AD is authenticated, not encrypted). */
export async function sealBytes(key: Uint8Array, plaintext: Uint8Array, ad: string): Promise<Sealed> {
  const s = await sodium();
  assertKey(key);
  const nonce = s.randombytes_buf(NONCE_BYTES);
  const c = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, s.from_string(ad), null, nonce, key);
  return { n: toB64(nonce), c: toB64(c) };
}

export async function openBytes(key: Uint8Array, sealed: Sealed, ad: string): Promise<Uint8Array> {
  const s = await sodium();
  assertKey(key);
  if (!sealed || typeof sealed.n !== 'string' || typeof sealed.c !== 'string') {
    throw new CryptoError('Malformed ciphertext');
  }
  const nonce = fromB64(sealed.n);
  if (nonce.length !== NONCE_BYTES) throw new CryptoError('Malformed nonce');
  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, fromB64(sealed.c), s.from_string(ad), nonce, key);
  } catch {
    throw new CryptoError('Decryption failed: wrong key or data was modified');
  }
}

export async function sealJson(key: Uint8Array, value: unknown, ad: string): Promise<Sealed> {
  const s = await sodium();
  const bytes = s.from_string(JSON.stringify(value));
  try {
    return await sealBytes(key, bytes, ad);
  } finally {
    s.memzero(bytes);
  }
}

export async function openJson<T>(key: Uint8Array, sealed: Sealed, ad: string): Promise<T> {
  const s = await sodium();
  const bytes = await openBytes(key, sealed, ad);
  try {
    return JSON.parse(s.to_string(bytes)) as T;
  } finally {
    s.memzero(bytes);
  }
}

export async function wipe(...buffers: (Uint8Array | null | undefined)[]): Promise<void> {
  const s = await sodium();
  for (const b of buffers) if (b) s.memzero(b);
}

/** Unbiased random integer in [0, upper). */
export async function randomInt(upper: number): Promise<number> {
  const s = await sodium();
  return s.randombytes_uniform(upper);
}

export function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function fromB64(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new CryptoError('Invalid base64');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new CryptoError('Invalid key');
}

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}
