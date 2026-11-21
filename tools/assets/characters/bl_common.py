"""Shared Blender helpers for the character pipeline (run inside Blender 5.2).

Conventions used everywhere in this folder:
- Blender world is Z-up, metres. Characters face -Y in Blender, which the glTF
  exporter turns into +Z (glTF is Y-up: (x, y, z)_blender -> (x, z, -y)_gltf).
- The rebuilt rig ("Rig" object at identity) keeps the original Biped bone names
  and adds the Biped root "Bip01" as a real bone (the FBX importer turns that node
  into the armature object; we need it as a bone so it can carry root motion).
- Bone frames are the FBX node frames as imported with automatic bone orientation
  OFF, so they are identical across avatars and animation files of one gender.
"""
import bpy
import json
import math
import os
import sys
from mathutils import Matrix, Quaternion, Vector

RIG_NAME = 'Rig'
ROOT = 'Bip01'


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 30
    sc.render.fps_base = 1.0


def import_fbx(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(
        filepath=path,
        use_anim=True,
        automatic_bone_orientation=False,
        ignore_leaf_bones=False,
        use_custom_normals=True,
        use_image_search=False,
    )
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    meshes = [o for o in new if o.type == 'MESH']
    return arm, meshes, new


def norm_mat(m):
    """Drop scale from a 4x4 world matrix (keep translation + rotation)."""
    loc, rot, _ = m.decompose()
    return Matrix.Translation(loc) @ rot.to_matrix().to_4x4()


def skeleton_from_avatar(arm):
    """Rest skeleton of an imported avatar, in world metres.

    Returns {'order': [names parent-first], 'parent': {name: parent},
             'rest': {name: 4x4 matrix}, 'length': {name: metres}}.
    """
    mw = arm.matrix_world
    order, parent, rest, length = [ROOT], {ROOT: None}, {}, {}
    rest[ROOT] = norm_mat(mw.copy())
    length[ROOT] = 0.1

    def walk(b):
        order.append(b.name)
        parent[b.name] = b.parent.name if b.parent else ROOT
        rest[b.name] = norm_mat(mw @ b.matrix_local)
        length[b.name] = max(0.01, ((mw @ b.tail_local) - (mw @ b.head_local)).length)
        for c in b.children:
            walk(c)

    for b in arm.data.bones:
        if b.parent is None:
            walk(b)
    return {'order': order, 'parent': parent, 'rest': rest, 'length': length}


def skeleton_to_json(sk):
    return {
        'order': sk['order'],
        'parent': sk['parent'],
        'rest': {k: [list(r) for r in v] for k, v in sk['rest'].items()},
        'length': sk['length'],
    }


def skeleton_from_json(d):
    return {
        'order': d['order'],
        'parent': d['parent'],
        'rest': {k: Matrix(v) for k, v in d['rest'].items()},
        'length': d['length'],
    }


def build_rig(sk, deform=None, name=RIG_NAME):
    data = bpy.data.armatures.new(name)
    rig = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(rig)
    for o in bpy.data.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    ebs = {}
    for n in sk['order']:
        eb = data.edit_bones.new(n)
        eb.head = (0, 0, 0)
        eb.tail = (0, sk['length'][n], 0)
        eb.matrix = sk['rest'][n]
        p = sk['parent'][n]
        if p:
            eb.parent = ebs[p]
            eb.use_connect = False
        eb.use_deform = (deform is None) or (n in deform)
        ebs[n] = eb
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    # sanity: rebuilt rest frames must match the requested ones
    worst = 0.0
    for n in sk['order']:
        a = rig.data.bones[n].matrix_local
        b = sk['rest'][n]
        worst = max(worst, (a.to_translation() - b.to_translation()).length,
                    a.to_quaternion().rotation_difference(b.to_quaternion()).angle)
    if worst > 1e-3:
        raise RuntimeError(f'rig rebuild drifted by {worst}')
    return rig


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(obj, f, indent=1)


def read_json(path):
    with open(path) as f:
        return json.load(f)


def args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def remove_objects(objs):
    for o in list(objs):
        if o and o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)


def purge():
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.actions, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            if item.users == 0:
                coll.remove(item)
