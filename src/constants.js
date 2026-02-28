export const WORLD = {
  SPAWN_X: -3.5,
  SPAWN_Z: 116,
  SPAWN_YAW: 0,
  SPAWN_SAFE_RADIUS: 9,
  NEST_Z: -120,
  TRACK_START: 112,
  TRACK_END: -112,
};

export const ASSETS = {
  // Set to a local/hosted .glb or .gltf path when you have a custom gun model.
  gunModelUrl: "./assets/smg.glb",
  // Optional texture path (png/jpg/webp). Applied to all gun meshes.
  gunTextureUrl: null,
  // If your model has a muzzle node, name it here.
  gunMuzzleNodeName: "Muzzle",
  // Optional node names for slide and ejection port.
  gunSlideNodeName: "Slide",
  gunEjectNodeName: "Eject",
  gunSlideTravel: 0.06,
  // Tune this to fit your imported model in first-person view.
  gunScale: 0.14,
  // Euler rotation in radians to orient imported weapon model.
  gunRotation: { x: 0, y: Math.PI + 0.11, z: 0 },
};
