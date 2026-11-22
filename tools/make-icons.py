"""Generates the app icons in assets/: a folded-newspaper mark on the app's red.

    python tools/make-icons.py
"""
from PIL import Image, ImageDraw

RED = (168, 32, 26, 255)
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)


def mark(size: int, scale: float, fg, cut) -> Image.Image:
    """A page with a headline bar, a picture block and text lines. `cut` is the colour of the details."""
    s = 4  # supersample
    n = size * s
    im = Image.new('RGBA', (n, n), CLEAR)
    d = ImageDraw.Draw(im)
    w = n * scale
    h = w * 1.18
    x0 = (n - w) / 2
    y0 = (n - h) / 2
    r = w * 0.09
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=r, fill=fg)
    pad = w * 0.13
    # headline bar
    d.rounded_rectangle([x0 + pad, y0 + pad, x0 + w - pad, y0 + pad + h * 0.13], radius=w * 0.025, fill=cut)
    # picture block
    top = y0 + pad + h * 0.21
    d.rounded_rectangle([x0 + pad, top, x0 + w * 0.5, top + h * 0.3], radius=w * 0.025, fill=cut)
    # text lines beside the picture
    lh = h * 0.045
    for i in range(3):
        y = top + i * (h * 0.105)
        d.rounded_rectangle([x0 + w * 0.57, y, x0 + w - pad, y + lh], radius=lh / 2, fill=cut)
    # full-width lines below
    for i in range(3):
        y = top + h * 0.38 + i * (h * 0.105)
        right = x0 + w - pad if i < 2 else x0 + w * 0.62
        d.rounded_rectangle([x0 + pad, y, right, y + lh], radius=lh / 2, fill=cut)
    return im.resize((size, size), Image.LANCZOS)


def save(name: str, im: Image.Image) -> None:
    im.save(f'assets/{name}')
    print(name, im.size)


if __name__ == '__main__':
    # Store / iOS icon: no transparency.
    icon = Image.new('RGBA', (1024, 1024), RED)
    icon.alpha_composite(mark(1024, 0.46, WHITE, RED))
    save('icon.png', icon.convert('RGB'))

    # Android adaptive icon: the foreground keeps to the central safe zone; the background is a flat colour.
    save('android-icon-foreground.png', mark(512, 0.34, WHITE, RED))
    save('android-icon-background.png', Image.new('RGBA', (512, 512), RED))
    save('android-icon-monochrome.png', mark(432, 0.34, WHITE, CLEAR))

    # Splash mark, shown on the light or dark splash background.
    save('splash-icon.png', mark(1024, 0.5, RED, WHITE))
    save('favicon.png', icon.resize((48, 48), Image.LANCZOS))
