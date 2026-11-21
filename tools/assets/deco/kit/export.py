"""Scene assembly and glTF export.

Each building is built in a fresh empty scene: a root empty named after the
asset, the merged mesh, optional extra mesh nodes (sign boards) and the
contract empties. Materials are exported by name only; finalize.mjs applies
the PBR definitions from materials.py.
"""
import math

import bmesh
import bpy
import numpy as np

from .config import TILE
from .geo import B


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.objects, bpy.data.images):
        for item in list(coll):
            coll.remove(item)


def _box_uv(mb):
    bm = mb.bm
    uv = mb.uv
    lock = mb.lock
    for f in bm.faces:
        if f[lock]:
            continue
        mat = mb.mats[f.material_index]
        t = TILE[mat]
        n = f.normal  # Blender space
        gx, gy, gz = n.x, n.z, -n.y
        ax, ay, az = abs(gx), abs(gy), abs(gz)
        for l in f.loops:
            co = l.vert.co
            x, y, z = co.x, co.z, -co.y
            if ay >= ax and ay >= az:
                u, v = x, -z
            elif ax >= az:
                u, v = (-z if gx > 0 else z), y
            else:
                u, v = (x if gz > 0 else -x), y
            l[uv].uv = (u / t, v / t)


def finish_mesh(mb, name, sharp_deg=48.0, merge=True, weighted=True):
    bm = mb.bm
    if merge:
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    # drop degenerate faces left by collapsed geometry
    bad = [f for f in bm.faces if f.calc_area() < 1e-9]
    if bad:
        bmesh.ops.delete(bm, geom=bad, context='FACES')
    bm.normal_update()
    _box_uv(mb)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method='BEAUTY', ngon_method='BEAUTY')
    lim = math.radians(sharp_deg)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            a = e.calc_face_angle(0.0)
            if a > lim:
                e.smooth = False
            if e.link_faces[0].material_index != e.link_faces[1].material_index and a > math.radians(20):
                e.smooth = False
    for f in bm.faces:
        f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mb.mats:
        mat = bpy.data.materials.get(m) or bpy.data.materials.new(m)
        me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if weighted:
        mod = ob.modifiers.new("wn", 'WEIGHTED_NORMAL')
        mod.mode = 'FACE_AREA'
        mod.weight = 50
        mod.keep_sharp = True
        mod.thresh = 0.01
    return ob


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def root(name):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'PLAIN_AXES'
    bpy.context.scene.collection.objects.link(ob)
    return ob


def empty(name, pos, yaw=0.0, parent=None, props=None, size=0.3):
    """Empty at glTF position pos, rotated yaw degrees about +Y so that its
    local +Z faces (sin yaw, 0, cos yaw)."""
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'SINGLE_ARROW'
    ob.empty_display_size = size
    ob.location = B(pos)
    ob.rotation_euler = (0.0, 0.0, math.radians(yaw))
    if props:
        for k, v in props.items():
            ob[k] = v
    bpy.context.scene.collection.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


def export(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format='GLTF_SEPARATE',
        export_image_format='NONE',
        export_materials='EXPORT',
        export_extras=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_vertex_color='NONE',
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        use_selection=False,
    )


NO_AO = {"neon_accent", "interior", "glass"}  # keep in sync with finalize.mjs
PACK_SCALE = 0.965
WHITE_UV = 0.985


def _mark_large_components(ob, min_area):
    """Select faces of connected parts larger than min_area (m2); return the
    set of face indices of the small parts (furniture, tubes, trims)."""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    seen = set()
    small = set()
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, comp = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        if sum(g.calc_area() for g in comp) < min_area:
            small.update(g.index for g in comp)
    skip = {i for i, m in enumerate(me.materials) if m and m.name in NO_AO}
    small.update(f.index for f in bm.faces if f.material_index in skip)
    bm.free()
    me.polygons.foreach_set("select", [p.index not in small for p in me.polygons])
    return small


def bake_ao(objs, name, size, out_png, distance=2.0, samples=64, ground=True, min_area=2.0):
    """Bake ambient occlusion of the building onto a second UV set ("AO",
    exported as TEXCOORD_1). A temporary ground plane adds contact occlusion."""
    sc = bpy.context.scene
    vl = bpy.context.view_layer
    for ob in objs:
        me = ob.data
        uv = me.uv_layers.new(name="AO")
        me.uv_layers["UVMap"].active_render = True
        me.uv_layers.active = uv
    smalls = {ob.name: _mark_large_components(ob, min_area) for ob in objs}
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objs:
        ob.select_set(True)
    vl.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.context.tool_settings.mesh_select_mode = (False, False, True)
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    # squeeze the packed layout and park small parts on a white corner
    for ob in objs:
        me = ob.data
        uvl = me.uv_layers["AO"].data
        small = smalls[ob.name]
        for poly in me.polygons:
            for li in poly.loop_indices:
                if poly.index in small:
                    uvl[li].uv = (WHITE_UV, WHITE_UV)
                else:
                    u, v = uvl[li].uv
                    uvl[li].uv = (u * PACK_SCALE, v * PACK_SCALE)
    gp = None
    if ground:
        gme = bpy.data.meshes.new("bake_ground")
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=200)
        bm.to_mesh(gme)
        bm.free()
        gp = bpy.data.objects.new("bake_ground", gme)
        sc.collection.objects.link(gp)
    img = bpy.data.images.new(f"ao_{name}", size, size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    nodes_added = []
    for ob in objs:
        for slot in ob.material_slots:
            m = slot.material
            if m is None:
                continue
            m.use_nodes = True
            nt = m.node_tree
            n = nt.nodes.get("ao_bake") or nt.nodes.new("ShaderNodeTexImage")
            n.name = "ao_bake"
            n.image = img
            nt.nodes.active = n
            nodes_added.append((nt, n))
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    if sc.world is None:
        sc.world = bpy.data.worlds.new("bake_world")
    sc.world.light_settings.distance = distance
    sc.render.bake.margin = 6
    sc.render.bake.margin_type = 'EXTEND'
    bpy.ops.object.bake(type='AO', uv_layer="AO", margin=6, margin_type='EXTEND', use_clear=True,
                        target='IMAGE_TEXTURES')
    px = np.empty(size * size * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(size, size, 4)
    c0 = int(size * (PACK_SCALE + 0.004))
    px[c0:, c0:, :3] = 1.0
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = str(out_png)
    img.file_format = 'PNG'
    out_png.parent.mkdir(parents=True, exist_ok=True)
    img.save()
    for nt, n in nodes_added:
        if n.name in nt.nodes:
            nt.nodes.remove(n)
    if gp is not None:
        bpy.data.objects.remove(gp)
    for ob in objs:
        ob.data.uv_layers.active = ob.data.uv_layers["UVMap"]
