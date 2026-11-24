"""デスクトップ版のアプリアイコンを作る（要 Pillow。作り直すときだけ実行する）。

  python apps/desktop/scripts/make-icon.py

UI のアイコン（apps/ui/public/icon.png。白地に灰色のノード2つ）は、タスクバーやトレイでは
白い四角に見えて埋もれる。同じ図柄を、角丸の濃い地に白で抜いたものへ起こし直す。
出力は apps/desktop/assets/:
  icon.png  … ウィンドウ用（256px）
  icon.ico  … ショートカット・タスクバー用（16〜256px の複数サイズ入り）
  tray.png  … トレイ用（32px。16px 表示でも潰れないよう図柄を少し大きくする）
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "apps" / "ui" / "public" / "icon.png"
OUT = ROOT / "apps" / "desktop" / "assets"
TILE = (22, 24, 29, 255)  # UI のダーク背景に合わせた地の色
GLYPH = (245, 246, 248, 255)
SIZE = 1024  # この大きさで描いてから縮める（縁をなめらかにする）


def glyph_mask() -> Image.Image:
    """元画像の暗い部分（図柄）を白、地を黒にしたマスク。余白は切り落とす"""
    gray = Image.open(SRC).convert("L")
    mask = ImageChops.invert(gray).point(lambda v: 0 if v < 24 else min(255, int(v * 1.6)))
    return mask.crop(mask.getbbox())


def render(glyph_ratio: float) -> Image.Image:
    """角丸の地に図柄を載せる。glyph_ratio = 図柄の長辺が地に占める割合"""
    tile = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=int(SIZE * 0.22), fill=TILE)
    mask = glyph_mask()
    scale = SIZE * glyph_ratio / max(mask.size)
    mask = mask.resize((round(mask.width * scale), round(mask.height * scale)), Image.LANCZOS)
    pos = ((SIZE - mask.width) // 2, (SIZE - mask.height) // 2)
    tile.paste(Image.new("RGBA", mask.size, GLYPH), pos, mask)
    return tile


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    app = render(0.62)
    app.resize((256, 256), Image.LANCZOS).save(OUT / "icon.png")
    app.save(OUT / "icon.ico", sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
    render(0.74).resize((32, 32), Image.LANCZOS).save(OUT / "tray.png")
    print("wrote", ", ".join(p.name for p in sorted(OUT.iterdir())))


if __name__ == "__main__":
    main()
