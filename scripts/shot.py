#!/usr/bin/env python3
"""Composite a full Drift window screenshot from `drift raw debug.capture` layers.

usage: drift raw debug.capture | python3 scripts/shot.py out.png [wallpaper.png]
"""
import base64, io, json, sys
from PIL import Image, ImageDraw

data = json.load(sys.stdin)
data = data.get('result', data)
W, H = data['width'], data['height']
wall = Image.open(sys.argv[2]).convert('RGBA').resize((W, H)) if len(sys.argv) > 2 else Image.new('RGBA', (W, H), (40, 30, 30, 255))
img = lambda b: Image.open(io.BytesIO(base64.b64decode(b))).convert('RGBA')
ui = img(data['ui']).resize((W, H))


def paste_panes(canvas):
    for p in data['panes']:
        r = p['rect']
        pane = img(p['png']).resize((r['width'], r['height']))
        mask = Image.new('L', pane.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, pane.size[0] - 1, pane.size[1] - 1], 10, fill=255)
        canvas.paste(pane, (r['x'], r['y']), mask)


out = wall.copy()
if data.get('overlayOnTop'):
    paste_panes(out)
    out = Image.alpha_composite(out, ui)
else:
    out = Image.alpha_composite(out, ui)
    paste_panes(out)
if data.get('popup'):
    p = data['popup']
    r = p['rect']
    out.paste(img(p['png']).resize((r['width'], r['height'])), (r['x'], r['y']))
out.convert('RGB').save(sys.argv[1])
print(sys.argv[1])
