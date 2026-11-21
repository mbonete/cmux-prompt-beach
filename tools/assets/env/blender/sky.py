"""Sky pipeline (run inside Blender for its bundled numpy and .hdr reader).

    blender -b --factory-startup --python tools/assets/env/blender/sky.py -- <repo root> [id ...]

For every HDRI in config.json `sky.hdri` it writes:
  public/assets/env/sky/<id>_2k.hdr   visible background (sun kept; lower hemisphere
                                      flattened to a per-row mean below -10..-20 deg)
  public/assets/env/sky/<id>_1k.hdr   image-based lighting (sun disc removed and
                                      in-painted; its energy goes to the directional light)
  <build>/sky/<id>_clouds.rgba         raw RGBA8 cloud layer (4096 x 1024), encoded to WebP by build.mjs
  <build>/sky/<id>_stars.rgb           raw RGB8 star layer (4096 x 1024)
  <build>/sky/<id>.json                measurements (sun or twilight glow, irradiance, layer scales)
  <previews>/sky_<id>.png              equirect preview with a 30 deg grid and the sun marked

Conventions (also written to the manifest):
  u = x / width from the image's left edge, v = y / height from the top edge.
  azimuthDeg = u * 360 (0 at the left edge, increasing to the right).
  elevationDeg = 90 - v * 180.
  three.js (r187 EquirectUV.js, HDRLoader flipY) maps world direction d to
  u = atan2(d.z, d.x) / 2pi + 0.5, so with no rotation:
  d = (cos el cos t, sin el, cos el sin t), t = (u - 0.5) * 2pi
  (u = 0.25 -> -Z, 0.5 -> +X, 0.75 -> +Z, 0 / 1 -> -X).
"""
import json
import math
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
import rgbe  # noqa: E402

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


# ----------------------------------------------------------------------------- helpers

def argv_after_dashes():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def row_elev(h):
    return (0.5 - (np.arange(h) + 0.5) / h) * np.pi


def solid_angle_rows(h, w):
    return (2 * np.pi / w) * (np.pi / h) * np.cos(row_elev(h))


def direction(u, el):
    t = (u - 0.5) * 2 * np.pi
    return np.array([np.cos(el) * np.cos(t), np.sin(el), np.cos(el) * np.sin(t)])


def _box_x_wrap(a, r):
    if r <= 0:
        return a
    n = 2 * r + 1
    pad = np.concatenate([a[:, -r - 1:], a, a[:, :r]], axis=1)
    c = np.cumsum(pad, axis=1, dtype=np.float64)
    return ((c[:, n:] - c[:, :-n]) / n).astype(np.float32)


def _box_y_edge(a, r):
    if r <= 0:
        return a
    n = 2 * r + 1
    top = np.repeat(a[:1], r + 1, axis=0)
    bot = np.repeat(a[-1:], r, axis=0)
    pad = np.concatenate([top, a, bot], axis=0)
    c = np.cumsum(pad, axis=0, dtype=np.float64)
    return ((c[n:] - c[:-n]) / n).astype(np.float32)


def _box_radius(sigma):
    return max(0, int(round((math.sqrt(4 * sigma * sigma + 1) - 1) / 2)))


def gblur(a, sx, sy):
    """Approximate Gaussian (3 box passes); periodic in x, clamped in y."""
    rx, ry = _box_radius(sx), _box_radius(sy)
    for _ in range(3):
        a = _box_x_wrap(a, rx)
        a = _box_y_edge(a, ry)
    return a


def nconv(img, wgt, sx, sy):
    """Normalised convolution: blur of img*wgt over blur of wgt."""
    if img.ndim == 3:
        num = np.stack([gblur(img[..., c] * wgt, sx, sy) for c in range(img.shape[2])], axis=-1)
        den = gblur(wgt, sx, sy)[..., None]
    else:
        num = gblur(img * wgt, sx, sy)
        den = gblur(wgt, sx, sy)
    return num / np.maximum(den, 1e-6), den


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def downsample(a, f):
    h, w, c = a.shape
    return a.reshape(h // f, f, w // f, f, c).mean(axis=(1, 3)).astype(np.float32)


def linear_to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def write_raw(path, arr):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    np.ascontiguousarray(arr.astype(np.uint8)).tofile(path)


def to_u8(x):
    return (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)


# ----------------------------------------------------------------------------- sun

def measure_sun(a):
    """Find the brightest compact source, measure it, return (info, sunless image)."""
    h, w = a.shape[:2]
    el = row_elev(h)
    dom = solid_angle_rows(h, w)
    L = a @ LUMA
    Ls = gblur(L, 1, 1)
    Ls[el < math.radians(-5)] = 0
    iy, ix = np.unravel_index(int(np.argmax(Ls)), Ls.shape)

    # window around the peak (wraps in x)
    win_deg = 7.0
    ry = int(win_deg / 180 * h)
    y0, y1 = max(0, iy - ry), min(h, iy + ry + 1)
    rx = int(min(w // 2 - 1, win_deg / 360 * w / max(0.1, math.cos(el[iy]))))
    xs = np.arange(ix - rx, ix + rx + 1) % w
    sub = a[y0:y1][:, xs].copy()
    subL = sub @ LUMA
    elw = el[y0:y1]
    uw = (xs + 0.5) / w
    d0 = direction((ix + 0.5) / w, el[iy])
    dirs = np.stack(np.broadcast_arrays(
        np.cos(elw)[:, None] * np.cos((uw[None, :] - 0.5) * 2 * np.pi),
        np.sin(elw)[:, None] + 0 * uw[None, :],
        np.cos(elw)[:, None] * np.sin((uw[None, :] - 0.5) * 2 * np.pi)), axis=-1)
    ang = np.degrees(np.arccos(np.clip(dirs @ d0, -1, 1)))
    ring = (ang > 3.5) & (ang < 5.5)
    bg = float(np.median(subL[ring]))
    peak = float(subL.max())
    thresh = max(4 * bg, bg + 0.002 * (peak - bg))
    mask = (ang < 3.0) & (subL > thresh)
    # dilate the mask by one pixel so the in-paint boundary sits on sky
    m = mask.copy()
    m[1:] |= mask[:-1]; m[:-1] |= mask[1:]; m[:, 1:] |= mask[:, :-1]; m[:, :-1] |= mask[:, 1:]
    mask = m

    # Laplace in-paint of the masked pixels from their surroundings
    fill = sub.copy()
    fill[mask] = np.median(sub[ring], axis=0)
    for _ in range(3000):
        nb = (np.roll(fill, 1, 0) + np.roll(fill, -1, 0) + np.roll(fill, 1, 1) + np.roll(fill, -1, 1)) / 4
        fill[mask] = nb[mask]
    excess = np.maximum(sub - fill, 0) * mask[..., None]
    domw = dom[y0:y1][:, None]
    E = (excess * domw[..., None]).reshape(-1, 3).sum(axis=0)        # irradiance on a plane facing the source
    Elum = float(E @ LUMA)
    wsum = (excess @ LUMA) * domw
    cen = (dirs * wsum[..., None]).reshape(-1, 3).sum(axis=0)
    if not np.isfinite(cen).all() or np.linalg.norm(cen) < 1e-12:
        cen = d0.copy()                      # no excess energy: fall back to the peak pixel
    cen /= np.linalg.norm(cen)
    sun_el = math.degrees(math.asin(cen[1]))
    t = math.atan2(cen[2], cen[0])
    sun_u = (t / (2 * math.pi) + 0.5) % 1.0
    disc_sr = float((mask * domw).sum())

    sunless = a.copy()
    blk = sunless[y0:y1]
    blk[:, xs] = np.where(mask[..., None], fill, sub)
    sunless[y0:y1] = blk

    # sky irradiance on an upward-facing plane, without the source
    Lsl = sunless @ LUMA
    up = el > 0
    E_sky_up = float((Lsl[up] * (np.sin(el[up]) * dom[up])[:, None]).sum())
    E_sky_rgb = (sunless[up] * (np.sin(el[up]) * dom[up])[:, None, None]).reshape(-1, 3).sum(axis=0)

    info = {
        "peak": peak, "background": bg, "E": E, "Elum": Elum,
        "u": sun_u, "v": 0.5 - sun_el / 180, "el": sun_el,
        "discSr": disc_sr, "maskPixels4k": int(mask.sum()),
        "skyUp": E_sky_up, "skyUpRgb": E_sky_rgb, "pixel": (int(ix), int(iy)),
    }
    return info, sunless


def twilight_glow(a):
    """Azimuth of the brightest stretch of horizon (for skies without a visible sun)."""
    h, w = a.shape[:2]
    el = np.degrees(row_elev(h))
    band = (el > 0.5) & (el < 12)
    L = a[band] @ LUMA
    col = L.mean(axis=0)
    k = int(w * 10 / 360)
    sm = _box_x_wrap(col[None, :].astype(np.float32), k // 2)[0]
    sm = _box_x_wrap(sm[None, :], k // 2)[0]
    ix = int(np.argmax(sm))
    rgb = a[band][:, max(0, ix - k): ix + k].reshape(-1, 3).mean(axis=0)
    # elevation of the brightest point of the glow column (above the horizon)
    colL = a[:, max(0, ix - k // 4): ix + k // 4] @ LUMA
    prof = colL.mean(axis=1)
    prof[el < 0] = 0
    return {
        "u": (ix + 0.5) / w,
        "contrast": float(sm.max() / max(1e-6, np.median(sm))),
        "rgb": rgb,
        "peakElevationDeg": float(el[int(np.argmax(prof))]),
    }


# ----------------------------------------------------------------------------- layers

def cloud_layer(a, ref_u, ref_el, sun_visible):
    """Separate clouds from the clear sky of the upper hemisphere (4096 x 1024 at 4K).

    Clouds are told from clear sky by their red/blue ratio (a standard sky-imager
    cue): clear sky is blue (B/R well above 1), cloud is grey or white (B/R near 1).
    d = (rbr_sky - rbr) / (rbr_sky - 1) is 0 on clear sky and 1 on a neutral cloud,
    where rbr_sky is the local clear-sky blue/red ratio. Where the clear sky itself
    is not blue (the sun's glare, the warm band at the horizon, a pink dusk sky)
    the cue does not separate anything and alpha is left at 0.
    The clear-sky colour S is a normalised convolution over cloud-free pixels; the
    cloud colour is un-premultiplied so  alpha * C + (1 - alpha) * S  reproduces the HDRI.
    """
    h, w = a.shape[:2]
    up = a[: h // 2].astype(np.float32)
    hh = up.shape[0]
    deg = w / 360.0
    eps = 1e-4
    rbr = (up[..., 2] + eps) / (up[..., 0] + eps)
    # clear-sky blue/red ratio: start from the bluest 40% of each row (clouds cover
    # less than that at any elevation here), then iterate on pixels at least 80% as
    # blue as the local clear-sky estimate
    wgt = (rbr >= np.percentile(rbr, 60, axis=1, keepdims=True)).astype(np.float32)
    rbr_sky, _ = nconv(rbr, wgt, 30 * deg, 8 * deg)
    for _ in range(4):
        wgt = (rbr > rbr_sky - 0.2 * np.maximum(rbr_sky - 1, 0.05)).astype(np.float32)
        rs, den = nconv(rbr, wgt, 8 * deg, 3 * deg)
        rb, _ = nconv(rbr, wgt, 30 * deg, 10 * deg)
        k = np.clip(den / 0.3, 0, 1)
        rbr_sky = k * rs + (1 - k) * rb
    blue = rbr_sky - 1.0
    d = (rbr_sky - rbr) / np.maximum(blue, 1e-3)
    d = gblur(d.astype(np.float32), 1.0, 1.0)
    alpha = smoothstep(0.12, 0.65, d) * smoothstep(0.12, 0.25, blue)
    eld = np.degrees(row_elev(h)[:hh])[:, None]
    alpha = alpha * smoothstep(0.3, 1.2, eld)
    ref = direction(ref_u, math.radians(ref_el))
    el = row_elev(h)[:hh]
    t = ((np.arange(w) + 0.5) / w - 0.5) * 2 * np.pi
    cosg = (np.cos(el)[:, None] * np.cos(t)[None, :] * ref[0] + np.sin(el)[:, None] * ref[1]
            + np.cos(el)[:, None] * np.sin(t)[None, :] * ref[2])
    gsun = np.degrees(np.arccos(np.clip(cosg, -1, 1)))
    if sun_visible:
        alpha = alpha * smoothstep(2.0, 4.5, gsun)
    alpha = alpha.astype(np.float32)
    # Fill holes: low-alpha pockets enclosed by cloud are cloud whose cue failed
    # (near the sun the clear sky turns white and B/R stops separating). Flood
    # fill from confidently clear sky (and the sun's clear zone) at 1/4 res.
    f = 4
    small_a = alpha.reshape(hh // f, f, w // f, f).mean(axis=(1, 3))
    small_b = blue.reshape(hh // f, f, w // f, f).mean(axis=(1, 3))
    passable = small_a < 0.5
    if sun_visible:
        # the sun's glare is a barrier, so it cannot connect enclosed pockets to open sky
        passable &= gsun.reshape(hh // f, f, w // f, f).min(axis=(1, 3)) > 7.0
    seed = (small_a < 0.05) & (small_b > 0.3) & passable
    reached = seed & passable
    for i in range(4000):
        n = reached.copy()
        n[1:] |= reached[:-1]
        n[:-1] |= reached[1:]
        n |= np.roll(reached, 1, 1)
        n |= np.roll(reached, -1, 1)
        n &= passable
        if i % 25 == 0 and np.array_equal(n, reached):
            break
        reached = n
    holes = (passable & ~reached).astype(np.float32)
    holes = np.repeat(np.repeat(holes, f, axis=0), f, axis=1)
    holes = gblur(holes, 2, 2)
    if sun_visible:
        holes = holes * smoothstep(2.0, 4.5, gsun)
    alpha = np.maximum(alpha, holes).astype(np.float32)
    clear = (1 - smoothstep(0.02, 0.15, alpha)).astype(np.float32)
    if sun_visible:
        clear = clear * (gsun > 6.0)                    # keep the glare out of the clear-sky fill
    Ss, den = nconv(up, clear, 4 * deg, 1.5 * deg)
    Sb, _ = nconv(up, clear, 20 * deg, 6 * deg)
    k = np.clip(den / 0.3, 0, 1)
    S = k * Ss + (1 - k) * Sb
    a3 = alpha[..., None]
    C = np.where(a3 > 0.02, (up - (1 - a3) * S) / np.maximum(a3, 0.02), up)
    C = np.maximum(C, 0)
    if sun_visible:
        near = smoothstep(4.0, 7.0, gsun)[..., None]   # near the sun S is unreliable: keep the source colour
        C = C * near + up * (1 - near)
    CL = C @ LUMA
    sel = alpha > 0.3
    refL = float(np.percentile(CL[sel], 99.5)) if sel.sum() > 100 else float(np.percentile(CL, 99.5))
    scale = refL / 0.92
    rgb = linear_to_srgb(C / scale)
    rgba = np.concatenate([to_u8(rgb), to_u8(alpha)[..., None]], axis=-1)
    coverage = float(alpha.mean())
    return rgba, {"hdrScale": scale, "coverage": coverage, "residual": None}, S, alpha, C


def star_layer(a):
    """Point sources plus the faint Milky Way band from a night HDRI (upper hemisphere)."""
    h, w = a.shape[:2]
    up = a[: h // 2].astype(np.float32)
    L = up @ LUMA
    deg = w / 360.0
    # background without point sources
    wgt = np.ones(L.shape, np.float32)
    for _ in range(3):
        B, _d = nconv(up, wgt, 3, 3)
        BL = B @ LUMA
        wgt = (L < BL * 1.15 + 0.02).astype(np.float32)
    resid = up - B
    rl = resid @ LUMA
    noise = float(1.4826 * np.median(np.abs(rl[wgt > 0])))
    starmask = smoothstep(3 * noise, 6 * noise, rl)
    stars = np.maximum(resid, 0) * starmask[..., None]
    # Milky Way / diffuse glow: mid-scale structure of the background
    G, _ = nconv(B, np.ones(L.shape, np.float32), 12 * deg, 6 * deg)
    glow = np.maximum(B - G, 0)
    el = np.degrees(row_elev(h)[: h // 2])
    fade = smoothstep(8, 22, el)[:, None, None]
    layer = (stars + glow * 0.8) * fade
    ll = layer @ LUMA
    sel = stars @ LUMA
    ref = float(np.percentile(sel[sel > 0], 99.7)) if (sel > 0).sum() > 100 else float(ll.max())
    scale = ref
    rgb = linear_to_srgb(layer / scale)
    n_stars = int((starmask > 0.5).sum())
    return to_u8(rgb), {"hdrScale": scale, "noise": noise, "starPixels": n_stars}


# ----------------------------------------------------------------------------- preview

def tonemap(a, key=0.3):
    L = a @ LUMA
    k = key / max(1e-6, float(np.median(L)))
    m = a * k
    m = m / (1 + m)
    return linear_to_srgb(m)


def preview(path, a, marks, title, lines):
    """2048 x 1024 tonemapped preview with a 30 deg grid, the horizon, and markers."""
    img = tonemap(downsample(a, a.shape[1] // 2048))
    h, w = img.shape[:2]
    img = img.copy()
    for k in range(13):                     # azimuth lines every 30 deg (u steps of 1/12)
        x = min(w - 1, int(round(k / 12 * w)))
        img[:, x] = img[:, x] * 0.5 + 0.5 * np.array([1, 1, 1]) * (0.9 if k % 3 == 0 else 0.6)
    for e in range(-60, 90, 30):
        y = int(round((0.5 - e / 180) * h))
        col = np.array([1.0, 0.85, 0.3]) if e == 0 else np.array([0.8, 0.8, 0.8])
        img[y] = img[y] * 0.4 + 0.6 * col
    for (u, v, color) in marks:
        cx, cy = u * w, v * h
        yy, xx = np.mgrid[0:h, 0:w]
        dx = np.minimum(np.abs(xx - cx), w - np.abs(xx - cx))
        r = np.sqrt(dx ** 2 + (yy - cy) ** 2)
        ring = (np.abs(r - 18) < 1.6) | (np.abs(r - 30) < 1.2)
        cross = ((dx < 1.2) & (r > 34) & (r < 70)) | ((np.abs(yy - cy) < 1.2) & (r > 34) & (r < 70))
        img[ring | cross] = np.array(color)
    # 1:1 inset of the source around the first marker (no overlay), 4x zoom, top right
    if marks:
        u, v, _c = marks[0]
        H, W = a.shape[:2]
        cy, cx = int(v * H), int(u * W)
        r = 48
        ys = np.clip(np.arange(cy - r, cy + r), 0, H - 1)
        xs = np.arange(cx - r, cx + r) % W
        crop = a[ys][:, xs]
        cL = crop @ LUMA
        k = 0.8 / max(1e-6, float(np.percentile(cL, 99.9)))
        ins = linear_to_srgb(np.clip(crop * k, 0, 1))
        ins = np.repeat(np.repeat(ins, 4, axis=0), 4, axis=1)
        s_ = ins.shape[0]
        ins[s_ // 2, :] = ins[s_ // 2, :] * 0.5 + 0.5 * np.array([1.0, 0.1, 0.6])
        ins[:, s_ // 2] = ins[:, s_ // 2] * 0.5 + 0.5 * np.array([1.0, 0.1, 0.6])
        img[8:8 + s_, w - 8 - s_: w - 8] = ins
    raw = path + ".rgb"
    to_u8(img).tofile(raw)
    cmd = ["magick", "-size", f"{w}x{h}", "-depth", "8", "rgb:" + raw,
           "-font", FONT, "-fill", "white", "-undercolor", "#00000099", "-pointsize", "26",
           "-annotate", "+16+36", title, "-pointsize", "20"]
    for i, line in enumerate(lines):
        cmd += ["-annotate", f"+16+{70 + 28 * i}", line]
    if marks:
        cmd += ["-annotate", f"+{w - 8 - 384}+{8 + 384 + 24}", "inset: source pixels, 4x, exposed for the peak"]
    labels = [(0.0, "u=0 (-X)"), (0.25, "u=.25 (-Z)"), (0.5, "u=.5 (+X)"), (0.75, "u=.75 (+Z)")]
    for u, s in labels:
        cmd += ["-annotate", f"+{int(u * w) + 6}+{h // 2 - 8}", s]
    for e in (-60, -30, 30, 60):
        cmd += ["-annotate", f"+{w - 60}+{int((0.5 - e / 180) * h) - 6}", f"{e}°"]
    cmd.append(path)
    subprocess.run(cmd, check=True)
    os.remove(raw)


# ----------------------------------------------------------------------------- main

def srgb_hex(rgb_lin):
    c = linear_to_srgb(np.asarray(rgb_lin))
    return "#" + "".join(f"{int(round(v * 255)):02x}" for v in c)


def main():
    args = argv_after_dashes()
    root = os.path.abspath(args[0])
    only = set(args[1:])
    cfg = json.load(open(os.path.join(root, "tools/assets/env/config.json")))
    sky = cfg["sky"]
    out_dir = os.path.join(root, cfg["out"], "sky")
    build_dir = os.path.join(root, cfg["build"], "sky")
    prev_dir = os.path.join(root, cfg["previews"])
    for d in (out_dir, build_dir, prev_dir):
        os.makedirs(d, exist_ok=True)

    for item in sky["hdri"]:
        sid = item["id"]
        if only and sid not in only:
            continue
        print(f"[sky] {sid}", flush=True)
        a = rgbe.load_hdr(os.path.join(root, item["src"]))
        h, w = a.shape[:2]
        el = row_elev(h)

        sun, sunless = measure_sun(a)
        visible = sun["Elum"] > 0.02 * sun["skyUp"] and sun["peak"] > 50 * sun["background"]
        meas = {"id": sid, "mood": item.get("mood"), "source": {"width": w, "height": h}}
        E = sun["E"]
        if visible:
            mx = float(E.max())
            col = E / mx
            t = (sun["u"] - 0.5) * 2 * math.pi
            elr = math.radians(sun["el"])
            d = [math.cos(elr) * math.cos(t), math.sin(elr), math.cos(elr) * math.sin(t)]
            meas["sun"] = {
                "visible": True,
                "u": round(sun["u"], 5), "v": round(sun["v"], 5),
                "azimuthDeg": round(sun["u"] * 360, 2),
                "elevationDeg": round(sun["el"], 2),
                "directionThree": [round(x, 5) for x in d],
                "rotationYToPutSunAtNegZ": round(((t + math.pi / 2 + math.pi) % (2 * math.pi)) - math.pi, 5),
                "colorLinear": [round(float(x), 4) for x in col],
                "colorHex": srgb_hex(col),
                "intensity": round(mx, 4),
                "illuminanceLum": round(sun["Elum"], 4),
                "discSolidAngleSr": sun["discSr"],
                "discEquivalentRadiusDeg": round(math.degrees(math.sqrt(sun["discSr"] / math.pi)), 3),
                "peakRadiance": round(sun["peak"], 2),
                "skyIrradianceUp": round(sun["skyUp"], 4),
                "sunToSkyRatioHorizontal": round(sun["Elum"] * math.sin(elr) / sun["skyUp"], 3),
            }
            ibl = sunless
            marks = [(sun["u"], sun["v"], (1.0, 0.1, 0.6))]
            lines = [f"sun  az {sun['u'] * 360:.2f} deg (u {sun['u']:.4f})   el {sun['el']:.2f} deg   "
                     f"colour {srgb_hex(col)}   intensity {mx:.3g} (HDR units)",
                     f"sky irradiance (up) {sun['skyUp']:.3g}   sun:sky on ground {sun['Elum'] * math.sin(elr) / sun['skyUp']:.2f}"]
        else:
            g = twilight_glow(a)
            gc = g["rgb"] / g["rgb"].max()
            t = (g["u"] - 0.5) * 2 * math.pi
            meas["sun"] = {
                "visible": False,
                "note": "No sun disc above the horizon. azimuthDeg is the centre of the brightest stretch of horizon glow (where the sun set, or the residual twilight); use the IBL alone or a weak grazing fill from there.",
                "u": round(g["u"], 5),
                "azimuthDeg": round(g["u"] * 360, 2),
                "elevationDeg": None,
                "glowPeakElevationDeg": round(g["peakElevationDeg"], 2),
                "glowContrast": round(g["contrast"], 3),
                "glowColorLinear": [round(float(x), 4) for x in gc],
                "glowColorHex": srgb_hex(gc),
                "intensity": 0,
                "rotationYToPutGlowAtNegZ": round(((t + math.pi / 2 + math.pi) % (2 * math.pi)) - math.pi, 5),
                "skyIrradianceUp": round(sun["skyUp"], 4),
            }
            if sun["Elum"] > 0:
                meas["sun"]["brightestPoint"] = {
                    "u": round(sun["u"], 5), "elevationDeg": round(sun["el"], 2),
                    "peakRadiance": round(sun["peak"], 2), "illuminanceLum": round(sun["Elum"], 6),
                    "note": "compact source too faint to light the scene (a star or planet); left in all outputs",
                }
            ibl = a
            marks = [(g["u"], 0.5 - 2 / 180, (0.2, 1.0, 0.6))]
            lines = [f"no sun disc; horizon glow centre az {g['u'] * 360:.2f} deg (u {g['u']:.4f}), colour {srgb_hex(gc)}",
                     f"sky irradiance (up) {sun['skyUp']:.3g}"]

        # backgrounds and IBL
        bg = downsample(a, w // sky["backgroundRes"])
        hb = bg.shape[0]
        lo, hi = sky["flattenBelowDeg"]
        elb = np.degrees(row_elev(hb))
        t_fl = smoothstep(-lo, -hi, -elb)[:, None, None]           # 0 above lo, 1 below hi
        bg = bg * (1 - t_fl) + bg.mean(axis=1, keepdims=True) * t_fl
        n_bg = rgbe.write_hdr(os.path.join(out_dir, f"{sid}_2k.hdr"), bg)
        n_ibl = rgbe.write_hdr(os.path.join(out_dir, f"{sid}_1k.hdr"), downsample(ibl, w // sky["iblRes"]))
        meas["files"] = {"background": f"{sid}_2k.hdr", "ibl": f"{sid}_1k.hdr"}
        meas["bytes"] = {"background": n_bg, "ibl": n_ibl}
        meas["notes"] = [
            f"_2k.hdr keeps the sun disc; below {lo} deg it fades to a per-row mean by {hi} deg (hidden by the sea and ground) to save bytes.",
            "_1k.hdr has the sun disc removed and in-painted (when there is one); pair it with a DirectionalLight using sun.colorLinear and sun.intensity, scaled by the same factor as environmentIntensity.",
        ]

        # layers
        if not item.get("clouds") and item.get("cloudsVerdict"):
            meas["clouds"] = {"viable": False, "reason": item["cloudsVerdict"]}
        if item.get("clouds") or item.get("cloudsEvidence"):
            ref_u = meas["sun"]["u"]
            ref_el = meas["sun"]["elevationDeg"] if visible else -4.0
            rgba, cinfo, S, alpha, C = cloud_layer(a, ref_u, ref_el, visible)
            if item.get("clouds"):
                write_raw(os.path.join(build_dir, f"{sid}_clouds.rgba"), rgba)
            # reconstruction check: composite over the estimated clear sky
            up = a[: h // 2]
            rec = alpha[..., None] * C + (1 - alpha[..., None]) * S
            err = float(np.median(np.abs((rec @ LUMA) - (up @ LUMA)) / ((up @ LUMA) + 1e-4)))
            cinfo["residual"] = err
            if item.get("clouds"):
                meas["clouds"] = {"viable": True, "width": rgba.shape[1], "height": rgba.shape[0], **cinfo}
            # previews: alpha, colour over grey, clear-sky estimate
            pv = os.path.join(prev_dir, f"sky_{sid}_clouds{'' if item.get('clouds') else '_rejected'}.png")
            grey = np.full_like(C, 0.18)
            over = tonemap(alpha[..., None] * C + (1 - alpha[..., None]) * (S * 0 + np.array([0.05, 0.08, 0.16]) * float(np.median(S @ LUMA)) / 0.08))
            panel = np.concatenate([
                tonemap(up)[::2, ::2],
                tonemap(S)[::2, ::2],
                np.repeat(alpha[::2, ::2, None], 3, axis=2),
                over[::2, ::2]], axis=0)
            to_u8(panel).tofile(pv + ".rgb")
            subprocess.run(["magick", "-size", f"{panel.shape[1]}x{panel.shape[0]}", "-depth", "8", "rgb:" + pv + ".rgb",
                            "-font", FONT, "-fill", "white", "-undercolor", "#00000099", "-pointsize", "22",
                            "-annotate", "+12+30", f"{sid}: source (upper hemisphere)",
                            "-annotate", f"+12+{panel.shape[0] // 4 + 30}", "estimated clear sky",
                            "-annotate", f"+12+{panel.shape[0] // 2 + 30}", f"cloud alpha (coverage {cinfo['coverage']:.3f})",
                            "-annotate", f"+12+{3 * panel.shape[0] // 4 + 30}", "cloud layer over a flat blue sky",
                            pv], check=True)
            os.remove(pv + ".rgb")
        if item.get("stars"):
            rgb8, sinfo = star_layer(a)
            write_raw(os.path.join(build_dir, f"{sid}_stars.rgb"), rgb8)
            meas["stars"] = {"width": rgb8.shape[1], "height": rgb8.shape[0], **sinfo}
            pv = os.path.join(prev_dir, f"sky_{sid}_stars.png")
            hh8, ww8 = rgb8.shape[:2]
            crop = rgb8[hh8 // 4: hh8 // 4 + 256, ww8 // 3: ww8 // 3 + 1024]
            small = rgb8.reshape(hh8 // 2, 2, ww8 // 2, 2, 3).max(axis=(1, 3))
            panel = np.concatenate([small, np.repeat(np.repeat(crop, 2, axis=0), 2, axis=1)], axis=0)
            panel.tofile(pv + ".rgb")
            subprocess.run(["magick", "-size", f"{panel.shape[1]}x{panel.shape[0]}", "-depth", "8", "rgb:" + pv + ".rgb",
                            "-font", FONT, "-fill", "white", "-undercolor", "#00000099", "-pointsize", "22",
                            "-annotate", "+12+30", f"{sid}: star layer, upper hemisphere (2x2 max-pooled)",
                            "-annotate", f"+12+{small.shape[0] + 30}", "1:1 crop, shown at 2x", pv], check=True)
            os.remove(pv + ".rgb")

        title = f"{sid}  ({w}x{h} source)"
        preview(os.path.join(prev_dir, f"sky_{sid}.png"), a, marks, title, lines)

        with open(os.path.join(build_dir, f"{sid}.json"), "w") as f:
            json.dump(meas, f, indent=2, default=float)
        print(json.dumps(meas["sun"], default=float), flush=True)


main()
