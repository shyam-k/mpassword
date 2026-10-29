/** URL / origin helpers. Only http(s) pages can hold logins. */

export function originOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return u.origin.toLowerCase();
}

/** Accepts "example.com" or a full URL; returns a URL string with a scheme (defaults to https). */
export function normaliseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/**
 * Does a saved login (by origin) apply to the page origin?
 * Exact origin always matches. With matchSubdomains, a page on a subdomain of the saved host matches too,
 * but only with the same scheme and port. Never matches across http/https.
 */
export function originMatches(savedOrigin: string, pageOrigin: string, matchSubdomains: boolean): boolean {
  if (savedOrigin === pageOrigin) return true;
  if (!matchSubdomains) return false;
  let saved: URL, page: URL;
  try {
    saved = new URL(savedOrigin);
    page = new URL(pageOrigin);
  } catch {
    return false;
  }
  if (saved.protocol !== page.protocol || saved.port !== page.port) return false;
  return page.hostname.endsWith(`.${saved.hostname}`);
}
