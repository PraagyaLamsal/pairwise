"""Compose a recorded demo (see record-demos.mjs) into a GIF.

usage: compose-demo.py <recording dir> <out.gif> <fps> <width>

The recording holds one capture of the screen under the overlay (bg.png), the overlay's own
frames as it painted them (o<i>.png, transparent, with their times) and where the student's
pointer was (it isn't in either capture, so it is drawn in here).
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw

src, out, fps, width = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
meta = json.load(open(os.path.join(src, 'index.json')))
bg = Image.open(os.path.join(src, 'bg.png')).convert('RGBA')
frames = meta['frames']
pointer = meta.get('pointer', [])

# The macOS arrow, tip at (0, 0): black with a white edge.
ARROW = [(0, 0), (0, 17), (4, 13), (7, 20), (10, 19), (7, 12), (12, 12)]


def draw_pointer(img, x, y):
    d = ImageDraw.Draw(img)
    pts = [(x + px, y + py) for px, py in ARROW]
    d.polygon(pts, fill=(255, 255, 255, 255))
    inner = [(x + px * 0.82 + 1.1, y + py * 0.82 + 2.0) for px, py in ARROW]
    d.polygon(inner, fill=(10, 10, 10, 255))


tmp = os.path.join(src, 'frames')
os.makedirs(tmp, exist_ok=True)
step = 1000 / fps
n = int(meta['duration'] / step) + 1
cache = {}
fi = -1
for k in range(n):
    t = k * step
    while fi + 1 < len(frames) and frames[fi + 1]['t'] <= t:
        fi += 1
    img = bg.copy()
    if fi >= 0:
        f = frames[fi]['file']
        if f not in cache:
            cache.clear()
            cache[f] = Image.open(os.path.join(src, f)).convert('RGBA').resize(bg.size)
        img.alpha_composite(cache[f])
    p = None
    for s in pointer:
        if s['t'] <= t:
            p = s
        else:
            break
    if p is not None:
        draw_pointer(img, p['x'], p['y'])
    img.convert('RGB').save(os.path.join(tmp, f'f{k:05d}.png'))

palette = f'fps={fps},scale={width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle'
r = subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', os.path.join(tmp, 'f%05d.png'), '-vf', palette, '-loop', '0', out])
sys.exit(r.returncode)
