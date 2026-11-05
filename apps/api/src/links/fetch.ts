import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { LinkProblem } from '@outfitly/shared';
import {
  ForbiddenAddressError,
  guardedLookup,
  isPublicAddress,
  type Resolver,
  systemResolver,
} from './address.ts';

/**
 * Server-side fetches of links people paste (shop pages, product photos):
 * public addresses only (checked on the connection itself), http(s) on the
 * standard ports, redirects followed by hand and re-checked, strict time and
 * size limits. CLAUDE.md: "Any server fetch of an external URL".
 */

export const USER_AGENT = 'Mozilla/5.0 (compatible; OutfitlyBot/1.0; +https://outfitly.app/bot)';
const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 3_000;
const TOTAL_TIMEOUT_MS = 10_000;

export class LinkFetchError extends Error {
  readonly problem: LinkProblem;
  /** The shop's HTTP status, when it answered. */
  readonly httpStatus: number | null;
  /** How long a busy shop (429 / 503) asked us to wait (`Retry-After`), when it said. */
  readonly retryAfterMs: number | null;

  constructor(
    problem: LinkProblem,
    message: string,
    httpStatus: number | null = null,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'LinkFetchError';
    this.problem = problem;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

/** `Retry-After` as seconds or an HTTP date, in ms from `now`; null when missing or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d{1,9}$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Worth trying again later: the shop was down, slow or busy (429 / 503), not refusing. */
export function isTemporary(error: LinkFetchError): boolean {
  if (error.problem === 'unreachable' || error.problem === 'too_slow') return true;
  return error.problem === 'blocked' && (error.httpStatus === 429 || error.httpStatus === 503);
}

/** Network rules; tests loosen them to reach a local server. */
export interface NetworkPolicy {
  resolve: Resolver;
  isAllowed: (ip: string) => boolean;
  ports: ReadonlySet<number>;
}

export const PUBLIC_INTERNET: NetworkPolicy = {
  resolve: systemResolver,
  isAllowed: isPublicAddress,
  ports: new Set([80, 443]),
};

export interface FetchOptions {
  /** `Accept` header. */
  accept: string;
  /** Most bytes read (after decompression). */
  maxBytes: number;
  /** Over `maxBytes`: keep what was read (pages: product data sits near the top) or refuse. */
  overLimit: 'truncate' | 'refuse';
  /** Content types accepted for a 200 answer (prefix match). */
  contentTypes: readonly string[];
  network?: NetworkPolicy;
  /** Whole fetch, redirects included. */
  timeoutMs?: number;
}

export interface Fetched {
  /** Where the answer came from, after redirects. */
  url: URL;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

/** Checks a link before connecting: http(s), standard port, no password, allowed literal IP. */
export function checkUrl(url: URL, network: NetworkPolicy): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new LinkFetchError('bad_link', 'Only http and https links can be read.');
  }
  if (url.username || url.password) {
    throw new LinkFetchError('bad_link', 'Links with a user name or password are not read.');
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!network.ports.has(port)) {
    throw new LinkFetchError('bad_link', 'Links on unusual ports are not read.');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  // A literal IP skips the name lookup, so it's checked here.
  if (isIP(host) !== 0 && !network.isAllowed(host)) {
    throw new LinkFetchError('forbidden', 'The link leads to a private or internal address.');
  }
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    throw new LinkFetchError('forbidden', 'The link leads to a private or internal address.');
  }
}

function decoded(response: IncomingMessage): Readable {
  const encoding = (response.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return response.pipe(zlib.createInflate());
  if (encoding === 'br') return response.pipe(zlib.createBrotliDecompress());
  if (encoding === '' || encoding === 'identity') return response;
  throw new LinkFetchError('not_a_page', `Unsupported content encoding: ${encoding}.`);
}

async function readBody(
  stream: Readable,
  maxBytes: number,
  overLimit: FetchOptions['overLimit'],
): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (size + chunk.length > maxBytes) {
      if (overLimit === 'refuse') {
        stream.destroy();
        throw new LinkFetchError('not_a_page', 'The file is larger than allowed.');
      }
      chunks.push(chunk.subarray(0, maxBytes - size));
      stream.destroy();
      return { body: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { body: Buffer.concat(chunks), truncated: false };
}

interface Answer {
  status: number;
  location: string | null;
  retryAfter: string | null;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

function requestOnce(
  url: URL,
  options: FetchOptions,
  network: NetworkPolicy,
  signal: AbortSignal,
): Promise<Answer> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise<Answer>((resolve, reject) => {
    let connectTimer: NodeJS.Timeout | undefined;
    const request = client.request(url, {
      method: 'GET',
      agent: false,
      lookup: guardedLookup(network.resolve, network.isAllowed),
      signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: options.accept,
        'accept-encoding': 'gzip, deflate, br',
        // Nordic shops show local prices to Nordic visitors.
        'accept-language': 'sv-SE,sv;q=0.9,en;q=0.8',
      },
    });
    request.on('socket', (socket) => {
      connectTimer = setTimeout(() => {
        request.destroy(new LinkFetchError('too_slow', 'The shop took too long to answer.'));
      }, CONNECT_TIMEOUT_MS);
      socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        clearTimeout(connectTimer);
      });
    });
    request.on('close', () => {
      clearTimeout(connectTimer);
    });
    request.on('error', reject);
    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      const contentType = (response.headers['content-type'] ?? '').toLowerCase();
      const location = response.headers.location ?? null;
      const retryAfter = response.headers['retry-after'] ?? null;
      if (status !== 200) {
        // The body of a redirect or an error page isn't wanted: don't download it.
        response.destroy();
        resolve({
          status,
          location,
          retryAfter,
          contentType,
          body: Buffer.alloc(0),
          truncated: false,
        });
        return;
      }
      if (!options.contentTypes.some((type) => contentType.startsWith(type))) {
        response.destroy();
        reject(new LinkFetchError('not_a_page', `The link isn't a web page (${contentType}).`));
        return;
      }
      const declared = Number(response.headers['content-length'] ?? NaN);
      if (options.overLimit === 'refuse' && declared > options.maxBytes) {
        response.destroy();
        reject(new LinkFetchError('not_a_page', 'The file is larger than allowed.'));
        return;
      }
      let stream: Readable;
      try {
        stream = decoded(response);
      } catch (error) {
        response.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      readBody(stream, options.maxBytes, options.overLimit)
        .then(({ body, truncated }) => {
          response.destroy();
          resolve({ status, location, retryAfter, contentType, body, truncated });
        })
        .catch(reject);
    });
    request.end();
  });
}

function problemFor(error: unknown, signal: AbortSignal): LinkFetchError {
  if (error instanceof LinkFetchError) return error;
  if (error instanceof ForbiddenAddressError) {
    return new LinkFetchError('forbidden', 'The link leads to a private or internal address.');
  }
  if (signal.aborted) return new LinkFetchError('too_slow', 'The shop took too long to answer.');
  const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new LinkFetchError('unreachable', "The shop's address doesn't exist.");
  }
  if (code.startsWith('ERR_TLS') || code.includes('CERT')) {
    return new LinkFetchError('unreachable', "The shop's secure connection didn't check out.");
  }
  if (code === 'Z_DATA_ERROR' || code === 'ERR_BROTLI_DECOMPRESSION_FAILED') {
    return new LinkFetchError('not_a_page', 'The page arrived damaged.');
  }
  return new LinkFetchError('unreachable', "The shop couldn't be reached.");
}

function problemForStatus(status: number, retryAfter: string | null): LinkFetchError {
  if (status === 404 || status === 410) {
    return new LinkFetchError('not_found', 'The shop says this page no longer exists.', status);
  }
  if (status === 429 || status === 503) {
    const wait = retryAfterMs(retryAfter);
    return new LinkFetchError('blocked', 'The shop turned our link reader away.', status, wait);
  }
  if (status === 401 || status === 403 || status === 999) {
    return new LinkFetchError('blocked', 'The shop turned our link reader away.', status);
  }
  return new LinkFetchError('unreachable', `The shop answered ${String(status)}.`, status);
}

/** Fetches a link, following up to 5 redirects, each one checked like the first. */
export async function safeFetch(start: URL, options: FetchOptions): Promise<Fetched> {
  const network = options.network ?? PUBLIC_INTERNET;
  const signal = AbortSignal.timeout(options.timeoutMs ?? TOTAL_TIMEOUT_MS);
  let url = start;
  for (let hop = 0; ; hop++) {
    checkUrl(url, network);
    let answer: Answer;
    try {
      answer = await requestOnce(url, options, network, signal);
    } catch (error) {
      throw problemFor(error, signal);
    }
    if (answer.status >= 300 && answer.status < 400 && answer.location) {
      if (hop >= MAX_REDIRECTS) {
        throw new LinkFetchError('too_many_redirects', 'The link redirects too many times.');
      }
      try {
        url = new URL(answer.location, url);
      } catch {
        throw new LinkFetchError('bad_link', 'The shop redirected to a broken link.');
      }
      continue;
    }
    if (answer.status !== 200) throw problemForStatus(answer.status, answer.retryAfter);
    return { url, contentType: answer.contentType, body: answer.body, truncated: answer.truncated };
  }
}
