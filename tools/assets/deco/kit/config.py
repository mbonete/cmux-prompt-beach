"""Shared constants for the Deco/MiMo building kit.

Every length is in metres and every coordinate in the kit is written in glTF
space: X right, Y up, Z toward the front of the plot (the street, the camera).
The mesh builder converts to Blender's Z-up space when it creates vertices.
"""
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
KIT_DIR = Path(__file__).resolve().parent
DECO_DIR = KIT_DIR.parent
REPO = DECO_DIR.parents[2]
SRC = REPO / "assets-src"
OUT = REPO / "public" / "assets" / "buildings"
TEX_OUT = OUT / "textures"
STAGE = SRC / "_build" / "deco"          # scratch: raw renders, exported glTF before finalize
PREVIEWS = SRC / "_previews" / "buildings"

# ---------------------------------------------------------------------------
# Furniture heights shared with the character pipeline. Change them here only.
# All spot empties carry these numbers in their extras so the client can check
# what the building assumed.
# ---------------------------------------------------------------------------
SEAT_H = 0.46          # chair, bench and stoop seat above the person's root
DESK_H = 0.72          # desk / table top above the person's root (the seated
                       # work clip measures 0.719 m to the forearms)
STOOL_RAISE = 0.29     # bar stools: the root sits on the footrest, 0.29 m up,
                       # so the seat (0.75) and counter (1.01) keep SEAT_H/DESK_H
LOUNGER_SEAT_H = 0.34  # sun lounger cushion top above the root
DESK_CHAIR_BACK = 0.50 # chair centre to desk front edge, along the facing axis

# ---------------------------------------------------------------------------
# Plot
# ---------------------------------------------------------------------------
PLOT_W = 20.0  # X
PLOT_D = 16.0  # Z
TERRACE_Y = 0.04  # top of the terrace floor inlay on plots

# ---------------------------------------------------------------------------
# Texture tiling: metres covered by one repeat of each tiling texture.
# Every UV in the kit is computed from world metres divided by these numbers,
# which keeps texel density consistent across buildings (~340-640 px/m).
# ---------------------------------------------------------------------------
TILE = {
    "stucco": 3.0,
    "trim": 3.0,
    "concrete": 3.0,
    "planter": 1.5,
    "terrazzo": 2.0,
    "wood": 2.0,
    "roof": 4.0,
    "glass_block": 0.8,
    "metal": 2.0,
    "glass": 2.0,
    "water": 2.0,
    "awning": 2.0,     # V direction; U is set by the stripe period
    "neon_accent": 1.0,
    "interior": 1.0,
    "bulb": 1.0,
}
AWNING_STRIPE_PERIOD = 0.56  # one coloured + one white stripe

# ---------------------------------------------------------------------------
# Palette (sRGB). Pastels are tuned to survive AgX: saturated enough to read
# in the shade of a backlit golden-hour scene, never candy.
# ---------------------------------------------------------------------------
PALETTE = {
    "flamingo": "#EEA8A2",
    "mint": "#A6DAC4",
    "peach": "#F4C39C",
    "butter": "#F1DB98",
    "powder": "#A9C8E2",
    "lilac": "#C6B4DD",
    "aqua": "#8FD0CB",
    "coral": "#EE9A84",
    "shell": "#F3E6D6",      # warm off-white body
    "warm_white": "#F4EFE6", # trim
    "deep_teal": "#2B7F82",
    "terracotta": "#B9694A",
    "chrome": "#D9DCDF",
    "brushed": "#B8BCC0",
    "tower_white": "#EDEBE6",
}
# Night lights: colours for the light_<n> empties (the client's fake light
# pools) and the bulb material. Warm only.
LIGHT = {
    "warm": "#FFC680",     # string lights, festoon bulbs
    "amber": "#FFAE5C",    # lanterns, sconces
    "candle": "#FFD9A6",   # frosted globes, marquee bulbs
}
NEON = {
    "violet": "#D27BFF",
    "amber": "#FFB257",
    "red": "#FF5E4D",
    "warm_white": "#FFD7A8",
    "aqua": "#5EF2DD",
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_lin(h, alpha=1.0):
    h = h.lstrip("#")
    rgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return [round(srgb_to_linear(c), 5) for c in rgb] + [alpha]


def hex_srgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
