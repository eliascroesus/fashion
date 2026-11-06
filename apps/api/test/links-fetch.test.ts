import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type FetchOptions,
  LinkFetchError,
  PUBLIC_INTERNET,
  safeFetch,
} from '../src/links/fetch.ts';
import { type LocalShop, page, redirect, startLocalShop } from './local-shop.ts';

let shop: LocalShop;

const html: Omit<FetchOptions, 'network'> = {
  accept: 'text/html',
  maxBytes: 64 * 1024,
  overLimit: 'truncate',
  contentTypes: ['text/html'],
};

function get(url: string, options: Partial<FetchOptions> = {}) {
  return safeFetch(new URL(url), { ...html, network: shop.network, ...options });
}

async function problem(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LinkFetchError) return error.problem;
    throw error;
  }
  return 'no error';
}

beforeAll(async () => {
  shop = await startLocalShop();
  shop.route('/p/1', page('<h1>Product</h1>'));
  shop.route('/hop1', redirect('/hop2', 301));
  shop.route('/hop2', redirect(shop.url('/p/1', 'www.shop.test')));
  for (let i = 0; i < 7; i++) shop.route(`/loop${String(i)}`, redirect(`/loop${String(i + 1)}`));
  shop.route('/to-metadata', redirect('http://169.254.169.254/latest/meta-data/'));
  shop.route('/to-private-name', redirect('http://intranet.example/admin'));
  shop.route('/big', page(`<html>${'x'.repeat(200 * 1024)}</html>`));
  shop.route('/gzip', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(gzipSync('<h1>gzipped</h1>'));
  });
  shop.route('/br', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'br' });
    res.end(brotliCompressSync('<h1>brotli</h1>'));
  });
  shop.route('/bomb', (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' });
    res.end(gzipSync(Buffer.alloc(50 * 1024 * 1024)));
  });
  shop.route('/slow', () => {
    // Never answers.
  });
  shop.route('/drip', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const timer = setInterval(() => res.write('<'), 50);
    res.on('close', () => {
      clearInterval(timer);
    });
  });
  shop.route('/to-file', redirect('file:///etc/passwd'));
  shop.route('/to-script', redirect('javascript:alert(1)'));
  shop.route('/pdf', (_req, res) =>
    res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF'),
  );
  shop.route('/blocked', (_req, res) =>
    res.writeHead(403, { 'content-type': 'text/html' }).end('no'),
  );
  shop.route('/busy', (_req, res) => res.writeHead(429).end());
  shop.route('/gone', (_req, res) => res.writeHead(410).end());
  shop.names.set('intranet.example', [{ address: '10.1.2.3', family: 4 }]);
  shop.names.set('mixed.example', [
    { address: '93.184.216.34', family: 4 },
    { address: '192.168.0.10', family: 4 },
  ]);
});

afterAll(async () => {
  await shop.close();
});

describe('safe fetching', () => {
  it('follows redirects (relative, across hosts) and reports where it landed', async () => {
    const answer = await get(shop.url('/hop1'));
    expect(answer.url.href).toBe(shop.url('/p/1', 'www.shop.test'));
    expect(answer.body.toString()).toBe('<h1>Product</h1>');
    expect(shop.requests.slice(-3).map((r) => r.path)).toEqual(['/hop1', '/hop2', '/p/1']);
  });

  it('looks each name up on the connection itself, once per request', async () => {
    shop.lookups.length = 0;
    await get(shop.url('/hop1'));
    expect(shop.lookups).toEqual(['shop.test', 'shop.test', 'www.shop.test']);
  });

  it('stops after 5 redirects', async () => {
    expect(await problem(get(shop.url('/loop0')))).toBe('too_many_redirects');
  });

  it('refuses private addresses: as a link, after a redirect, behind a name, or mixed in', async () => {
    expect(await problem(get('http://10.0.0.1/'))).toBe('forbidden');
    expect(await problem(get('http://[::1]/'))).toBe('forbidden');
    expect(await problem(get('http://[::ffff:127.0.0.2]/'))).toBe('forbidden');
    expect(await problem(get(shop.url('/to-metadata')))).toBe('forbidden');
    expect(await problem(get(shop.url('/to-private-name')))).toBe('forbidden');
    expect(await problem(get('http://mixed.example/'))).toBe('forbidden');
    expect(await problem(get('http://localhost/'))).toBe('forbidden');
  });

  it('refuses the local shop itself on the real internet rules', async () => {
    const real = { ...PUBLIC_INTERNET, resolve: shop.network.resolve };
    expect(await problem(get(shop.url('/p/1'), { network: real }))).toBe('bad_link'); // odd port
    expect(
      await problem(get(shop.url('/p/1'), { network: { ...real, ports: shop.network.ports } })),
    ).toBe('forbidden'); // 127.0.0.1
  });

  it('refuses other schemes, passwords and odd ports', async () => {
    expect(await problem(get('ftp://shop.test/file'))).toBe('bad_link');
    expect(await problem(get(`http://user:pw@shop.test:${String(shop.port)}/p/1`))).toBe(
      'bad_link',
    );
    expect(await problem(get('http://shop.test:8080/p/1'))).toBe('bad_link');
  });

  it('reads gzip and brotli pages', async () => {
    expect((await get(shop.url('/gzip'))).body.toString()).toBe('<h1>gzipped</h1>');
    expect((await get(shop.url('/br'))).body.toString()).toBe('<h1>brotli</h1>');
  });

  it('cuts a big page at the limit, or refuses a big file', async () => {
    const cut = await get(shop.url('/big'));
    expect(cut.truncated).toBe(true);
    expect(cut.body.length).toBe(64 * 1024);
    expect(await problem(get(shop.url('/big'), { overLimit: 'refuse' }))).toBe('not_a_page');
    const bomb = get(shop.url('/bomb'), {
      contentTypes: ['image/'],
      maxBytes: 1024 * 1024,
      overLimit: 'refuse',
    });
    expect(await problem(bomb)).toBe('not_a_page');
  });

  it('gives up on a shop that never answers', async () => {
    const started = Date.now();
    expect(await problem(get(shop.url('/slow'), { timeoutMs: 300 }))).toBe('too_slow');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('gives up on a page that arrives a byte at a time', async () => {
    const started = Date.now();
    expect(await problem(get(shop.url('/drip'), { timeoutMs: 400 }))).toBe('too_slow');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses redirects to file: and javascript: links', async () => {
    expect(await problem(get(shop.url('/to-file')))).toBe('bad_link');
    expect(await problem(get(shop.url('/to-script')))).toBe('bad_link');
  });

  it('refuses IPv4 addresses written as numbers, octal or hex', async () => {
    const real = { ...PUBLIC_INTERNET, resolve: shop.network.resolve };
    for (const link of [
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://0177.0.0.1/',
      'http://127.1/',
      'http://0/',
      'http://167772161/',
      'http://[::ffff:a9fe:a9fe]/',
    ]) {
      expect(await problem(get(link, { network: real })), link).toBe('forbidden');
    }
  });

  it('names the problem for odd answers', async () => {
    expect(await problem(get(shop.url('/pdf')))).toBe('not_a_page');
    expect(await problem(get(shop.url('/blocked')))).toBe('blocked');
    expect(await problem(get(shop.url('/busy')))).toBe('blocked');
    expect(await problem(get(shop.url('/gone')))).toBe('not_found');
    expect(await problem(get(shop.url('/nothing-here')))).toBe('not_found');
    expect(await problem(get('http://no-such-shop.example/'))).toBe('unreachable');
  });
});
