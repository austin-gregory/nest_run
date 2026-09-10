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
  SPAWN_X: -86.6,
  SPAWN_Z: 145,
  SPAWN_YAW: 0,
  SPAWN_SAFE_RADIUS: 9,
  SPAWN_POINTS: [
    { x: -90.1, z: 145, yaw: 0 },
    { x: -83.1, z: 145, yaw: 0 },
    { x: -90.1, z: 139, yaw: 0 },
    { x: -83.1, z: 139, yaw: 0 },
  ],
  FPS_COLORS: [0x00cc44, 0x2288ff, 0xddcc00, 0xff8800],
  SHIP_X: -86.6,
  SHIP_Z: 160,
  SHIP_YAW: 0,
  SHIP_SCALE: 11,
  SHIP_INTRO_SKY_HEIGHT: 200,
  SHIP_INTRO_DESCEND: 5.5,
  SHIP_INTRO_HOLD: 0.8,
  SHIP_INTRO_JUMP: 1.6,
  // Fixed 3rd-person spectator camera (offset from the ship's resting position) that watches it land.
  SHIP_INTRO_CAM_OFFSET_X: 34,
  SHIP_INTRO_CAM_OFFSET_Y: 16,
  SHIP_INTRO_CAM_OFFSET_Z: 22,
  // Interior lobby scene, shown while waiting for players / before "Start Solo".
  // Parked far above the play area so it never overlaps real terrain/gameplay.
  LOBBY_X: 0,
  LOBBY_Y: 900,
  LOBBY_Z: 0,
  LOBBY_SCALE: 11,
  LOBBY_YAW: 0,
  LOBBY_CAM_EYE_HEIGHT: 1.7,
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

export const FORCE_GUN_ASSETS = {
  gunModelUrl: "./assets/force_gun.glb",
  gunTextureUrl: null,
  gunMuzzleNodeName: null,
  gunSlideNodeName: null,
  gunEjectNodeName: null,
  gunSlideTravel: 0.04,
  gunScale: 0.50,
  gunRotation: { x: 0, y: Math.PI + Math.PI / 2, z: 0 },
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
  ACID_BLIND_RADIUS: 6,
  ACID_BLIND_DURATION: 2,
  WALL_COST: 80,
  WALL_HP: 1200,
  WALL_COOLDOWN: 25,
  WALL_WIDTH: 10,
  WALL_HEIGHT: 4,
  WALL_DEPTH: 2,
  SPEED_BOOST_DURATION: 20,
  SPEED_BOOST_MAX_USES: 2,
  EGG_TRAP_RADIUS: 40,
  EGG_TRAP_HOLD_DURATION: 5,
  EGG_TRAP_PULL_SPEED: 25,
  EGG_TRAP_COST: 40,
  EGG_TRAP_DAMAGE: 100,
  EGG_TRAP_STOP_DIST: 4,
  EGG_TRAP_HP: 200,
  DORMANT_WAKE_RADIUS: 15,
};
