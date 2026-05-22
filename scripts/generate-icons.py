"""Regenerate src-tauri/icons from logo01.ico in the project root."""
from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parent.parent
icons = root / "src-tauri" / "icons"
src = Image.open(root / "logo01.ico").convert("RGBA")


def square(img: Image.Image, size: int) -> Image.Image:
    s = max(img.size)
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.paste(img, ((s - img.width) // 2, (s - img.height) // 2), img)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [square(src, s) for s in sizes]
imgs[0].save(
    icons / "icon.ico",
    format="ICO",
    sizes=[(s, s) for s in sizes],
    append_images=imgs[1:],
)
for s, name in ((32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")):
    square(src, s).save(icons / name)
square(src, 512).save(icons / "icon.png")
print("Icons updated from logo01.ico")
