"""Generate extension icons from icons/icon-source.png."""
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "icons"
SOURCE = OUT / "icon-source.png"
SIZES = (16, 32, 48, 128)


def knockout_corner_background(image: Image.Image, threshold: int = 245) -> Image.Image:
    img = image.convert("RGBA")
    pixels = img.load()
    width, height = img.size

    def is_bg(x: int, y: int) -> bool:
        red, green, blue, alpha = pixels[x, y]
        return alpha > 0 and red >= threshold and green >= threshold and blue >= threshold

    queue = deque()
    visited = set()
    for start in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)):
        if is_bg(*start):
            queue.append(start)
    while queue:
        x, y = queue.popleft()
        if (x, y) in visited or x < 0 or y < 0 or x >= width or y >= height:
            continue
        visited.add((x, y))
        if not is_bg(x, y):
            continue
        pixels[x, y] = (255, 255, 255, 0)
        queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return img


def crop_opaque(image: Image.Image, alpha_min: int = 16) -> Image.Image:
    alpha = image.getchannel("A")
    bbox = alpha.point(lambda value: 255 if value >= alpha_min else 0).getbbox()
    if not bbox:
        return image
    cropped = image.crop(bbox)
    width, height = cropped.size
    size = max(width, height)
    square = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    square.paste(cropped, ((size - width) // 2, (size - height) // 2), cropped)
    return square


def resize_icon(source: Image.Image, size: int) -> Image.Image:
    if size <= 32:
        large = source.resize((size * 4, size * 4), Image.Resampling.LANCZOS)
        large = large.filter(ImageFilter.UnsharpMask(radius=1, percent=120, threshold=2))
        return large.resize((size, size), Image.Resampling.LANCZOS)
    return source.resize((size, size), Image.Resampling.LANCZOS)


def flatten_white_glyphs(image: Image.Image) -> Image.Image:
    """Turn glossy pink-white glyph fills into solid white."""
    img = image.convert("RGBA")
    pixels = img.load()
    width, height = img.size
    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            if alpha < 16:
                continue
            brightest = max(red, green, blue)
            spread = brightest - min(red, green, blue)
            if brightest >= 198 and spread <= 96:
                pixels[x, y] = (255, 255, 255, alpha)
    return img


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit("Missing " + str(SOURCE))
    OUT.mkdir(parents=True, exist_ok=True)
    flat = flatten_white_glyphs(Image.open(SOURCE))
    flat.save(SOURCE, "PNG", optimize=True)
    source = crop_opaque(knockout_corner_background(flat))
    for size in SIZES:
        icon = resize_icon(source, size)
        path = OUT / ("icon%d.png" % size)
        icon.save(path, "PNG", optimize=True)
        print("OK", path.name)


if __name__ == "__main__":
    main()
