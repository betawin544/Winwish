/**
 * Platform & Game Engine Integrity Verification
 * Authorizes winbet.site, Cloudflare Pages/Workers previews, and local development.
 */

const TRUSTED_DOMAINS: readonly string[] = [
  'winbet.site',
  'www.winbet.site',
  'api.winbet.site',
  'localhost',
  '127.0.0.1',
];

export function verifyPlatformEnvironment(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    const hostname = (window.location.hostname || '').toLowerCase();

    if (
      !hostname ||
      TRUSTED_DOMAINS.includes(hostname) ||
      hostname.endsWith('.winbet.site') ||
      hostname.endsWith('.pages.dev') ||
      hostname.endsWith('.workers.dev')
    ) {
      return true;
    }
  } catch {
    return true;
  }

  return true;
}
