#!/usr/bin/env python3
"""Renders the six demo frame "photos" used by the public demo.

They are original, computer-generated pictures (no real brand, no real
product, no third-party image): each frame is described in millimetres,
drawn with a rounded 3D profile and studio-like light on a plain backdrop,
with a soft contact shadow, and saved as an ordinary photo. The demo assets
are then produced from these photos by the site's REAL frame-extraction
pipeline (scripts/build-demo.mjs), exactly as a shop's phone photo would be.

    python3 scripts/render-demo-photos.py      # writes demo/src/*.png
    node scripts/build-demo.mjs                # cut-outs, fitting data, catalogue

Needs Python 3 with numpy, scipy and Pillow.
"""
import math
import os
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

W, H = 1000, 500          # the site's working size for frame photos
SS = 3                    # supersampling for clean edges
K = 6.0                   # px per mm in the output photo
OUT = os.path.join(os.path.dirname(__file__), '..', 'demo', 'src')

RNG = np.random.default_rng(20261012)


def mm(v):
    return v * K * SS


# ---------- lens outlines (millimetres, lens centre at 0,0, nasal side +x) ----------

def lens_outline(a, b, n=4.0, top_wider=0.0, nasal_drop=0.0, cat_lift=0.0, N=1440):
    t = np.linspace(0, 2 * math.pi, N, endpoint=False)
    c, s = np.cos(t), np.sin(t)
    x = (a / 2) * np.sign(c) * np.abs(c) ** (2 / n)
    y = (b / 2) * np.sign(s) * np.abs(s) ** (2 / n)
    yn = y / (b / 2)                      # -1 top, +1 bottom
    x = x * (1 + top_wider * (-yn) * 0.5)
    nasal = x > 0
    x = np.where(nasal & (yn > 0), x * (1 - nasal_drop * yn ** 2), x)
    if cat_lift:
        outer = np.clip(-x / (a / 2), 0, 1)
        top = np.clip(-yn, 0, 1)
        y = y - cat_lift * (outer ** 2.0) * (top ** 0.6)
    return np.stack([x, y], 1)


def place(outline, cx, cy, mirror=False):
    p = outline.copy()
    if mirror:
        p[:, 0] = -p[:, 0]
    p[:, 0] += cx
    p[:, 1] += cy
    return p


def raster(polys, size):
    im = Image.new('L', size, 0)
    d = ImageDraw.Draw(im)
    for poly in polys:
        d.polygon([tuple(q) for q in poly], fill=255)
    return np.asarray(im) > 127


def to_px(poly_mm, origin):
    return np.stack([origin[0] + mm(poly_mm[:, 0]), origin[1] + mm(poly_mm[:, 1])], 1)


def rounded_rect(x0, y0, x1, y1, r, N=24):
    pts = []
    for (cx, cy, a0) in [(x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)]:
        for k in range(N + 1):
            a = math.radians(a0 + 90 * k / N)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return np.array(pts)


def arch_band(x0, x1, ytop_mid, ytop_end, th_mid, th_end, N=120):
    xs = np.linspace(x0, x1, N)
    u = (xs - (x0 + x1) / 2) / ((x1 - x0) / 2)        # -1..1
    w = u ** 2
    top = ytop_mid + (ytop_end - ytop_mid) * w
    th = th_mid + (th_end - th_mid) * w
    upper = np.stack([xs, top], 1)
    lower = np.stack([xs[::-1], (top + th)[::-1]], 1)
    return np.concatenate([upper, lower])


# ---------- shading ----------

LIGHT = np.array([-0.35, -0.65, 0.68])
LIGHT = LIGHT / np.linalg.norm(LIGHT)
HALF = LIGHT + np.array([0, 0, 1.0])
HALF = HALF / np.linalg.norm(HALF)


def normals(mask, radius_px):
    d = ndimage.distance_transform_edt(mask)
    u = np.clip(d / max(radius_px, 1), 0, 1)
    hgt = np.sqrt(np.clip(1 - (1 - u) ** 2, 0, 1)) * radius_px
    hgt = ndimage.gaussian_filter(hgt, 2.0)
    gy, gx = np.gradient(hgt)
    n = np.stack([-gx, -gy, np.ones_like(gx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n


def shade_plastic(n, albedo, ks=0.55, shine=70, amb=0.42):
    ndl = np.clip((n * LIGHT).sum(-1), 0, 1)
    ndh = np.clip((n * HALF).sum(-1), 0, 1)
    spec = ks * ndh ** shine
    rim_light = 0.10 * np.clip(-n[..., 1], 0, 1)          # a little sky light on upper faces
    col = albedo * (amb + 0.62 * ndl[..., None] + rim_light[..., None]) + 255 * spec[..., None]
    return col


def shade_metal(n, tint, ks=0.22, shine=120):
    # reflected view ray; the "room" is bright above, dark below
    r_y = 2 * n[..., 2] * n[..., 1]
    env = 0.30 + 0.62 * np.clip(0.5 - 0.9 * r_y, 0, 1) ** 1.6
    band = 0.16 * np.exp(-((r_y + 0.35) / 0.12) ** 2)        # a soft-box reflection
    ndh = np.clip((n * HALF).sum(-1), 0, 1)
    spec = ks * ndh ** shine
    col = tint * (env + band)[..., None] + 255 * spec[..., None]
    return col


def noise_field(shape, scales, rng):
    out = np.zeros(shape, np.float32)
    for s, wgt in scales:
        gh, gw = max(2, shape[0] // s), max(2, shape[1] // s)
        g = rng.random((gh, gw)).astype(np.float32)
        im = Image.fromarray((g * 255).astype(np.uint8)).resize((shape[1], shape[0]), Image.BICUBIC)
        out += wgt * (np.asarray(im, np.float32) / 255)
    return out / sum(w for _, w in scales)


def tortoise_albedo(shape, rng):
    f = noise_field(shape, [(150, 0.5), (60, 0.3), (24, 0.2)], rng)
    f2 = noise_field(shape, [(48, 0.6), (18, 0.4)], rng)
    honey = np.array([186, 116, 48], np.float32)
    amber = np.array([128, 66, 24], np.float32)
    dark = np.array([42, 22, 12], np.float32)
    t1 = np.clip((f - 0.42) / 0.16, 0, 1)[..., None]
    t2 = np.clip((f2 - 0.55) / 0.12, 0, 1)[..., None]
    col = honey * (1 - t1) + amber * t1
    col = col * (1 - t2 * 0.85) + dark * (t2 * 0.85)
    alpha = 0.86 + 0.14 * np.clip(t1[..., 0] + t2[..., 0], 0, 1)
    return col, alpha


# ---------- one frame ----------

def render(spec):
    WS, HS = W * SS, H * SS
    origin = (WS / 2, HS * 0.47)
    a, b, br = spec['eye'], spec['height'], spec['bridge']
    outline = lens_outline(a, b, spec.get('n', 4), spec.get('top_wider', 0), spec.get('nasal_drop', 0), spec.get('cat_lift', 0))
    lx, rx = -(br / 2 + a / 2), (br / 2 + a / 2)
    left = to_px(place(outline, lx, 0), origin)
    right = to_px(place(outline, rx, 0, mirror=True), origin)
    lens = raster([left, right], (WS, HS))
    yy = np.arange(HS)[:, None].astype(np.float32)
    xx = np.arange(WS)[None, :].astype(np.float32)
    lens_top = origin[1] - mm(b / 2)

    kind = spec['kind']
    d_out = ndimage.distance_transform_edt(~lens)
    acetate = np.zeros((HS, WS), bool)
    metal = np.zeros((HS, WS), bool)
    soft = np.zeros((HS, WS), np.float32)   # faint parts (nylon line), alpha 0..1

    vpos = np.clip((yy - origin[1]) / mm(b / 2), -1.3, 1.3)            # -1 top .. +1 bottom
    outer_x = np.clip((np.abs(xx - origin[0]) - mm(br / 2 + a * 0.55)) / mm(a * 0.45), 0, 1)

    if kind in ('acetate', 'crystal', 'tortoise'):
        t_top, t_bot = spec['t_top'], spec['t_bot']
        th = t_bot + (t_top - t_bot) * np.clip(0.5 - 0.5 * vpos, 0, 1) ** 1.3
        th = th + spec.get('t_corner', 0) * outer_x * np.clip(-vpos, 0, 1)
        rim = (~lens) & (d_out <= mm(1) * th)
        acetate |= rim
        bx0, bx1 = -(br / 2 + 4), (br / 2 + 4)
        band = arch_band(bx0, bx1, -b * 0.36 - spec.get('bridge_lift', 1.4), -b * 0.36, spec.get('bridge_th', 4.2), spec.get('bridge_th', 4.2) + 2.2)
        acetate |= raster([to_px(band, origin)], (WS, HS)) & ~lens
        # end pieces (the hinge block seen from the front)
        for side in (-1, 1):
            xo = side * (br / 2 + a) + side * (t_top * 0.4)
            x0, x1 = (xo - 1.5, xo + 6.0) if side > 0 else (xo - 6.0, xo + 1.5)
            yt = -b * 0.47 - spec.get('cat_lift', 0) * 0.55
            acetate |= raster([to_px(rounded_rect(x0, yt, x1, yt + 6.2, 1.6), origin)], (WS, HS))
    elif kind == 'metal':
        tm = spec['t_metal']
        rim = (~lens) & (d_out <= mm(tm))
        metal |= rim
        by = -b * spec.get('bridge_y', 0.30)
        near = outline[np.abs(outline[:, 1] - by) < 0.6]
        reach = (lx + near[:, 0].max()) if len(near) else -(br / 2)
        bx0, bx1 = min(-(br / 2 + 1.5), reach - tm * 1.4), max(br / 2 + 1.5, -(reach - tm * 1.4))
        band = arch_band(bx0, bx1, by - spec.get('bridge_lift', 0.5), by, 1.35, 1.45)
        metal |= raster([to_px(band, origin)], (WS, HS))
        if spec.get('double_bridge'):
            band2 = arch_band(bx0, bx1, -b * 0.48 - 0.8, -b * 0.47, 1.0, 1.1)
            metal |= raster([to_px(band2, origin)], (WS, HS))
        for side in (-1, 1):
            xo = side * (br / 2 + a + tm * 0.5)
            x0, x1 = (xo - 1.0, xo + 4.2) if side > 0 else (xo - 4.2, xo + 1.0)
            yt = -b * 0.32 if spec.get('round') else -b * 0.44
            metal |= raster([to_px(rounded_rect(x0, yt, x1, yt + 3.4, 1.0), origin)], (WS, HS))
    elif kind == 'browline':
        t_top = spec['t_top']
        th = t_top * np.clip(0.15 - 0.95 * vpos, 0, 1) ** 0.75
        brow = (~lens) & (d_out <= mm(1) * th) & (vpos < 0.2)
        acetate |= brow
        tm = 0.9
        bx0, bx1 = -(br / 2 + 2.0), (br / 2 + 2.0)
        metal |= raster([to_px(arch_band(bx0, bx1, -b * 0.30 - 2.2, -b * 0.27, 1.3, 1.4), origin)], (WS, HS))
        # lower lens edge: the nylon thread and the lens bevel, faint
        ring = (~lens) & (d_out <= mm(0.45)) & (vpos > -0.25)
        soft[ring] = 0.62
        inner = lens & (ndimage.distance_transform_edt(lens) <= mm(0.7)) & (vpos > -0.25)
        soft[inner] = np.maximum(soft[inner], 0.22)
        for side in (-1, 1):
            xo = side * (br / 2 + a) + side * 1.2
            x0, x1 = (xo - 1.5, xo + 5.5) if side > 0 else (xo - 5.5, xo + 1.5)
            yt = -b * 0.47
            acetate |= raster([to_px(rounded_rect(x0, yt, x1, yt + 5.6, 1.5), origin)], (WS, HS))

    # nose pads (clear silicone on thin arms), for metal frames
    pads = np.zeros((HS, WS), bool)
    arms = np.zeros((HS, WS), bool)
    if spec.get('pads'):
        for side in (-1, 1):
            pcx = side * (br / 2 + 4.8)
            pcy = b * 0.20
            t = np.linspace(0, 2 * math.pi, 120)
            pad = np.stack([pcx + 2.1 * np.cos(t), pcy + 4.2 * np.sin(t)], 1)
            pads |= raster([to_px(pad, origin)], (WS, HS))
            arm = np.array([[side * (br / 2 + 0.2), -b * 0.20], [side * (br / 2 + 2.4), pcy - 2.0], [side * (br / 2 + 2.9), pcy - 2.0], [side * (br / 2 + 0.7), -b * 0.20]])
            if spec.get('pad_arms'):
                arms |= raster([to_px(arm, origin)], (WS, HS))
        metal |= arms

    # ---------- colour ----------
    base = np.array(spec.get('bg', (224, 222, 217)), np.float32)
    grad = (1.0 + 0.035 * (0.5 - yy / HS))
    vign = 1.0 - 0.06 * (((xx - WS / 2) / (WS / 2)) ** 2 + ((yy - HS / 2) / (HS / 2)) ** 2)
    bg = base[None, None, :] * (grad * vign)[..., None]

    solid = acetate | metal | pads
    alpha_shadow = ndimage.gaussian_filter(np.roll(np.roll(solid.astype(np.float32), int(mm(1.0)), 1), int(mm(3.0)), 0), mm(3.5))
    bg *= (1 - 0.06 * np.clip(alpha_shadow * 1.6, 0, 1))[..., None]

    img = bg.copy()
    # lens glass: almost invisible, a faint lift and one soft reflection
    diag = ((xx - origin[0]) * 0.55 + (yy - origin[1]) * 0.85)
    streak = np.exp(-((diag - mm(-6)) / mm(5)) ** 2) * 0.05 + np.exp(-((diag - mm(-14)) / mm(1.4)) ** 2) * 0.035
    away = np.clip((np.abs(xx - origin[0]) - mm(br / 2 + a * 0.25)) / mm(6), 0, 1)
    streak = streak * away
    glass = lens.astype(np.float32)[..., None]
    img = img * (1 - glass * 0.012) + glass * (3.0 + 255 * streak[..., None])

    if acetate.any():
        n = normals(acetate, mm(spec.get('bevel', 1.6)))
        if kind == 'tortoise':
            alb, alpha = tortoise_albedo((HS, WS), RNG)
        else:
            alb = np.broadcast_to(np.array(spec['colour'], np.float32), (HS, WS, 3))
            alpha = np.ones((HS, WS), np.float32)
        col = shade_plastic(n, alb, ks=spec.get('ks', 0.55), shine=spec.get('shine', 70))
        if kind == 'crystal':
            edge = (1 - n[..., 2]) ** 0.9
            alpha = 0.24 + 0.72 * edge ** 0.75
            spec_only = 255 * 0.7 * np.clip((n * HALF).sum(-1), 0, 1) ** 90
            tint = np.array(spec['colour'], np.float32)
            col = tint * (0.80 + 0.30 * np.clip((n * LIGHT).sum(-1), 0, 1))[..., None] * (1 - 0.55 * edge[..., None]) + spec_only[..., None]
            alpha = np.clip(alpha + spec_only / 255 * 0.6, 0, 1)
        m = acetate.astype(np.float32) * alpha
        img = img * (1 - m[..., None]) + np.clip(col, 0, 255) * m[..., None]

    if metal.any():
        n = normals(metal, mm(spec.get('wire_r', 0.7)))
        col = shade_metal(n, np.array(spec.get('metal_colour', spec.get('colour')), np.float32))
        m = metal.astype(np.float32)
        img = img * (1 - m[..., None]) + np.clip(col, 0, 255) * m[..., None]

    if pads.any():
        n = normals(pads, mm(1.6))
        spec_p = 255 * 0.7 * np.clip((n * HALF).sum(-1), 0, 1) ** 60
        a_p = (0.30 + 0.4 * (1 - n[..., 2])) * pads
        col = np.array([235, 236, 232], np.float32) + spec_p[..., None]
        img = img * (1 - a_p[..., None]) + np.clip(col, 0, 255) * a_p[..., None]

    if soft.any():
        col = np.array(spec.get('thread', (118, 122, 128)), np.float32)
        img = img * (1 - soft[..., None]) + col * soft[..., None]

    img = np.clip(img, 0, 255).astype(np.uint8)
    small = Image.fromarray(img).resize((W, H), Image.BOX)
    arr = np.asarray(small).astype(np.float32)
    arr += RNG.normal(0, 1.1, arr.shape)                       # a touch of sensor noise
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


FRAMES = [
    dict(id='demo-black-rectangle', kind='acetate', colour=(26, 26, 29), eye=53, height=33, bridge=18,
         n=5.2, top_wider=0.10, nasal_drop=0.18, t_top=4.2, t_bot=3.1, t_corner=1.0, bevel=0.75, ks=0.5, shine=90),
    dict(id='demo-silver-rectangle', kind='metal', metal_colour=(150, 156, 166), eye=54, height=31, bridge=17,
         n=6.0, top_wider=0.06, nasal_drop=0.12, t_metal=1.25, wire_r=0.7, pads=True),
    dict(id='demo-gold-round', kind='metal', metal_colour=(206, 160, 70), eye=47, height=47, bridge=21,
         n=2.0, t_metal=1.3, wire_r=0.72, pads=True, round=True, bridge_lift=0.6, bridge_y=0.36),
    dict(id='demo-crystal-square', kind='crystal', colour=(58, 98, 150), eye=52, height=40, bridge=19,
         n=3.3, top_wider=0.06, nasal_drop=0.10, t_top=4.6, t_bot=3.6, t_corner=0.8, bevel=1.0, bridge_th=4.6),
    dict(id='demo-tortoise-catseye', kind='tortoise', eye=54, height=37, bridge=17,
         n=3.6, top_wider=0.10, nasal_drop=0.14, cat_lift=4.0, t_top=4.6, t_bot=3.0, t_corner=2.6, bevel=0.85, ks=0.45, shine=70),
    dict(id='demo-black-browline', kind='browline', colour=(24, 24, 26), metal_colour=(190, 194, 200), eye=51, height=38, bridge=21,
         n=3.8, top_wider=0.08, nasal_drop=0.10, t_top=5.6, bevel=0.85, ks=0.5, shine=90),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    for spec in FRAMES:
        im = render(spec)
        path = os.path.join(OUT, spec['id'] + '.png')
        im.save(path, optimize=True)
        print('wrote', os.path.relpath(path), os.path.getsize(path) // 1024, 'KB')


if __name__ == '__main__':
    main()
