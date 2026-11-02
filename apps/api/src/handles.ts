import { randomInt } from 'node:crypto';

const MAX_LENGTH = 30;

/**
 * A starting handle for a new profile: `user` + random digits. Handles are
 * public, so they are never built from the email address; people pick their
 * own later. Format: see profiles_handle_format.
 */
export function generateHandle(digits = 4): string {
  const suffix = String(randomInt(10 ** (digits - 1), 10 ** digits));
  return `user${suffix}`.slice(0, MAX_LENGTH);
}
