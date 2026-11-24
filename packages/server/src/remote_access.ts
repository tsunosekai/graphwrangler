// 接続元アドレスによる受け入れ制限（2026-11-24。デスクトップ常駐化に伴う）。
// デスクトップ版はスマホから VPN（Tailscale）越しに開けるようにするため 0.0.0.0 で待ち受けるが、
// そのままだと同じ Wi-Fi の他の機器からも開けてしまう。env GRAPHWRANGLER_ALLOW_REMOTE に
// 許す範囲を書くと、それ以外の接続元は 403 で断る。
//
// 「Tailscale のアドレスにだけバインドする」方式を採らないのは、ログイン直後の自動起動では
// Tailscale がまだアドレスを持っていないことがあり、バインドに失敗する／後から付いた
// アドレスを拾うためにサーバを上げ直す必要が出るため。全インターフェイスで待ち受けて
// 接続元で絞るほうが、起動順に左右されない。
//
// 値はカンマ区切り: "tailscale"（100.64.0.0/10 と fd7a:115c:a1e0::/48）、"lan"
// （プライベートアドレス全般）、"any"（制限なし）。ループバックは常に許す。
// 未設定なら制限しない（VPS 運用の従来挙動のまま）。

export type RemoteScope = "tailscale" | "lan" | "any";

/** env の値をパースする。未設定・空は null（＝制限しない） */
export function parseAllowRemote(raw: string | undefined): Set<RemoteScope> | null {
  if (raw === undefined) return null;
  const scopes = new Set<RemoteScope>();
  for (const part of raw.split(",")) {
    const v = part.trim().toLowerCase();
    if (v === "tailscale" || v === "lan" || v === "any") scopes.add(v);
  }
  // 値はあるが有効な範囲が1つも無い（"" や打ち間違い）= ループバックのみ。黙って全開にしない
  return scopes;
}

/** IPv4 を 32bit 整数へ。IPv4 でなければ null */
function ipv4ToInt(addr: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (b & mask);
}

/** 接続元アドレスを受け入れるか（純粋関数）。scopes=null は制限なし */
export function isRemoteAllowed(address: string | undefined, scopes: Set<RemoteScope> | null): boolean {
  if (scopes === null || scopes.has("any")) return true;
  if (!address) return false; // 接続元が分からないものは通さない
  let addr = address.toLowerCase();
  // IPv4 射影アドレス（::ffff:100.64.0.1）は IPv4 として判定する
  if (addr.startsWith("::ffff:") && addr.includes(".")) addr = addr.slice(7);
  // スコープID（fe80::1%eth0）は落とす
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);

  const v4 = ipv4ToInt(addr);
  if (v4 !== null) {
    if (inCidr4(v4, "127.0.0.0", 8)) return true;
    if (scopes.has("tailscale") && inCidr4(v4, "100.64.0.0", 10)) return true;
    if (scopes.has("lan")) {
      if (inCidr4(v4, "10.0.0.0", 8) || inCidr4(v4, "172.16.0.0", 12) || inCidr4(v4, "192.168.0.0", 16)) {
        return true;
      }
    }
    return false;
  }
  if (addr === "::1") return true;
  if (scopes.has("tailscale") && addr.startsWith("fd7a:115c:a1e0:")) return true;
  if (scopes.has("lan") && (/^f[cd]/.test(addr) || addr.startsWith("fe80:"))) return true;
  return false;
}
