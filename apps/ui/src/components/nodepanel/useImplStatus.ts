import { useEffect, useMemo, useState } from "react";
import { sha256Hex } from "../../lib/hash";
import type { Node } from "../../types";

/** 試走状態の4値（試走ゲート。docs/design.md 3.5.1）。hash は server の sha256Hex と
 *  同じ値を Web Crypto で計算して突き合わせる */
export type ImplStatusUi = "ok" | "stale" | "unverified" | "not-script";

/** 試走ゲート: command の sha256 を UI 側でも計算し（Web Crypto は非同期）、implTrial.hash と
 *  突き合わせて鮮度を見る（packages/server/src/trial.ts の sha256Hex と同じ値になる） */
export function useImplStatus(node: Node): ImplStatusUi {
  const [scriptHash, setScriptHash] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (node.impl?.type === "script") {
      sha256Hex(node.impl.command).then((h) => {
        if (!cancelled) setScriptHash(h);
      });
    } else {
      setScriptHash(null);
    }
    return () => {
      cancelled = true;
    };
  }, [node.impl]);

  return useMemo(() => {
    if (!node.impl || node.impl.type !== "script") return "not-script";
    if (!node.implTrial) return "unverified";
    if (scriptHash === null) return "unverified"; // ハッシュ計算中は保留（「未検証」扱い）
    if (node.implTrial.hash !== scriptHash) return "stale";
    return node.implTrial.success ? "ok" : "unverified";
  }, [node.impl, node.implTrial, scriptHash]);
}
