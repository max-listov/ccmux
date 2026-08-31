/**
 * What makes a declared endpoint actually local.
 *
 * The provider kind is called `local`, and the catalog publishes that word to every caller as the
 * provenance of an answer. If the word were only a label a host could attach to any URL, then the
 * one thing this runtime promises about a local model — that the prompt did not leave the host or
 * its network — would be unverifiable at exactly the moment someone needs it to be true. Acceptance
 * asks for no hidden cloud reroute; the honest way to deliver that is to make a cloud endpoint
 * unrepresentable as `local` rather than to promise it never happens.
 *
 * So locality is decided from the address literal, with no name resolution: a schema must not
 * perform I/O, and a DNS answer is not a property of the configuration anyway — it can change after
 * validation. That costs the host the ability to name a machine by an arbitrary hostname, which is
 * a real cost and a deliberate one; `localhost` and address literals cover the endpoints this is
 * for (a model server on the host, or one on the host's own network).
 */

const V4_LOCAL = [
  /** Loopback: the endpoint runs on this very host. */
  { octets: [127], bits: 8 },
  /** RFC 1918 private ranges — the host's own network. */
  { octets: [10], bits: 8 },
  { octets: [172, 16], bits: 12 },
  { octets: [192, 168], bits: 16 },
  /** Link-local, for a directly attached machine with no address assignment. */
  { octets: [169, 254], bits: 16 },
] as const;

function v4Octets(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

/** True when this address literal cannot leave the host or its own network. */
export function isLocalAddress(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost') return true;
  const v4 = v4Octets(host);
  if (v4) {
    return V4_LOCAL.some(({ octets, bits }) => {
      // A /12 does not end on an octet boundary, so compare the masked 32-bit value rather than
      // the leading octets — 172.32.0.1 shares its first octet with the private range and is public.
      const mask = ~((1 << (32 - bits)) - 1);
      const value = (a: number[]) =>
        ((a[0] ?? 0) << 24) | ((a[1] ?? 0) << 16) | ((a[2] ?? 0) << 8) | (a[3] ?? 0);
      const prefix = value([...octets, 0, 0, 0].slice(0, 4));
      return (value(v4) & mask) === (prefix & mask);
    });
  }
  // `new URL()` hands back IPv6 in brackets and already lowercased/compressed.
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1);
    if (v6 === '::1') return true;
    const head = v6.split(':')[0] ?? '';
    if (/^f[cd][0-9a-f]{2}$/.test(head)) return true; // unique local, fc00::/7
    if (/^fe[89ab][0-9a-f]$/.test(head)) return true; // link-local, fe80::/10
  }
  return false;
}

export type EndpointRefusal =
  | 'not-a-url'
  | 'protocol'
  | 'embedded-credentials'
  | 'query-or-fragment'
  | 'not-local';

/** Parse a declared local endpoint, naming the exact reason it is refused. */
export function parseLocalEndpoint(raw: string): { url: URL } | { refused: EndpointRefusal } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { refused: 'not-a-url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { refused: 'protocol' };
  // A credential in the URL would be configuration that travels inside a value the catalog and
  // diagnostics may echo. Authentication belongs in the host's environment, named separately.
  if (url.username !== '' || url.password !== '') return { refused: 'embedded-credentials' };
  if (url.search !== '' || url.hash !== '') return { refused: 'query-or-fragment' };
  if (!isLocalAddress(url.hostname)) return { refused: 'not-local' };
  return { url };
}

export const ENDPOINT_REFUSAL_TEXT: Readonly<Record<EndpointRefusal, string>> = {
  'not-a-url': 'Local provider endpoint must be an absolute URL',
  protocol: 'Local provider endpoint must use http or https',
  'embedded-credentials': 'Local provider endpoint must not embed credentials',
  'query-or-fragment': 'Local provider endpoint must not carry a query or fragment',
  'not-local': 'Local provider endpoint must be a loopback or private address literal',
};
