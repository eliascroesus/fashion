import * as Sentry from '@sentry/node';

export interface SentryOptions {
  dsn: string;
  environment?: string | undefined;
  beforeSend?: Sentry.NodeOptions['beforeSend'];
}

/** Error reporting: only our own failures (5xx), and no personal data. */
export function initSentry(options: SentryOptions): void {
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    tracesSampleRate: 0,
    integrations: [
      Sentry.fastifyIntegration({
        shouldHandleError: (_error, _request, reply) => reply.statusCode >= 500,
      }),
    ],
    // No user details, cookies, headers, bodies or query strings.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
  });
}
