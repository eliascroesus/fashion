import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

/**
 * Which addresses a server-side fetch of someone's link may connect to: only
 * the public internet. The same rules as services/embedder's `is_public`.
 */

/** IPv4 blocks that aren't the public internet (IANA special-purpose registry). */
const NOT_PUBLIC_V4: readonly [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // old 6to4 relays
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

function v4Number(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const V4_BLOCKS = NOT_PUBLIC_V4.map(([base, bits]) => {
  const size = 2 ** (32 - bits);
  return { start: v4Number(base) ?? 0, size };
});

function isPublicV4Number(value: number): boolean {
  return !V4_BLOCKS.some(({ start, size }) => value >= start && value < start + size);
}

/** An IPv6 address as its eight 16-bit groups, or null if it isn't one. */
export function ipv6Groups(text: string): number[] | null {
  if (text.includes('%') || isIP(text) !== 6) return null; // zone ids only exist for link-local
  let address = text.toLowerCase();
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = v4Number(tail);
    if (v4 === null) return null;
    address = `${address.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [left = '', right] = address.split('::');
  const head = left === '' ? [] : left.split(':');
  const rest = right === undefined || right === '' ? [] : right.split(':');
  const missing = 8 - head.length - rest.length;
  if (right === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(right === undefined ? 0 : missing).fill('0'), ...rest];
  return groups.map((g) => parseInt(g, 16));
}

function isPublicV6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embeddedV4 = g6 * 65536 + g7;
  // IPv4 hidden in IPv6: mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) are judged as IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicV4Number(embeddedV4);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPublicV4Number(embeddedV4);
  }
  // Only global unicast (2000::/3); that leaves out loopback, unique-local (Fly's fdaa::),
  // link-local, multicast and the rest.
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 < 0x0200) return false; // IETF protocol assignments, Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return false; // 6to4: carries an IPv4 address we can't vouch for
  if (g0 === 0x3fff && g1 < 0x1000) return false; // documentation (3fff::/20)
  return true;
}

/** True only for an address on the public internet. Anything unparseable is not. */
export function isPublicAddress(address: string): boolean {
  const v4 = v4Number(address);
  if (v4 !== null) return isPublicV4Number(v4);
  const groups = ipv6Groups(address);
  return groups !== null && isPublicV6(groups);
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** How names are looked up; tests replace it to point names at a local server. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = (hostname) =>
  dnsLookup(hostname, { all: true, order: 'verbatim' });

export class ForbiddenAddressError extends Error {
  constructor(hostname: string) {
    super(`${hostname} leads to a private or internal address.`);
    this.name = 'ForbiddenAddressError';
  }
}

/**
 * A `lookup` for http(s).request: resolves the name and refuses it unless
 * every address is allowed, so the address checked is the one connected to
 * (no gap for a name that answers differently the second time).
 */
export function guardedLookup(
  resolve: Resolver,
  isAllowed: (ip: string) => boolean,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((addresses) => {
        const wanted =
          options.family === 4 || options.family === 6
            ? addresses.filter((a) => a.family === options.family)
            : addresses;
        if (addresses.length === 0 || !addresses.every((a) => isAllowed(a.address))) {
          throw new ForbiddenAddressError(hostname);
        }
        const [first] = wanted;
        if (!first) throw new ForbiddenAddressError(hostname);
        if (options.all) callback(null, wanted);
        else callback(null, first.address, first.family);
      })
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        callback(err, '', 0);
      });
  };
}
