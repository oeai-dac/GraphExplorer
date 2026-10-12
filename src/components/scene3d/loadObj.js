// Turns dropped/picked files into the model the store keeps for the 3D tab.

import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { parseOriginHint } from '../../lib/scene3d'

/**
 * `files`: a FileList/array holding one .obj and optionally its .mtl.
 * Resolves to { fileName, group, hint } -- hint is the origin read from the
 * OBJ header (see parseOriginHint), or null.
 */
export async function loadObjFiles(files) {
  const list = [...files]
  const obj = list.find((f) => /\.obj$/i.test(f.name))
  if (!obj) throw new Error('Please choose an .obj file (and its .mtl, if it has one).')
  const mtl = list.find((f) => /\.mtl$/i.test(f.name))
  return parseObj(obj.name, await obj.text(), mtl ? await mtl.text() : null)
}

/** Same from text already in hand (the web build's example model). */
export function parseObj(fileName, objText, mtlText) {
  const loader = new OBJLoader()
  if (mtlText) {
    // Colours only for now. A texture (map_Kd ...) would be fetched relative
    // to the page, where the image is not -- from a local file that's a
    // failed request per texture and nothing gained.
    const creator = new MTLLoader().parse(mtlText.replace(/^\s*map_\w+.*$/gim, ''), '')
    creator.preload()
    loader.setMaterials(creator)
  }
  const group = loader.parse(objText)
  return { fileName, group, hint: parseOriginHint(objText) }
}
