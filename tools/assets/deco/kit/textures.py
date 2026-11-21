"""Texture bake for the building kit.

Procedural textures are drawn with numpy (fixed seeds, so the output is
deterministic) and source-derived ones come from the CC0 sets in assets-src/.
Everything is encoded to WebP with ImageMagick into public/assets/buildings/
textures/. ORM textures follow glTF packing: R occlusion, G roughness,
B metalness. Every texture tiles unless it is an atlas.
"""
import math
import subprocess

import numpy as np

from .config import SRC, STAGE, TEX_OUT, hex_srgb, AWNING_STRIPE_PERIOD

RAW = STAGE / "tex"
CREDITS = []  # (texture, source asset) pairs for credits.json


# ---------------------------------------------------------------------------
# IO
# ---------------------------------------------------------------------------
def _run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def load_src(rel, size):
    """Load a source image from assets-src as float32 RGB [0,1], resized with
    tiling-aware filtering."""
    RAW.mkdir(parents=True, exist_ok=True)
    out = RAW / (rel.replace("/", "_") + f"_{size}.rgb")
    if not out.exists():
        _run(["magick", str(SRC / rel), "-colorspace", "sRGB", "-virtual-pixel", "tile", "-filter", "Lanczos",
              "-distort", "Resize", f"{size}x{size}!", "-depth", "8", f"rgb:{out}"])
    a = np.fromfile(out, dtype=np.uint8).reshape(size, size, 3)
    return a.astype(np.float32) / 255.0


def save(name, arr, quality=88):
    """arr: float [0,1] HxWx3 (sRGB-encoded values for colour maps)."""
    RAW.mkdir(parents=True, exist_ok=True)
    TEX_OUT.mkdir(parents=True, exist_ok=True)
    a = np.clip(arr * 255.0 + 0.5, 0, 255).astype(np.uint8)
    if a.ndim == 2:
        a = np.stack([a] * 3, -1)
    h, w, _ = a.shape
    raw = RAW / f"{name}.rgb"
    a.tofile(raw)
    _run(["magick", "-size", f"{w}x{h}", "-depth", "8", f"rgb:{raw}", "-strip", "-quality", str(quality),
          "-define", "webp:method=6", str(TEX_OUT / f"{name}.webp")])
    return TEX_OUT / f"{name}.webp"


# ---------------------------------------------------------------------------
# Noise
# ---------------------------------------------------------------------------
def fft_noise(rng, h, w=None, beta=2.0, fmin=0.0, fmax=None):
    """Tileable fractal noise (mean 0, std 1) by spectral filtering."""
    w = w or h
    n = rng.standard_normal((h, w))
    F = np.fft.fft2(n)
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1.0
    filt = f ** (-beta / 2.0)
    if fmin:
        filt *= 1.0 - np.exp(-(f / fmin) ** 2)
    if fmax:
        filt *= np.exp(-(f / fmax) ** 2)
    filt[0, 0] = 0.0
    out = np.real(np.fft.ifft2(F * filt))
    out -= out.mean()
    out /= out.std() + 1e-9
    return out.astype(np.float32)


def normal_from_height(h, strength):
    """Tangent-space OpenGL (+Y up) normal map from a tileable height field.
    Row 0 is the top of the image, so +v (up) is -row."""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, 1, 0) - np.roll(h, -1, 0)) * 0.5
    nx = -dx * strength
    ny = -dy * strength
    nz = np.ones_like(h)
    L = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / L * 0.5 + 0.5, ny / L * 0.5 + 0.5, nz / L * 0.5 + 0.5], -1)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def col(h):
    return np.array(hex_srgb(h), dtype=np.float32)


def orm(occ, rough, metal=0.0):
    shape = rough.shape if hasattr(rough, "shape") else occ.shape
    def full(x):
        return np.broadcast_to(np.asarray(x, dtype=np.float32), shape)
    return np.stack([full(occ), full(rough), full(metal)], -1)


# ---------------------------------------------------------------------------
# Source-derived surfaces
# ---------------------------------------------------------------------------
def bake_stucco(size=1024):
    rng = np.random.default_rng(11)
    d = load_src("polyhaven/textures/painted_plaster_wall/textures/painted_plaster_wall_diff_2k.jpg", size)
    arm = load_src("polyhaven/textures/painted_plaster_wall/textures/painted_plaster_wall_arm_2k.jpg", size)
    nrm = load_src("polyhaven/textures/painted_plaster_wall/textures/painted_plaster_wall_nor_gl_2k.jpg", size)
    L = d.mean(-1)
    L = (L - L.mean()) / (L.std() + 1e-6)
    big = fft_noise(rng, size, beta=3.2)
    albedo = 0.915 + 0.022 * L + 0.012 * big
    albedo = np.stack([albedo * 1.0, albedo * 0.995, albedo * 0.985], -1)  # whisper of warmth
    save("stucco_albedo", albedo, 88)
    # soften the normal map a little: lerp toward flat
    flat = np.array([0.5, 0.5, 1.0], np.float32)
    n = flat + (nrm - flat) * 0.8
    save("stucco_normal", n, 92)
    rough = np.clip(0.80 + (arm[..., 1] - arm[..., 1].mean()) * 0.6 + 0.03 * big, 0.6, 0.97)
    occ = np.clip(1.0 - (1.0 - arm[..., 0]) * 0.7, 0.7, 1.0)
    save("stucco_orm", orm(occ, rough), 90)
    CREDITS.append(("stucco_*", "painted_plaster_wall"))

    # concrete: same plaster base, greyer, with pores and soft staining
    pores = rng.random((size, size)) < 0.004
    pore = np.zeros((size, size), np.float32)
    pore[pores] = 1.0
    pore = np.maximum(pore, np.roll(pore, 1, 0) * 0.5)
    stain = fft_noise(rng, size, beta=3.6)
    c = 0.60 + 0.035 * L + 0.035 * stain - 0.18 * pore
    concrete = np.stack([c * 1.0, c * 0.985, c * 0.955], -1)
    save("concrete_albedo", concrete, 88)
    rough_c = np.clip(0.86 + 0.04 * stain + 0.08 * pore, 0.7, 1.0)
    save("concrete_orm", orm(np.clip(1 - 0.35 * pore, 0, 1), rough_c), 90)
    CREDITS.append(("concrete_*", "painted_plaster_wall"))


# ---------------------------------------------------------------------------
# Procedural surfaces
# ---------------------------------------------------------------------------
def _stamp(canvas, mask_fn, cx, cy, r, value, mask_out=None):
    """Draw a blob into a tileable canvas with wrap-around."""
    h, w = canvas.shape[:2]
    R = int(math.ceil(r * 1.6)) + 1
    ys = (np.arange(int(cy) - R, int(cy) + R + 1)) % h
    xs = (np.arange(int(cx) - R, int(cx) + R + 1)) % w
    yy, xx = np.meshgrid(np.arange(int(cy) - R, int(cy) + R + 1) - cy,
                         np.arange(int(cx) - R, int(cx) + R + 1) - cx, indexing="ij")
    m = mask_fn(xx, yy)
    sub = canvas[np.ix_(ys, xs)]
    if sub.ndim == 3:
        sub[m] = value
    else:
        sub[m] = value
    canvas[np.ix_(ys, xs)] = sub
    if mask_out is not None:
        mo = mask_out[np.ix_(ys, xs)]
        mo[m] = 1.0
        mask_out[np.ix_(ys, xs)] = mo


def bake_terrazzo(size=1024):
    rng = np.random.default_rng(23)
    base = col("#E3D6C1")
    img = np.ones((size, size, 3), np.float32) * base
    fine = fft_noise(rng, size, beta=0.6)
    img *= (1 + 0.025 * fine)[..., None]
    cloud = fft_noise(rng, size, beta=3.0)
    img *= (1 + 0.02 * cloud)[..., None]
    chipmask = np.zeros((size, size), np.float32)
    palette = [("#F7F4EE", 0.22), ("#E58E7E", 0.16), ("#3E8F8C", 0.12), ("#E3B356", 0.12),
               ("#9A958E", 0.14), ("#2D2B2A", 0.07), ("#C76A4D", 0.09), ("#BFD6CF", 0.08)]
    cols = [col(c) for c, _ in palette]
    probs = np.array([p for _, p in palette])
    probs /= probs.sum()
    px_per_m = size / 2.0
    for size_mm, count in ((24, 140), (14, 620), (7, 2600), (3.5, 7000)):
        for _ in range(count):
            cx, cy = rng.random() * size, rng.random() * size
            r = size_mm / 1000.0 * px_per_m * (0.6 + 0.8 * rng.random()) * 0.5
            k = rng.choice(len(cols), p=probs)
            c = cols[k] * (0.92 + 0.12 * rng.random())
            harm = rng.standard_normal(4) * 0.18
            ph = rng.random(4) * 6.28
            rot = rng.random() * 6.28

            def mask(xx, yy, r=r, harm=harm, ph=ph):
                a = np.arctan2(yy, xx)
                rr = r * (1 + harm[0] * np.cos(2 * a + ph[0]) + harm[1] * np.cos(3 * a + ph[1])
                          + harm[2] * np.cos(5 * a + ph[2]))
                return np.sqrt(xx * xx + yy * yy) < rr
            _stamp(img, mask, cx, cy, r, c, chipmask)
    save("terrazzo_albedo", img, 90)
    rough = 0.34 - 0.06 * chipmask + 0.03 * cloud
    save("terrazzo_orm", orm(1.0, np.clip(rough, 0.2, 0.5)), 90)


def bake_wood(size=1024):
    """Teak decking: planks along U, 0.14 m wide, over 2 m."""
    rng = np.random.default_rng(31)
    px_per_m = size / 2.0
    plank_w = 0.14 * px_per_m
    nplank = int(round(size / plank_w))
    plank_w = size / nplank
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    idx = np.floor(yy / plank_w).astype(int) % nplank
    local = (yy % plank_w) / plank_w
    tone = rng.random(nplank) * 0.22 - 0.11
    offs = rng.random(nplank) * size
    # plank end joints, staggered
    joint_len = rng.integers(int(size * 0.45), int(size * 0.9), nplank)
    grain = np.zeros((size, size), np.float32)
    g1 = fft_noise(rng, size, beta=2.2, fmin=0.0)
    # stretch grain along U by sampling a squashed noise
    gs = fft_noise(rng, 64, size, beta=1.6)
    gs = np.repeat(gs, size // 64, axis=0)
    grain = 0.7 * gs + 0.3 * g1
    base = col("#94765C")
    lum = 1 + tone[idx] + 0.08 * grain
    img = base[None, None, :] * lum[..., None]
    # gaps between planks and at joints
    gap = smoothstep(0.0, 0.05, local) * smoothstep(0.0, 0.05, 1 - local)
    jx = (xx + offs[idx]) % joint_len[idx]
    joint = smoothstep(0, 3, jx) * smoothstep(0, 3, joint_len[idx] - jx)
    g = np.minimum(gap, joint)
    img = img * (0.35 + 0.65 * g)[..., None]
    save("wood_albedo", img, 88)
    height = g * 1.0 + 0.04 * grain
    save("wood_normal", normal_from_height(height, 3.0), 92)
    save("wood_orm", orm(0.6 + 0.4 * g, np.clip(0.62 + 0.05 * grain, 0.5, 0.8)), 90)


def bake_roof(size=1024):
    """Light roof membrane over 4 m: sheets 1 m wide with welded seams."""
    rng = np.random.default_rng(41)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    sheet = size / 4.0
    sx = (xx % sheet) / sheet
    seam = np.exp(-((sx - 0.0) * sheet / 2.2) ** 2) + np.exp(-((1 - sx) * sheet / 2.2) ** 2)
    sy = (yy % (size / 2)) / (size / 2)
    seam_h = np.exp(-(sy * size / 2 / 2.0) ** 2) + np.exp(-((1 - sy) * size / 2 / 2.0) ** 2)
    stain = fft_noise(rng, size, beta=3.4)
    grit = fft_noise(rng, size, beta=0.3)
    v = 0.74 + 0.03 * stain + 0.015 * grit - 0.05 * np.clip(seam + seam_h, 0, 1)
    img = np.stack([v, v * 0.99, v * 0.965], -1)
    save("roof_albedo", img, 88)
    height = np.clip(seam + seam_h, 0, 1) + 0.03 * grit
    save("roof_normal", normal_from_height(height, 2.0), 90)
    save("roof_orm", orm(1.0 - 0.15 * np.clip(seam + seam_h, 0, 1), np.clip(0.86 + 0.04 * stain, 0.7, 0.97)), 90)


def bake_glass_block(size=512):
    """4 x 4 blocks over 0.8 m: pillowed faces, rippled glass, light grout."""
    rng = np.random.default_rng(53)
    n = 4
    cell = size / n
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    u = (xx % cell) / cell
    v = (yy % cell) / cell
    grout_w = 0.045
    edge = np.minimum(np.minimum(u, 1 - u), np.minimum(v, 1 - v))
    in_block = smoothstep(grout_w, grout_w + 0.015, edge)
    pillow = smoothstep(grout_w, 0.2, edge)
    # concentric ripple typical of pressed glass blocks
    du, dv = u - 0.5, v - 0.5
    ripple = np.sin(np.sqrt(du * du + dv * dv) * 60.0) * 0.5 + 0.5
    lines = np.sin(u * math.pi * 14) * 0.5 + 0.5
    pattern = 0.55 * ripple + 0.45 * lines
    glass = col("#CFE6E4")
    edge_tint = col("#8FBDBC")
    grout = col("#D8D2C6")
    g = glass[None, None] * (0.9 + 0.1 * pattern)[..., None]
    g = g * pillow[..., None] + edge_tint[None, None] * (1 - pillow)[..., None]
    img = g * in_block[..., None] + grout[None, None] * (1 - in_block)[..., None]
    save("glass_block_albedo", img, 90)
    height = pillow * 1.0 + 0.08 * pattern * in_block
    save("glass_block_normal", normal_from_height(height, 6.0), 92)
    save("glass_block_orm", orm(0.75 + 0.25 * in_block, 0.08 * in_block + 0.85 * (1 - in_block)), 90)


def bake_awnings():
    """Two stripes (colour, white) across U per repeat; canvas weave in V.
    The coloured stripe sits in u 0..0.5, the white one in 0.5..1, so the same
    texture doubles as a solid swatch (cushions, vinyl) by pinning U."""
    rng = np.random.default_rng(61)
    w, h = 256, 512
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    weave = (np.sin(xx * math.pi / 1.5) * np.sin(yy * math.pi / 1.5)) * 0.5
    slub = fft_noise(rng, h, w, beta=1.2)
    fade = fft_noise(rng, h, w, beta=3.0)
    u = xx / w
    edge = smoothstep(0.0, 0.012, u) * smoothstep(0.0, 0.012, np.abs(u - 0.5)) * smoothstep(0.0, 0.012, 1 - u)
    variants = {
        "coral": "#E8735E",
        "teal": "#2E8A8A",
        "butter": "#E9C25A",
        "cherry": "#C83B3B",
    }
    white = col("#F2ECE0")
    for name, c in variants.items():
        cc = col(c)
        stripe = np.where(u < 0.5, 1.0, 0.0)[..., None]
        img = cc[None, None] * stripe + white[None, None] * (1 - stripe)
        img = img * (1 + 0.035 * weave + 0.02 * slub + 0.02 * fade)[..., None]
        img = img * (0.94 + 0.06 * edge)[..., None]
        save(f"awning_{name}_albedo", img, 90)
    save("awning_orm", orm(1.0, np.clip(0.86 + 0.04 * slub, 0.75, 0.95)), 90)
    save("awning_normal", normal_from_height(weave * 0.3 + 0.1 * slub, 1.5), 90)


# ---------------------------------------------------------------------------
# Window interiors
# ---------------------------------------------------------------------------
def _quad_mask(px, py, quad):
    """Convex quad (listed clockwise in image space) inside test."""
    inside = np.ones(px.shape, bool)
    n = len(quad)
    for i in range(n):
        x0, y0 = quad[i]
        x1, y1 = quad[(i + 1) % n]
        cr = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)
        inside &= cr >= -1e-6
    return inside


def _room(rng, S, lit, warm):
    """One window cell: a small room seen through glass, as albedo and
    emission. Image rows go top to bottom."""
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    u = (xx + 0.5) / S
    v = (yy + 0.5) / S
    vx = 0.5 + rng.uniform(-0.12, 0.12)
    vy = 0.52 + rng.uniform(-0.06, 0.08)
    depth = rng.uniform(0.42, 0.56)  # back wall size relative to the window
    bx0, bx1 = vx - depth * vx, vx + depth * (1 - vx)
    by0, by1 = vy - depth * vy, vy + depth * (1 - vy)
    walls = [col(c) for c in ("#E9DCC7", "#D9C2A5", "#BFD3CF", "#E8C9BF", "#CFC7DD", "#F0E6D2")]
    floors = [col(c) for c in ("#8A6446", "#6E5A4A", "#A88B6C", "#7B6E63")]
    wall = walls[rng.integers(len(walls))]
    floor = floors[rng.integers(len(floors))]
    ceil = col("#EDE8E0")
    img = np.zeros((S, S, 3), np.float32)
    back = (u >= bx0) & (u <= bx1) & (v >= by0) & (v <= by1)
    ceil_m = _quad_mask(u, v, [(0, 0), (1, 0), (bx1, by0), (bx0, by0)])
    floor_m = _quad_mask(u, v, [(bx0, by1), (bx1, by1), (1, 1), (0, 1)])
    left_m = _quad_mask(u, v, [(0, 0), (bx0, by0), (bx0, by1), (0, 1)])
    right_m = _quad_mask(u, v, [(bx1, by0), (1, 0), (1, 1), (bx1, by1)])
    img[left_m] = wall * 0.78
    img[right_m] = wall * 0.70
    img[ceil_m] = ceil * 0.85
    # floor gets darker toward the window, plank lines toward the vanishing point
    fl = floor[None, None] * (0.75 + 0.25 * np.clip((1 - v) / (1 - by1 + 1e-3), 0, 1))[..., None]
    img[floor_m] = fl[floor_m]
    img[back] = wall
    # furniture silhouettes on the back wall
    items = rng.integers(1, 4)
    for _ in range(items):
        kind = rng.integers(4)
        if kind == 0:  # sofa / sideboard
            x0 = bx0 + rng.uniform(0.05, 0.3) * (bx1 - bx0)
            x1 = min(bx1, x0 + rng.uniform(0.35, 0.6) * (bx1 - bx0))
            y0 = by1 - rng.uniform(0.18, 0.3) * (by1 - by0)
            m = (u > x0) & (u < x1) & (v > y0) & (v < by1 + 0.03)
            img[m] = col(["#3E6E73", "#B65E4E", "#5B4A6B", "#D7A94B", "#6A7C5A"][rng.integers(5)]) * 0.8
        elif kind == 1:  # framed picture
            cx = rng.uniform(bx0 + 0.1, bx1 - 0.1)
            cy = by0 + rng.uniform(0.2, 0.4) * (by1 - by0)
            w, h = rng.uniform(0.06, 0.12), rng.uniform(0.05, 0.09)
            m = (np.abs(u - cx) < w) & (np.abs(v - cy) < h)
            img[m] = col(["#2F5D6B", "#E0A458", "#C96C5D", "#87A98F"][rng.integers(4)])
            m2 = (np.abs(u - cx) < w * 0.8) & (np.abs(v - cy) < h * 0.75)
            img[m2] = img[m2] * 1.25
        elif kind == 2:  # plant
            cx = rng.choice([bx0 + 0.04, bx1 - 0.04, rng.uniform(0.15, 0.85)])
            cy = by1 - 0.08
            r = rng.uniform(0.06, 0.11)
            m = ((u - cx) ** 2 / (r * 0.8) ** 2 + (v - cy + r * 0.6) ** 2 / (r * 1.3) ** 2) < 1
            img[m] = col("#3F6B3C") * (0.8 + 0.3 * rng.random())
        else:  # shelf / bookcase
            x0 = rng.choice([bx0, bx1 - 0.18 * (bx1 - bx0)])
            x1 = x0 + 0.18 * (bx1 - bx0)
            m = (u > x0) & (u < x1) & (v > by0 + 0.1 * (by1 - by0)) & (v < by1)
            stripes = (np.floor((v - by0) / 0.045) % 2) == 0
            img[m & stripes] = col("#5A4636")
            img[m & ~stripes] = col("#A27B5C")
    # light: a lamp glow on the back wall or ceiling
    lx = rng.uniform(bx0 + 0.1, bx1 - 0.1)
    ly = by0 + rng.uniform(0.0, 0.3) * (by1 - by0)
    glow = np.exp(-(((u - lx) / 0.22) ** 2 + ((v - ly) / 0.22) ** 2))
    shade = col("#FFF1D6")
    # window treatments
    r_t = rng.random()
    treat = 0 if r_t < 0.22 else 1 if r_t < 0.28 else 2 if r_t < 0.62 else 3
    cover = np.zeros((S, S), bool)
    cover_col = None
    if treat == 0 or treat == 1:  # venetian blinds from the top
        drop = rng.uniform(0.2, 0.6) if treat == 0 else 1.0
        slats = ((v * 22) % 1.0) < 0.7
        bl = v < drop
        cover = bl
        bcol = col(["#EFE9DC", "#E7DCC6", "#DCE3E2"][rng.integers(3)])
        blind_img = np.where(slats[..., None], bcol[None, None], bcol[None, None] * 0.55)
        img[bl] = blind_img[bl]
        cover_col = "blind"
    elif treat == 2:  # curtains at the sides
        cc = col(["#E9D9BE", "#2E7C7A", "#E07A63", "#E7C15C", "#C9B6DE", "#F2EEE6"][rng.integers(6)])
        wl, wr = rng.uniform(0.12, 0.3), rng.uniform(0.12, 0.3)
        m = (u < wl) | (u > 1 - wr)
        folds = 0.82 + 0.18 * np.sin(u * 70.0)
        img[m] = (cc[None, None] * folds[..., None])[m]
        cover = m
    # lamp shade blob
    lamp = (((u - lx) / 0.05) ** 2 + ((v - ly - 0.02) / 0.035) ** 2) < 1
    img[lamp & ~cover] = shade
    albedo = img * 0.3 + 0.015  # interiors read much darker than the facade by day
    # emission
    if not lit:
        em = np.zeros_like(img)
        if rng.random() < 0.4:  # a TV flicker in a dark room
            em = img * 0.05 + col("#5C7CFF")[None, None] * 0.05 * glow[..., None]
    else:
        tint = col("#FFC98A") if warm else col("#DDE8FF")
        base = 0.42 + 0.58 * glow
        em = img * tint[None, None] * base[..., None] * 1.1
        em[lamp & ~cover] = shade * 1.2
        if cover_col == "blind":
            em[cover] = em[cover] * 0.8 + tint * 0.15
    return albedo, np.clip(em, 0, 1)


def _glass_block_cell(S, n=5):
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    cell = S / n
    u = (xx % cell) / cell
    v = (yy % cell) / cell
    edge = np.minimum(np.minimum(u, 1 - u), np.minimum(v, 1 - v))
    in_block = smoothstep(0.05, 0.07, edge)
    pillow = smoothstep(0.05, 0.25, edge)
    du, dv = u - 0.5, v - 0.5
    ripple = np.sin(np.sqrt(du * du + dv * dv) * 55.0) * 0.5 + 0.5
    glass = col("#BFDCDA") * (0.8 + 0.2 * ripple)[..., None]
    g = glass * (0.55 + 0.45 * pillow)[..., None]
    grout = col("#D9D3C7")
    alb = g * in_block[..., None] + grout[None, None] * (1 - in_block)[..., None]
    gy = (yy / S)
    glow = col("#FFD7A0")[None, None] * (0.55 + 0.45 * pillow)[..., None] * (0.75 + 0.25 * ripple)[..., None]
    em = glow * in_block[..., None]
    return alb * 0.75, np.clip(em, 0, 1)


GLASS_BLOCK_CELL = 15
LIGHT_PANEL_CELL = 14


def _light_panel_cell(S):
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    u, v = (xx + 0.5) / S, (yy + 0.5) / S
    edge = np.minimum(np.minimum(u, 1 - u), np.minimum(v, 1 - v))
    soft = smoothstep(0.0, 0.25, edge)
    alb = np.ones((S, S, 3), np.float32) * col("#F3EEE4")[None, None] * (0.85 + 0.15 * soft)[..., None]
    em = np.ones((S, S, 3), np.float32) * col("#FFE7C4")[None, None] * (0.7 + 0.3 * soft)[..., None]
    return alb, em


def bake_interior(size=1024, grid=4):
    rng = np.random.default_rng(71)
    S = size // grid
    alb = np.zeros((size, size, 3), np.float32)
    emi = np.zeros((size, size, 3), np.float32)
    states = (["warm"] * 10 + ["cool"] * 2 + ["dark"] * 4)
    rng.shuffle(states)
    for k in range(grid * grid):
        r, c = divmod(k, grid)
        if k in (GLASS_BLOCK_CELL, LIGHT_PANEL_CELL):
            a, e = _glass_block_cell(S) if k == GLASS_BLOCK_CELL else _light_panel_cell(S)
            alb[r * S:(r + 1) * S, c * S:(c + 1) * S] = a
            emi[r * S:(r + 1) * S, c * S:(c + 1) * S] = e
            continue
        a, e = _room(rng, S, states[k] != "dark", states[k] == "warm")
        # thin dark frame around each cell avoids bleeding between cells
        a[:2, :] = a[-2:, :] = a[:, :2] = a[:, -2:] = 0.08
        e[:2, :] = e[-2:, :] = e[:, :2] = e[:, -2:] = 0.0
        alb[r * S:(r + 1) * S, c * S:(c + 1) * S] = a
        emi[r * S:(r + 1) * S, c * S:(c + 1) * S] = e
    save("interior_albedo", alb, 88)
    save("interior_emissive", emi, 88)
    return states


def bake_tower_windows(size=1024):
    """16 x 16 window bays: rows are floors, columns are bays."""
    rng = np.random.default_rng(83)
    n = 16
    S = size // n
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    u = (xx + 0.5) / S
    v = (yy + 0.5) / S
    alb = np.zeros((size, size, 3), np.float32)
    emi = np.zeros((size, size, 3), np.float32)
    frame = col("#8E979C")
    glass = col("#2B3A46")
    for r in range(n):
        for c in range(n):
            g = glass * (0.85 + 0.3 * v[..., None]) * (0.9 + 0.2 * rng.random())
            a = g.copy()
            mull = (u < 0.022) | (u > 0.978) | (v < 0.03) | (v > 0.97)
            a[mull] = frame
            state = rng.random()
            if state < 0.30:
                tint = col("#FFC27A") * rng.uniform(0.4, 1.0)
            elif state < 0.40:
                tint = col("#E4ECFF") * rng.uniform(0.35, 0.8)
            else:
                tint = np.zeros(3, np.float32)
            blind = rng.random() < 0.35
            e = np.ones((S, S, 3), np.float32) * tint * (0.55 + 0.45 * (1 - v))[..., None]
            if blind:
                drop = rng.uniform(0.3, 1.0)
                bl = (v < drop) & (((v * 18) % 1.0) < 0.55)
                e[bl] *= 0.45
            e[mull] = 0.0
            alb[r * S:(r + 1) * S, c * S:(c + 1) * S] = a
            emi[r * S:(r + 1) * S, c * S:(c + 1) * S] = e
    save("tower_windows_albedo", alb, 86)
    save("tower_windows_emissive", emi, 86)


def bake_all():
    bake_stucco()
    bake_terrazzo()
    bake_wood()
    bake_roof()
    bake_glass_block()
    bake_awnings()
    bake_interior()
    bake_tower_windows()


def ao_to_webp(png, name, floor=0.16):
    """Baked AO -> WebP with a floor so crevices never go black (glTF
    occlusion reads R; all channels carry the same value)."""
    TEX_OUT.mkdir(parents=True, exist_ok=True)
    _run(["magick", str(png), "-colorspace", "Gray", "+level", f"{int(floor * 100)}%,100%", "-colorspace", "sRGB",
          "-type", "TrueColor", "-strip", "-quality", "86", "-define", "webp:method=6", str(TEX_OUT / f"{name}.webp")])
    CREDITS.append((name, "baked"))
