"""Minimal Radiance .hdr (RGBE) writer with new-style RLE, numpy only.

Used by the env pipeline because Blender's image.save() applies colour
management to float buffers and ImageMagick's HDR writer rescales values.
Reading is left to Blender (bpy.data.images.load), which is exact.
"""
import numpy as np


def float_to_rgbe(rgb):
    """rgb: (h, w, 3) float32, linear. Returns (h, w, 4) uint8 RGBE."""
    rgb = np.maximum(np.nan_to_num(rgb.astype(np.float32), nan=0.0, posinf=0.0), 0.0)
    m = rgb.max(axis=2)
    out = np.zeros(rgb.shape[:2] + (4,), np.uint8)
    nz = m > 1e-32
    mant, exp = np.frexp(m[nz])                 # m = mant * 2**exp, mant in [0.5, 1)
    scale = mant * 256.0 / m[nz]
    vals = rgb[nz] * scale[:, None]
    out[nz, :3] = np.clip(vals, 0, 255).astype(np.uint8)
    out[nz, 3] = (exp + 128).astype(np.uint8)
    return out


def _rle_channel(row):
    """Encode one channel of one scanline (uint8 array) as Radiance RLE packets."""
    out = bytearray()
    n = len(row)
    # run boundaries
    change = np.flatnonzero(np.diff(row.astype(np.int16))) + 1
    starts = np.concatenate(([0], change))
    ends = np.concatenate((change, [n]))
    lit = bytearray()

    def flush():
        i = 0
        while i < len(lit):
            chunk = lit[i:i + 128]
            out.append(len(chunk))
            out.extend(chunk)
            i += 128
        lit.clear()

    rb = row.tobytes()
    for s, e in zip(starts.tolist(), ends.tolist()):
        ln = e - s
        if ln >= 4:
            flush()
            v = rb[s]
            while ln > 0:
                c = min(ln, 127)
                out.append(128 + c)
                out.append(v)
                ln -= c
        else:
            lit.extend(rb[s:e])
    flush()
    return out


def write_hdr(path, rgb):
    """rgb: (h, w, 3) float array, row 0 = top of the image."""
    h, w = rgb.shape[:2]
    rgbe = float_to_rgbe(rgb)
    buf = bytearray(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=1.0\n\n")
    buf += f"-Y {h} +X {w}\n".encode()
    if not (8 <= w <= 0x7fff):
        buf += rgbe.tobytes()
    else:
        hdr = bytes([2, 2, w >> 8, w & 255])
        for y in range(h):
            buf += hdr
            line = rgbe[y]
            for c in range(4):
                buf += _rle_channel(line[:, c])
    with open(path, "wb") as f:
        f.write(buf)
    return len(buf)


def load_hdr(path):
    """Load an .hdr with Blender; returns (h, w, 3) float32 with row 0 = top."""
    import bpy
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)[::-1, :, :3].copy()
