"""Draws HapsHub's logo. In-app it's a white mask the page tints to the theme; the .ico gets its own colours."""
import math, os, sys
from PIL import Image, ImageDraw

ROOT = sys.argv[1] if len(sys.argv) > 1 else 'D:/VR/VRHub'
SS = 4


def hex_points(size, radius_scale=0.96):
    c = size / 2
    r = size / 2 * radius_scale
    return [(c + r * math.cos(math.radians(60 * i - 90)), c + r * math.sin(math.radians(60 * i - 90))) for i in range(6)]


def rounded_polygon_mask(size, points, corner):
    """A filled polygon whose corners are rounded by growing a smaller one with round joins."""
    img = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(img)
    c = size / 2
    inner = [(c + (x - c) * (1 - corner / (size / 2)), c + (y - c) * (1 - corner / (size / 2))) for x, y in points]
    d.polygon(inner, fill=255)
    for i in range(6):
        d.line([inner[i], inner[(i + 1) % 6]], fill=255, width=int(corner * 2))
        x, y = inner[i]
        d.ellipse([x - corner, y - corner, x + corner, y + corner], fill=255)
    return img


def h_mask(size):
    """An H whose bar is a hub: a round node where the two uprights connect."""
    img = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(img)
    s = size / 512
    stroke = 62 * s
    top, bottom = 142 * s, 370 * s
    left, right = 172 * s, 340 * s
    for x in (left, right):
        d.rounded_rectangle([x - stroke / 2, top, x + stroke / 2, bottom], radius=stroke / 2, fill=255)
    mid = (top + bottom) / 2
    d.rectangle([left, mid - stroke * 0.36, right, mid + stroke * 0.36], fill=255)
    node = 50 * s
    d.ellipse([256 * s - node, mid - node, 256 * s + node, mid + node], fill=255)
    return img


def mark(size, fill, hole):
    big = size * SS
    shape = rounded_polygon_mask(big, hex_points(big), big * 0.085)
    letter = h_mask(big)
    out = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    if isinstance(fill, tuple):
        out.paste(Image.new('RGBA', (big, big), fill), (0, 0), shape)
    else:
        out.paste(fill(big), (0, 0), shape)
    if hole is None:
        out.putalpha(Image.composite(Image.new('L', (big, big), 0), out.getchannel('A'), letter))
    else:
        out.paste(Image.new('RGBA', (big, big), hole), (0, 0), letter)
    return out.resize((size, size), Image.LANCZOS)


def gradient(big):
    top, bottom = (124, 92, 255), (34, 190, 214)
    img = Image.new('RGBA', (big, big))
    px = img.load()
    for y in range(big):
        for x in range(big):
            t = (x + y) / (2 * big)
            px[x, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
    return img


mask = mark(512, (255, 255, 255, 255), None)
mask.save(os.path.join(ROOT, 'frontend', 'logo.png'))

sizes = [16, 32, 48, 64, 128, 256]
frames = [mark(s, gradient, (255, 255, 255, 255)) for s in sizes]
frames[-1].save(os.path.join(ROOT, 'logo.ico'), format='ICO', sizes=[(s, s) for s in sizes], append_images=frames[:-1])

preview = Image.new('RGB', (760, 300), (24, 26, 34))
x = 16
tinted = Image.new('RGBA', mask.size, (255, 255, 255, 255))
tinted.putalpha(mask.getchannel('A'))
i = tinted.resize((256, 256), Image.LANCZOS)
preview.paste(i, (x, 20), i)
x += 272
j = frames[-1]
preview.paste(j, (x, 20), j)
x += 272
for frame in frames[:4]:
    preview.paste(frame, (x, 30), frame)
    x += frame.size[0] + 10
if len(sys.argv) > 2:
    preview.save(sys.argv[2])
