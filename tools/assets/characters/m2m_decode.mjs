// Decode the Mesh2Motion GLBs (EXT_meshopt_compression) into plain GLBs that
// Blender's importer can read. Build-time only; nothing compressed ships.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function decodeM2M(srcFiles, outDir) {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  await mkdir(outDir, { recursive: true });
  const out = {};
  for (const file of srcFiles) {
    const doc = await io.read(file);
    for (const ext of doc.getRoot().listExtensionsUsed()) ext.dispose();
    const dst = path.join(outDir, path.basename(file));
    await io.write(dst, doc);
    out[path.basename(file, '.glb')] = dst;
  }
  return out;
}
