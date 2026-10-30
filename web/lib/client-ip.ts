// Which client address web sees. better-auth's rate limits take the client from X-Forwarded-For (right to left,
// skipping advanced.ipAddress.trustedProxies) and never look at the TCP peer. So every request is normalised in
// server.ts before Next sees it:
//   - from a TRUSTED_PROXIES peer (the edge nginx; default: whatever "edge" resolves to, and loopback): its
//     X-Forwarded-For is kept (and set to the peer if missing);
//   - from anyone else (a harness calling web:3000 directly, anything on core or a user network): every forwarding
//     header is dropped and X-Forwarded-For becomes the TCP peer. A harness can no longer pick a new "client address"
//     per request (unlimited password guesses) or share one with everybody (poisoning a common bucket).
// TRUSTED_PROXY_HOPS (IPs/CIDRs, default none) are proxies in front of the edge (e.g. a TLS-terminating nginx), which
// better-auth skips inside the chain. /api/harness/* is not normalised: it refuses any forwarding header (harness-api.ts).
import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

export const DEFAULT_TRUSTED_PROXIES = "127.0.0.1,::1,edge";
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*$/i;
const FORWARDING = ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-client-ip", "true-client-ip", "cf-connecting-ip"];

export type TrustSpec = { addresses: string[]; cidrs: string[]; hosts: string[]; invalid: string[] };

export function parseTrustList(raw: string | undefined): TrustSpec {
  const spec: TrustSpec = { addresses: [], cidrs: [], hosts: [], invalid: [] };
  for (const item of (raw ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)) {
    const [addr, bits, extra] = item.split("/");
    if (extra === undefined && bits !== undefined) {
      const fam = isIP(addr);
      const n = Number(bits);
      if (fam && /^\d{1,3}$/.test(bits) && n <= (fam === 4 ? 32 : 128)) spec.cidrs.push(item);
      else spec.invalid.push(item);
    } else if (bits === undefined && isIP(addr)) spec.addresses.push(addr);
    else if (bits === undefined && HOST_RE.test(addr)) spec.hosts.push(addr.toLowerCase());
    else spec.invalid.push(item);
  }
  return spec;
}

// "::ffff:10.0.0.1" → "10.0.0.1"; undefined → "".
export const peerAddress = (raw: string | undefined) => {
  const a = (raw ?? "").trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return m ? m[1] : a;
};

function blockList(addresses: string[], cidrs: string[]): BlockList {
  const b = new BlockList();
  for (const a of addresses) b.addAddress(a, isIP(a) === 6 ? "ipv6" : "ipv4");
  for (const c of cidrs) {
    const [a, bits] = c.split("/");
    b.addSubnet(a, Number(bits), isIP(a) === 6 ? "ipv6" : "ipv4");
  }
  return b;
}

// The set of peers allowed to pass X-Forwarded-For through: static entries, plus host names resolved now and then.
export class ProxyTrust {
  private resolved: string[] = [];
  private list: BlockList;
  constructor(readonly spec: TrustSpec, private resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((r) => r.address)) {
    this.list = blockList(spec.addresses, spec.cidrs);
  }
  async refresh(): Promise<void> {
    const found: string[] = [];
    for (const h of this.spec.hosts) found.push(...(await this.resolve(h).catch(() => [])));
    this.resolved = [...new Set(found.map(peerAddress).filter((a) => isIP(a)))];
    this.list = blockList([...this.spec.addresses, ...this.resolved], this.spec.cidrs);
  }
  isTrusted(peer: string): boolean {
    const a = peerAddress(peer);
    const fam = isIP(a);
    return fam !== 0 && this.list.check(a, fam === 6 ? "ipv6" : "ipv4");
  }
  get resolvedAddresses() {
    return [...this.resolved];
  }
}

// In place, on the Node request headers, before Next or the WS bridge see them.
export function normalizeForwarded(headers: IncomingHttpHeaders, rawPeer: string | undefined, trust: Pick<ProxyTrust, "isTrusted">): void {
  const peer = peerAddress(rawPeer);
  if (peer && trust.isTrusted(peer)) {
    if (!headers["x-forwarded-for"]) headers["x-forwarded-for"] = peer;
    return;
  }
  for (const h of FORWARDING) delete headers[h];
  if (peer) headers["x-forwarded-for"] = peer;
}

// better-auth's trustedProxies: proxies in front of the edge, skipped inside X-Forwarded-For. Addresses and CIDRs only.
export function trustedHops(raw: string | undefined): string[] {
  const s = parseTrustList(raw);
  return [...s.addresses, ...s.cidrs];
}
