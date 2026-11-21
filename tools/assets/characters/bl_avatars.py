"""Blender step 1: Rocketbox avatar FBX -> clean skinned glTF (geometry + skin only).

usage: blender -b --python bl_avatars.py -- <config.json>
config: {"src": ".../Avatars", "out": ".../_cache/characters/avatars", "avatars": [{"id", "dir"}...]}

For each avatar it writes <out>/<Id>/<Id>.gltf (+ .bin) and <out>/<Id>/info.json, plus
<out>/../skeleton_<m|f>.json (the rest skeleton every avatar of that gender shares).
Materials are exported as named placeholders (body / head / alpha); the Node step
attaches the converted textures.
"""
import os
import sys

sys.dont_write_bytecode = True  # keep tools/ free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import bl_common as C  # noqa: E402

cfg = C.read_json(C.args()[0])
skeletons = {}

for av in cfg['avatars']:
    aid, adir = av['id'], av['dir']
    C.reset()
    arm, meshes, new = C.import_fbx(os.path.join(adir, 'Export', aid + '.fbx'))
    if len(meshes) != 1:
        raise RuntimeError(f'{aid}: expected one mesh, got {[m.name for m in meshes]}')
    src = meshes[0]
    # stray loose vertices (Female_Party_02 has four, unweighted) would make the glTF
    # exporter add a "neutral_bone" joint; drop them
    bpy.context.view_layer.objects.active = src
    for o in bpy.data.objects:
        o.select_set(o == src)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.delete_loose(use_verts=True, use_edges=True, use_faces=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    unweighted = [v.index for v in src.data.vertices if sum(g.weight for g in v.groups) < 1e-4]
    if unweighted:
        raise RuntimeError(f'{aid}: {len(unweighted)} vertices without skin weights')
    sk = C.skeleton_from_avatar(arm)
    gender = 'f' if src.name.startswith('f') else 'm'

    # all avatars of a gender must share one skeleton (bone names, hierarchy, rest)
    ref = skeletons.get(gender)
    if ref is None:
        skeletons[gender] = sk
        C.write_json(os.path.join(cfg['out'], '..', f'skeleton_{gender}.json'), C.skeleton_to_json(sk))
    else:
        if ref['order'] != sk['order'] or ref['parent'] != sk['parent']:
            raise RuntimeError(f'{aid}: bone hierarchy differs from the other {gender} avatars')
        drift = max((ref['rest'][n].to_translation() - sk['rest'][n].to_translation()).length for n in sk['order'])
        if drift > 1e-3:
            raise RuntimeError(f'{aid}: rest skeleton differs by {drift:.4f} m')

    deform = {g.name for g in src.vertex_groups}
    rig = C.build_rig(sk, deform=deform)

    # move the mesh into world metres, parent it to the new rig
    mw = src.matrix_world.copy()
    src.parent = None
    src.data.transform(mw)
    src.matrix_world = Matrix.Identity(4)
    src.parent = rig
    for m in src.modifiers:
        if m.type == 'ARMATURE':
            m.object = rig
    src.name = 'lod0'
    src.data.name = 'lod0'

    # named placeholder materials, slot order preserved
    slot_names = []
    for slot in src.material_slots:
        old = slot.material.name
        kind = old.split('_')[-1]
        role = {'body': 'body', 'head': 'head', 'opacity': 'alpha'}[kind]
        mat = bpy.data.materials.new(role)
        slot.material = mat
        slot_names.append({'role': role, 'prefix': old.rsplit('_', 1)[0]})

    C.remove_objects([o for o in new if o is not src])
    C.purge()

    # Hair / eyelash cards: the source mixes inward and outward card windings and
    # carries custom normals that point into the skull on about a third of them, so
    # those cards shade black. Orient every card outward from the head and give it
    # soft "volume" normals (face normal blended with the direction from the head
    # centre), the usual treatment for alpha-card hair.
    alpha_idx = [i for i, sn in enumerate(slot_names) if sn['role'] == 'alpha']
    flipped = 0
    if alpha_idx:
        ai = alpha_idx[0]
        me = src.data
        head = sk['rest']['Bip01 Head'].to_translation()
        center = head + Vector((0, 0.01, 0.075))
        old_n = {}
        for poly in me.polygons:
            for li in poly.loop_indices:
                old_n[(poly.index, me.loops[li].vertex_index)] = me.corner_normals[li].vector.copy()
        for poly in me.polygons:
            if poly.material_index == ai and poly.normal.dot(poly.center - center) < 0:
                poly.flip()
                flipped += 1
        me.update()
        normals = [None] * len(me.loops)
        for poly in me.polygons:
            for li in poly.loop_indices:
                vi = me.loops[li].vertex_index
                if poly.material_index == ai:
                    fn = poly.normal
                    radial = (me.vertices[vi].co - center).normalized()
                    if radial.dot(fn) < 0:  # keep the blend in the card's front hemisphere
                        radial = radial - fn * (2 * radial.dot(fn))
                    n = fn * 0.35 + radial * 0.65
                    normals[li] = n.normalized() if n.length > 1e-3 else fn.copy()
                else:
                    normals[li] = old_n[(poly.index, vi)]
        me.normals_split_custom_set(normals)

    me = src.data
    me.calc_loop_triangles()
    zs = [v.co.z for v in me.vertices]
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    tri_by_mat = {}
    uv_tris = {}
    uvl = me.uv_layers[0].data
    for t in me.loop_triangles:
        r = slot_names[t.material_index]['role']
        tri_by_mat[r] = tri_by_mat.get(r, 0) + 1
        dst = uv_tris.setdefault(r, [])
        for li in t.loops:
            dst.extend((round(uvl[li].uv.x, 5), round(uvl[li].uv.y, 5)))
    max_infl = max(len([g for g in v.groups if g.weight > 1e-4]) for v in me.vertices)

    out_dir = os.path.join(cfg['out'], aid)
    os.makedirs(out_dir, exist_ok=True)
    for o in bpy.data.objects:
        o.select_set(o in (rig, src))
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(out_dir, aid + '.gltf'),
        export_format='GLTF_SEPARATE',
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials='EXPORT',
        export_image_format='NONE',
        export_vertex_color='NONE',
        export_skins=True,
        export_influence_nb=4,
        export_all_influences=False,
        export_def_bones=False,
        export_rest_position_armature=True,
        export_morph=False,
        export_animations=False,
        export_extras=False,
        export_cameras=False,
        export_lights=False,
    )
    C.write_json(os.path.join(out_dir, 'uv.json'), uv_tris)
    C.write_json(os.path.join(out_dir, 'info.json'), {
        'id': aid,
        'skeleton': gender,
        'materials': slot_names,
        'tris': len(me.loop_triangles),
        'trisByMaterial': tri_by_mat,
        'verts': len(me.vertices),
        'maxInfluences': max_infl,
        'cardsFlipped': flipped,
        'height': round(max(zs) - min(zs), 4),
        'minZ': round(min(zs), 4),
        'boundsMin': [round(min(xs), 4), round(min(zs), 4), round(-max(ys), 4)],
        'boundsMax': [round(max(xs), 4), round(max(zs), 4), round(-min(ys), 4)],
    })
    print('AVATAR', aid, gender, len(me.loop_triangles), 'tris', tri_by_mat, 'height', round(max(zs) - min(zs), 3), 'maxInfl', max_infl)
