"""Procedural water textures, original and seamless (run inside Blender for numpy).

    blender -b --factory-startup --python tools/assets/env/blender/procedural.py -- <repo root>

Writes raw 8-bit images plus a JSON sidecar to <build>/procedural/; build.mjs
encodes them to WebP in public/assets/env/textures/water/.

  ocean_normal  RGB  tangent-space normal, OpenGL (+Y = up the image), from a
                     spectral (FFT) height field: a directional wind-sea band
                     plus isotropic ripples, i.e. several octaves of wavelengths.
                     Periodic by construction (integer wave numbers).
  foam          grey foam lace for thresholding: periodic Worley cell borders
                     at three scales, broken up by periodic fBm.
                     foam = step(1 - coverage, texel) gives clumps that grow
                     organically as coverage rises (shoreline: coverage from
                     distance to shore; crests: from wave height).
  caustics      grey light-focusing pattern: photons refracted through a
                     periodic water surface and splatted with wrap-around,
                     then softened. Mean about 0.35; multiply into the lighting
                     of shallow sea floor.
"""
import json
import os
import sys

import numpy as np


def argv_after_dashes():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def kgrid(n):
    k = np.fft.fftfreq(n, d=1.0 / n)            # integer wave numbers (cycles per tile)
    kx, ky = np.meshgrid(k, k)                  # kx along columns, ky along rows
    return kx, ky, np.sqrt(kx * kx + ky * ky)


def spectral_field(rng, n, amp):
    """Real periodic field from random phases and an amplitude spectrum amp(kx, ky)."""
    noise = rng.normal(size=(n, n)) + 1j * rng.normal(size=(n, n))
    return noise * amp


def fbm_periodic(rng, n, beta=2.0, kmin=1.0, kmax=None):
    kx, ky, k = kgrid(n)
    kmax = kmax or n / 2
    amp = np.where((k >= kmin) & (k <= kmax), 1.0 / np.maximum(k, 1e-6) ** (beta / 2 + 0.5), 0.0)
    f = np.real(np.fft.ifft2(spectral_field(rng, n, amp)))
    f = (f - f.mean()) / (f.std() + 1e-9)
    return f


def ocean_normal(rng, n, tile_m, wind, octaves):
    kx, ky, k = kgrid(n)
    wdir = np.array(wind, float)
    wdir /= np.linalg.norm(wdir)
    kk = np.maximum(k, 1e-6)
    cosw = (kx * wdir[0] + ky * wdir[1]) / kk
    # wind-sea band: peak wavelength ~ tile/3, directional spread cos^4 (one-sided
    # waves travel with the wind, so keep both lobes but damp the upwind one)
    kp = 4.0
    spread = np.where(cosw > 0, np.abs(cosw) ** 4, 0.25 * np.abs(cosw) ** 4)
    sea = np.exp(-1.25 * (kp / kk) ** 2) / kk ** 4 * spread
    # isotropic ripples spanning several octaves above the wind sea
    ripple = np.zeros_like(k)
    for o in range(octaves):
        kc = kp * 4 * 2 ** o
        ripple += 0.12 * np.exp(-((np.log2(kk) - np.log2(kc)) ** 2) / 0.5) / kk ** 4 * (0.6 + 0.4 * np.abs(cosw))
    S = sea + ripple
    S[0, 0] = 0
    S[k > n / 2.2] = 0
    H = spectral_field(rng, n, np.sqrt(S))
    # slopes per metre: d/dx = i * 2pi kx / tile
    two_pi = 2 * np.pi / tile_m
    dhdcol = np.real(np.fft.ifft2(1j * two_pi * kx * H))
    dhdrow = np.real(np.fft.ifft2(1j * two_pi * ky * H))
    h = np.real(np.fft.ifft2(H))
    # scale to an RMS slope of 0.12 (a moderate sea)
    rms = np.sqrt((dhdcol ** 2 + dhdrow ** 2).mean())
    s = 0.12 / rms
    dhdcol *= s
    dhdrow *= s
    h *= s
    # OpenGL convention: +Y points up the image (towards row 0)
    nx, ny, nz = -dhdcol, dhdrow, np.ones_like(h)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    nrm = np.stack([nx / ln, ny / ln, nz / ln], axis=-1)
    rgb = np.clip((nrm + 1) * 127.5 + 0.5, 0, 255).astype(np.uint8)
    info = {
        "rmsSlope": 0.12,
        "maxSlope": float(np.sqrt(dhdcol ** 2 + dhdrow ** 2).max()),
        "peakWavelengthM": tile_m / kp,
        "heightRangeM": [float(h.min()), float(h.max())],
        "windDirectionUV": [float(wdir[0]), float(-wdir[1])],
    }
    return rgb, info, h


def worley_border(rng, n, cells):
    """Periodic Worley F2 - F1 (distance to the nearest cell border), in cell units."""
    pts = rng.random((cells, cells, 2))
    yy, xx = np.mgrid[0:n, 0:n]
    fx = (xx + 0.5) / n * cells
    fy = (yy + 0.5) / n * cells
    cx = np.floor(fx).astype(int)
    cy = np.floor(fy).astype(int)
    d1 = np.full((n, n), 1e9)
    d2 = np.full((n, n), 1e9)
    for oy in (-1, 0, 1):
        for ox in (-1, 0, 1):
            gx = cx + ox
            gy = cy + oy
            p = pts[gy % cells, gx % cells]
            px = gx + p[..., 0]
            py = gy + p[..., 1]
            d = np.sqrt((fx - px) ** 2 + (fy - py) ** 2)
            closer = d < d1
            d2 = np.where(closer, d1, np.minimum(d2, d))
            d1 = np.where(closer, d, d1)
    return d2 - d1


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def foam(rng, n):
    lace = np.zeros((n, n))
    for cells, width, weight in ((10, 0.22, 0.55), (24, 0.18, 0.3), (56, 0.16, 0.15)):
        b = worley_border(rng, n, cells)
        lace += weight * (1 - smoothstep(0.0, width, b))
    lace /= lace.max()
    patches = fbm_periodic(rng, n, beta=2.2, kmin=1, kmax=24)
    fine = fbm_periodic(rng, n, beta=1.2, kmin=16, kmax=n / 3)
    v = 0.62 * lace + 0.28 * smoothstep(-1.5, 1.8, patches) + 0.10 * smoothstep(-2, 2, fine)
    # equalise so thresholds map linearly to coverage: texel value = 1 - rank
    flat = v.ravel()
    order = np.argsort(flat)
    rank = np.empty_like(order, dtype=np.float64)
    rank[order] = np.arange(flat.size) / (flat.size - 1)
    v = rank.reshape(n, n)
    g = np.clip(v * 255 + 0.5, 0, 255).astype(np.uint8)
    return g, {"distribution": "uniform (histogram-equalised): coverage c is obtained with step(1 - c, texel)"}


def caustics(rng, n, tile_m):
    kx, ky, k = kgrid(n)
    kk = np.maximum(k, 1e-6)
    S = np.exp(-((np.log2(kk) - np.log2(6.0)) ** 2) / 1.2) / kk ** 3
    S[0, 0] = 0
    H = spectral_field(rng, n, np.sqrt(S))
    gx = np.real(np.fft.ifft2(1j * kx * H))
    gy = np.real(np.fft.ifft2(1j * ky * H))
    g = np.sqrt(gx ** 2 + gy ** 2)
    focus = 0.9 * n / 24 / max(1e-9, np.percentile(g, 99))   # displacement in pixels per unit slope
    ss = 3                                                  # 3x3 photons per pixel
    tot = np.zeros((n, n))
    for sy in range(ss):
        for sx in range(ss):
            oy, ox = (sy + 0.5) / ss, (sx + 0.5) / ss
            yy, xx = np.mgrid[0:n, 0:n]
            px = xx + ox - focus * gx
            py = yy + oy - focus * gy
            x0 = np.floor(px).astype(int)
            y0 = np.floor(py).astype(int)
            tx = px - x0
            ty = py - y0
            for dy, wy in ((0, 1 - ty), (1, ty)):
                for dx, wx in ((0, 1 - tx), (1, tx)):
                    np.add.at(tot, ((y0 + dy) % n, (x0 + dx) % n), wx * wy)
    tot /= ss * ss
    # soften: periodic gaussian blur in the frequency domain (sigma ~1.2 px)
    sig = 1.2
    blur = np.exp(-2 * (np.pi * sig) ** 2 * ((kx / n) ** 2 + (ky / n) ** 2))
    tot = np.real(np.fft.ifft2(np.fft.fft2(tot) * blur))
    c = tot / tot.mean()                    # mean 1
    c = 1 - np.exp(-0.45 * c)               # soft shoulder for the bright lines
    c = c / np.percentile(c, 99.8)
    g8 = np.clip(c * 255 + 0.5, 0, 255).astype(np.uint8)
    return g8, {"mean": float(np.clip(c, 0, 1).mean())}


def write_previews(root, cfg, rgb, foam_g, caus_g):
    """2x2 tiled previews: ocean normal shaded by a low sun, foam at three coverages, caustics."""
    import subprocess
    prev = os.path.join(root, cfg["previews"])
    os.makedirs(prev, exist_ok=True)
    n = rgb.astype(np.float32) / 127.5 - 1
    sun = np.array([0.55, 0.25, 0.80]); sun /= np.linalg.norm(sun)      # (x right, y up-image, z out)
    view = np.array([0.0, -0.6, 0.8]); view /= np.linalg.norm(view)
    hv = sun + view; hv /= np.linalg.norm(hv)
    diff = np.clip(n @ sun, 0, 1)
    spec = np.clip(n @ hv, 0, 1) ** 180 * 3
    fres = 0.02 + 0.98 * (1 - np.clip(n @ view, 0, 1)) ** 5
    col = np.array([0.02, 0.18, 0.22]) * diff[..., None] + (np.array([1.0, 0.75, 0.45]) * spec[..., None]) + fres[..., None] * np.array([0.5, 0.45, 0.6])
    col = np.clip(col, 0, 1) ** (1 / 2.2)
    ocean = (col * 255).astype(np.uint8)
    tiles = lambda im: np.concatenate([np.concatenate([im, im], 1)] * 2, 0)
    f = foam_g.astype(np.float32) / 255
    foam_rgb = np.stack([np.concatenate([(f > 1 - c) * 255 for c in (0.15, 0.4, 0.7)], 1)] * 3, -1).astype(np.uint8)
    panels = [("ocean_normal (shaded by a low sun, 2x2 tiles)", tiles(ocean)),
              ("foam thresholded at coverage 0.15 / 0.40 / 0.70", foam_rgb),
              ("caustics (2x2 tiles)", np.repeat(tiles(caus_g)[..., None], 3, -1))]
    for name, im in panels:
        key = name.split(" ")[0]
        path = os.path.join(prev, f"water_{key}.png")
        im.tofile(path + ".rgb")
        subprocess.run(["magick", "-size", f"{im.shape[1]}x{im.shape[0]}", "-depth", "8", "rgb:" + path + ".rgb",
                        "-resize", "1600x1600>", "-font", "/System/Library/Fonts/Supplemental/Arial.ttf",
                        "-fill", "white", "-undercolor", "#000000aa", "-pointsize", "24", "-annotate", "+12+32", name, path], check=True)
        os.remove(path + ".rgb")


def main():
    root = os.path.abspath(argv_after_dashes()[0])
    cfg = json.load(open(os.path.join(root, "tools/assets/env/config.json")))
    pc = cfg["procedural"]
    out = os.path.join(root, cfg["build"], "procedural")
    os.makedirs(out, exist_ok=True)
    meta = {}

    rng = np.random.default_rng(pc["seed"])
    o = pc["ocean_normal"]
    rgb, info, h = ocean_normal(rng, o["size"], o["tileM"], o["wind"], o["octaves"])
    rgb.tofile(os.path.join(out, "ocean_normal.rgb"))
    meta["ocean_normal"] = {"width": o["size"], "height": o["size"], "channels": 3, "tileM": o["tileM"], **info}

    rng = np.random.default_rng(pc["seed"] + 1)
    f = pc["foam"]
    g, info = foam(rng, f["size"])
    g.tofile(os.path.join(out, "foam.grey"))
    meta["foam"] = {"width": f["size"], "height": f["size"], "channels": 1, "tileM": f["tileM"], **info}

    rng = np.random.default_rng(pc["seed"] + 2)
    c = pc["caustics"]
    g, info = caustics(rng, c["size"], c["tileM"])
    g.tofile(os.path.join(out, "caustics.grey"))
    meta["caustics"] = {"width": c["size"], "height": c["size"], "channels": 1, "tileM": c["tileM"], **info}

    write_previews(root, cfg, rgb, np.fromfile(os.path.join(out, "foam.grey"), np.uint8).reshape(f["size"], f["size"]), g)
    with open(os.path.join(out, "procedural.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    print(json.dumps(meta))


main()
