// Loaded with `node --import` before anything else so Sentry can hook in early.
import { initSentry } from './sentry.ts';

const dsn = process.env['SENTRY_DSN'];
if (dsn) {
  initSentry({ dsn, environment: process.env['SENTRY_ENVIRONMENT'] ?? process.env['NODE_ENV'] });
}
