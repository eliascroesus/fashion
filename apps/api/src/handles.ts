import { randomInt } from 'node:crypto';

const MAX_LENGTH = 30;

/**
 * A starting handle for a new profile: the email's name part when there is
 * one (`anna.svensson` → `anna.svensson4821`), else `user` + digits. Handles
 * are lowercase letters, digits, dots and underscores (see profiles_handle_format).
 */
export function generateHandle(email: string | undefined, digits = 4): string {
  const local = (email?.split('@')[0] ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._]+|[._]+$/g, '');
  const base = local.length >= 3 ? local : 'user';
  const suffix = String(randomInt(10 ** (digits - 1), 10 ** digits));
  return `${base.slice(0, MAX_LENGTH - suffix.length)}${suffix}`;
}
