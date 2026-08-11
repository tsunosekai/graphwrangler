// 外観（2026-08-08 本人要望）。同じコードで会社と個人の2インスタンスが動くので、
// 見た目の差はコードではなくここに置く。既定は "GraphWrangler" + 同梱アイコン＝
// 何も触らないインスタンスは今までどおり。
// サイト名は下の「保存」で他の設定と一緒に送る。画像は multipart なので即時反映の別口
import type { RefObject } from "react";
import { DEFAULT_SITE_TITLE } from "../../lib/branding";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { desc, field, heading, section } from "./styles";

interface Props {
  siteTitle: string;
  setSiteTitle: (v: string) => void;
  /** アップロードで +1 / 既定に戻すと 0。0 は同梱の既定アイコン */
  faviconVersion: number;
  faviconBusy: boolean;
  faviconInputRef: RefObject<HTMLInputElement>;
  uploadFavicon: (file: File) => void;
  resetFavicon: () => void;
}

export function BrandingSection({
  siteTitle,
  setSiteTitle,
  faviconVersion,
  faviconBusy,
  faviconInputRef,
  uploadFavicon,
  resetFavicon,
}: Props) {
  return (
    <section className={section}>
      <h3 className={heading}>外観（インスタンス全体）</h3>
      <label className={field}>
        <span>サイト名</span>
        <Input
          value={siteTitle}
          onChange={(e) => setSiteTitle(e.target.value)}
          maxLength={60}
          placeholder={DEFAULT_SITE_TITLE}
        />
      </label>
      <p className={desc}>
        ブラウザのタブ・ヘッダー・ログイン画面に出る名前（下の「保存」で反映）。空欄なら
        {DEFAULT_SITE_TITLE} に戻ります
      </p>
      <label className={field}>
        <span>ファビコン</span>
        <span className="flex flex-wrap items-center gap-2">
          <img
            src={`/favicon.png?v=${faviconVersion}`}
            alt=""
            className="size-8 rounded border border-border bg-background object-contain p-0.5"
          />
          <span className="text-sm text-foreground">
            {faviconVersion > 0 ? "この画像を配信中" : "同梱の既定"}
          </span>
          <input
            ref={faviconInputRef}
            type="file"
            accept="image/png,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadFavicon(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={faviconBusy}
            onClick={() => faviconInputRef.current?.click()}
          >
            画像を選ぶ
          </Button>
          {faviconVersion > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={faviconBusy}
              onClick={() => void resetFavicon()}
            >
              既定に戻す
            </Button>
          )}
        </span>
      </label>
      <p className={desc}>
        PNG または SVG（512KB まで）。選んだ時点で保存され、タブのアイコンがその場で
        差し替わります（他の人のブラウザは開き直すか強制リロードで切り替わります）
      </p>
    </section>
  );
}
