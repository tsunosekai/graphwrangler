// チャットの Markdown を「使える」形にする部品（docs/design.md 3.18）。
// AI の発言に含まれる次の3つを、読むだけのものから操作できるものへ変える:
//   - コードブロック          … コピーボタンを付ける（送る文面・入力する値を1クリックで取る）
//   - ```gw-actions ブロック  … 実行ボタンにする（URL・フォルダ・ファイルを開く／コマンド）
//   - チェックリスト（- [ ]） … 押せるようにする（どこまでやったかを残す）
// 人間ノードの前準備のために足したが、AI の発言すべてに効く（Task AI・実行AI・GraphWrangler AI）。
import { isValidElement, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { ACTIONS_LANG, isWebUrl, parseActions, type GwAction } from "@graphwrangler/core/prep";
import { canRunAction, runAction } from "./desktop";
import { mdComponents } from "./linkify";
import { pushToast } from "./toast";

/** React の子から素のテキストを取り出す */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http（Tailscale 越しのスマホ等）では clipboard API が使えない。旧来の方法へ落とす
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyBlock({ text, children }: { text: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="gw-copy-block">
      <button
        type="button"
        className="gw-copy-btn"
        onClick={async () => {
          if (await copyText(text)) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } else {
            pushToast("コピーできませんでした（範囲を選んでコピーしてください）");
          }
        }}
      >
        {copied ? "コピーした" : "コピー"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

function ActionButton({ action }: { action: GwAction }) {
  const [busy, setBusy] = useState(false);
  const runnable = canRunAction(action);
  const what = action.type === "open" ? action.target : action.command;
  return (
    <button
      type="button"
      className="gw-action-btn"
      disabled={busy}
      title={
        runnable
          ? `${action.type === "open" ? "開く" : "実行"}: ${what}${action.auto ? "（着手でも実行されます）" : ""}`
          : `デスクトップ版でだけ実行できます: ${what}`
      }
      data-unavailable={runnable ? undefined : "true"}
      onClick={async () => {
        setBusy(true);
        try {
          await runAction(action);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span aria-hidden="true">
        {action.type === "run" ? "▶" : isWebUrl(action.target) ? "↗" : "📂"}
      </span>
      {action.label}
    </button>
  );
}

function ActionsBlock({ text }: { text: string }) {
  const { actions, invalid } = parseActions(text);
  return (
    <div className="gw-actions">
      {actions.map((a, i) => (
        <ActionButton key={i} action={a} />
      ))}
      {invalid.map((line, i) => (
        <code key={`x${i}`} className="gw-action-invalid" title="この行は実行項目として解釈できません">
          {line}
        </code>
      ))}
    </div>
  );
}

// ---- チェックリスト ----
// 押した状態はこの端末にだけ残す（localStorage）。会話は追記専用で書き換えられないため。
// 読めない環境（プライベートウィンドウ等）でも押せるようにし、残らないだけにする。

const CHECK_PREFIX = "gw.check.";

function readChecks(key: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CHECK_PREFIX + key);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeChecks(key: string, value: Record<string, boolean>): void {
  try {
    localStorage.setItem(CHECK_PREFIX + key, JSON.stringify(value));
  } catch {
    // 保存できなくても画面上は押せる
  }
}

function CheckItem({ storeKey, itemKey, children }: { storeKey: string; itemKey: string; children: ReactNode }) {
  const [checked, setChecked] = useState(() => readChecks(storeKey)[itemKey] === true);
  return (
    <li className="gw-check-item" data-checked={checked ? "true" : undefined}>
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            const next = e.target.checked;
            setChecked(next);
            writeChecks(storeKey, { ...readChecks(storeKey), [itemKey]: next });
          }}
        />
        <span>{children}</span>
      </label>
    </li>
  );
}

/**
 * 操作できる Markdown の components を作る。storeKey はチェックリストの状態の保存先
 * （ふつうはメッセージの id。同じ発言なら開き直しても状態が戻る）。
 */
export function richMdComponents(storeKey: string): Components {
  // 同じ発言には同じ components を返す。毎回作り直すと react-markdown が中身を作り直し、
  // 「コピーした」の表示やチェックの状態が再描画のたびに巻き戻る
  const cached = componentsCache.get(storeKey);
  if (cached) return cached;
  const built = buildComponents(storeKey);
  componentsCache.set(storeKey, built);
  return built;
}

const componentsCache = new Map<string, Components>();

function buildComponents(storeKey: string): Components {
  return {
    ...mdComponents,
    pre: ({ node: _node, children }) => {
      const child = Array.isArray(children) ? children[0] : children;
      const className = isValidElement(child) ? ((child.props as { className?: string }).className ?? "") : "";
      const text = textOf(children).replace(/\n$/, "");
      if (className.split(/\s+/).includes(`language-${ACTIONS_LANG}`)) return <ActionsBlock text={text} />;
      return <CopyBlock text={text}>{children}</CopyBlock>;
    },
    li: ({ node, children, className, ...props }) => {
      if (!className?.split(/\s+/).includes("task-list-item")) {
        return (
          <li className={className} {...props}>
            {children}
          </li>
        );
      }
      // remark-gfm が先頭に置く無効なチェックボックスを外し、押せるものに置き換える
      const kids = (Array.isArray(children) ? children : [children]).filter(
        (c) => !(isValidElement(c) && (c.props as { type?: string }).type === "checkbox"),
      );
      // 項目の識別は「何行目か」（同じ文言の項目が並んでも区別できる）
      const line = node?.position?.start.line ?? 0;
      return (
        <CheckItem storeKey={storeKey} itemKey={String(line)}>
          {kids}
        </CheckItem>
      );
    },
  };
}
