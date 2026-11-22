"""glTF material definitions, resolved per building.

finalize.mjs applies these to the exported glTF by material name, so this file
is the single source of truth for factors, textures and alpha modes. Texture
names refer to files in public/assets/buildings/textures/<name>.webp.
"""
import copy

from .config import PALETTE, NEON, LIGHT, hex_lin

ALLOWED = ["stucco", "trim", "glass", "glass_block", "metal", "terrazzo", "wood", "awning", "roof",
           "concrete", "planter", "soil", "water", "neon_accent", "interior", "bulb"]

BASE = {
    "stucco": dict(base=hex_lin(PALETTE["flamingo"]), albedo="stucco_albedo", orm="stucco_orm",
                   normal="stucco_normal", normalScale=0.7, rough=1.0, metal=0.0),
    "trim": dict(base=hex_lin(PALETTE["warm_white"]), albedo="stucco_albedo", orm="stucco_orm",
                 normal="stucco_normal", normalScale=0.45, rough=0.78, metal=0.0),
    "concrete": dict(base=[1, 1, 1, 1], albedo="concrete_albedo", orm="concrete_orm",
                     normal="stucco_normal", normalScale=0.8, rough=1.0, metal=0.0),
    "planter": dict(base=hex_lin("#B88468"), albedo="stucco_albedo", orm="stucco_orm",
                    normal="stucco_normal", normalScale=1.0, rough=1.0, metal=0.0),
    "soil": dict(base=hex_lin("#4B3527"), rough=0.97, metal=0.0),
    "terrazzo": dict(base=[1, 1, 1, 1], albedo="terrazzo_albedo", orm="terrazzo_orm", rough=1.0, metal=0.0),
    "wood": dict(base=[1, 1, 1, 1], albedo="wood_albedo", orm="wood_orm", normal="wood_normal",
                 normalScale=0.6, rough=1.0, metal=0.0),
    "roof": dict(base=[1, 1, 1, 1], albedo="roof_albedo", orm="roof_orm", normal="roof_normal",
                 normalScale=0.6, rough=1.0, metal=0.0),
    "glass_block": dict(base=[1, 1, 1, 1], albedo="glass_block_albedo", orm="glass_block_orm",
                        normal="glass_block_normal", normalScale=0.8, rough=1.0, metal=0.0),
    "awning": dict(base=[1, 1, 1, 1], albedo="awning_coral_albedo", orm="awning_orm",
                   normal="awning_normal", normalScale=0.5, rough=1.0, metal=0.0, doubleSided=True),
    "metal": dict(base=hex_lin(PALETTE["chrome"]), rough=0.22, metal=1.0),
    "glass": dict(base=hex_lin("#9FC3C4", 0.32), rough=0.04, metal=0.0, alphaMode="BLEND"),
    "water": dict(base=hex_lin("#2E9C9F"), rough=0.05, metal=0.0),
    "neon_accent": dict(base=hex_lin("#F4E6F0"), rough=0.3, metal=0.0, emissive=hex_lin(NEON["violet"])[:3],
                        emissiveStrength=4.0),
    # festoon bulbs, sconce and lantern glass, marquee bulbs: warm white emissive
    # that the client scales with a night level (and turns off on vacant plots)
    "bulb": dict(base=hex_lin("#FFF3E2"), rough=0.3, metal=0.0, emissive=hex_lin(LIGHT["candle"])[:3],
                 emissiveStrength=6.0),
    "interior": dict(base=[1, 1, 1, 1], albedo="interior_albedo", emissiveTex="interior_emissive",
                     emissive=[1.0, 1.0, 1.0], emissiveStrength=1.0, rough=0.05, metal=0.0),
}


def resolve(used, stucco=None, trim=None, neon=None, awning=None, interior=None, extra=None):
    """Material specs for one building. used: material names in the mesh."""
    out = {}
    for name in used:
        if name not in ALLOWED:
            raise ValueError(name)
        spec = copy.deepcopy(BASE[name])
        if name == "stucco" and stucco:
            spec["base"] = hex_lin(PALETTE.get(stucco, stucco))
        if name == "trim" and trim:
            spec["base"] = hex_lin(PALETTE.get(trim, trim))
        if name == "neon_accent" and neon:
            spec["emissive"] = hex_lin(NEON.get(neon, neon))[:3]
            spec["base"] = [min(1.0, 0.75 + 0.25 * c) for c in spec["emissive"]] + [1.0]
        if name == "awning" and awning:
            spec["albedo"] = f"awning_{awning}_albedo"
        if name == "interior" and interior == "tower":
            spec["albedo"] = "tower_windows_albedo"
            spec["emissiveTex"] = "tower_windows_emissive"
            spec["rough"] = 0.08
        if extra and name in extra:
            spec.update(extra[name])
        out[name] = spec
    return out
