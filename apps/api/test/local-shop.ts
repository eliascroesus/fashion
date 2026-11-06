import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isPublicAddress, type ResolvedAddress } from '../src/links/address.ts';
import type { NetworkPolicy } from '../src/links/fetch.ts';

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** A local web server playing shops; every `*.test` name points at it. */
export interface LocalShop {
  port: number;
  /** A link to this server under a `.test` name. */
  url: (path: string, host?: string) => string;
  /** Paths asked for, in order, with the Host header. */
  requests: { host: string; path: string }[];
  route: (path: string, handler: Handler) => void;
  /** The network rules to reach it; anything not `.test` must be public. */
  network: NetworkPolicy;
  /** Names looked up, in order. */
  lookups: string[];
  /** Extra names: host → addresses (e.g. a "harmless" name answering with a private address). */
  names: Map<string, ResolvedAddress[]>;
  close: () => Promise<void>;
}

export async function startLocalShop(): Promise<LocalShop> {
  const routes = new Map<string, Handler>();
  const requests: LocalShop['requests'] = [];
  const server = http.createServer((request, response) => {
    const path = request.url ?? '/';
    requests.push({ host: request.headers.host ?? '', path });
    const handler = routes.get(path.split('?')[0] ?? path) ?? routes.get(path);
    if (handler) handler(request, response);
    else response.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const lookups: string[] = [];
  const names = new Map<string, ResolvedAddress[]>();
  const network: NetworkPolicy = {
    resolve: (hostname) => {
      lookups.push(hostname);
      const listed = names.get(hostname);
      if (listed) return Promise.resolve(listed);
      if (hostname.endsWith('.test')) return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
      const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
        code: 'ENOTFOUND',
      });
      return Promise.reject(error);
    },
    isAllowed: (ip) => ip === '127.0.0.1' || isPublicAddress(ip),
    ports: new Set([80, 443, port]),
  };
  return {
    port,
    url: (path, host = 'shop.test') => `http://${host}:${String(port)}${path}`,
    requests,
    route: (path, handler) => routes.set(path, handler),
    network,
    lookups,
    names,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A handler answering an HTML page. */
export function page(html: string, headers: Record<string, string> = {}): Handler {
  return (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(html);
  };
}

export function redirect(location: string, status = 302): Handler {
  return (_request, response) => {
    response.writeHead(status, { location }).end();
  };
}
