export const WORLD = {
  TRACK_WAYPOINTS: [
    { x: -120, y: 0, z: 170 },
    { x: -120, y: 0, z: 105 },
    { x:  120, y: 0, z: 85 },
    { x:  120, y: 0, z: 25 },
    { x: -120, y: 0, z: 5 },
    { x: -120, y: 0, z: -60 },
    { x:  120, y: 0, z: -80 },
    { x:  120, y: 0, z: -140 },
    { x: -120, y: 0, z: -160 },
  ],
  NEST_X: -120,
  NEST_Z: -180,
  SPAWN_X: -120,
  SPAWN_Z: 180,
  SPAWN_YAW: Math.PI,
  SPAWN_SAFE_RADIUS: 9,
  SPAWN_POINTS: [
    { x: -123.5, z: 180, yaw: Math.PI },
    { x: -116.5, z: 180, yaw: Math.PI },
    { x: -123.5, z: 186, yaw: Math.PI },
    { x: -116.5, z: 186, yaw: Math.PI },
  ],
  FPS_COLORS: [0x00cc44, 0x2288ff, 0xddcc00, 0xff8800],
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

export const RTS = {
  BIOMASS_START: 100,
  BIOMASS_MAX: 200,
  BIOMASS_REGEN: 8,
  BASIC_BUG_COST: 20,
  BASIC_BUG_HP: 70,
  BASIC_BUG_SPEED: 6,
  SPAWN_COOLDOWN: 0.5,
  TIME_LIMIT: 600,
  ACID_BUG_COST: 60,
  ACID_BUG_HP: 50,
  ACID_BUG_SPEED: 7,
  ACID_BUG_COOLDOWN: 15,
  ACID_BLIND_RADIUS: 18,
  ACID_BLIND_DURATION: 6,
  WALL_COST: 80,
  WALL_HP: 1200,
  WALL_COOLDOWN: 25,
  WALL_WIDTH: 10,
  WALL_HEIGHT: 4,
  WALL_DEPTH: 2,
};
