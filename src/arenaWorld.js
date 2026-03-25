import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const PLAT_W = 44;
const PLAT_D = 44;
const PLAT_H = 2.5;

export const FALL_THRESHOLD = -5;

export const ARENA_SPAWN_POINTS = [
  { x:  0,   z:  16, yaw: 0 },              // south edge → face north
  { x:  0,   z: -16, yaw: Math.PI },         // north edge → face south
  { x:  16,  z:  0,  yaw:  Math.PI / 2 },   // east edge → face west
  { x: -16,  z:  0,  yaw: -Math.PI / 2 },   // west edge → face east
];

export function createArenaWorld(scene) {
  const world = new THREE.Group();
  scene.add(world);

  const tl = new THREE.TextureLoader();

  // ── Platform surface ────────────────────────────────────────────────────
  const sandTex = tl.load("./assets/sand.png");
  sandTex.colorSpace = THREE.SRGBColorSpace;
  sandTex.wrapS = sandTex.wrapT = THREE.RepeatWrapping;
  sandTex.repeat.set(6, 6);
  const platMat = new THREE.MeshStandardMaterial({ map: sandTex, roughness: 0.88 });
  const platGeo = new THREE.BoxGeometry(PLAT_W, PLAT_H, PLAT_D);
  const platform = new THREE.Mesh(platGeo, platMat);
  platform.position.set(0, -PLAT_H / 2, 0); // top face at y=0
  world.add(platform);

  // ── Edge trim ───────────────────────────────────────────────────────────
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x7a5c38, roughness: 0.75 });
  const TRIM_H = 0.28;
  const TRIM_T = 0.42;
  const edgeDefs = [
    { pos: [0, TRIM_H / 2, PLAT_D / 2 + TRIM_T / 2], sx: PLAT_W, sy: TRIM_H, sz: TRIM_T },
    { pos: [0, TRIM_H / 2, -(PLAT_D / 2 + TRIM_T / 2)], sx: PLAT_W, sy: TRIM_H, sz: TRIM_T },
    { pos: [PLAT_W / 2 + TRIM_T / 2, TRIM_H / 2, 0], sx: TRIM_T, sy: TRIM_H, sz: PLAT_D },
    { pos: [-(PLAT_W / 2 + TRIM_T / 2), TRIM_H / 2, 0], sx: TRIM_T, sy: TRIM_H, sz: PLAT_D },
  ];
  for (const e of edgeDefs) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(e.sx, e.sy, e.sz), edgeMat);
    m.position.set(...e.pos);
    world.add(m);
  }

  // ── Corner pillars ──────────────────────────────────────────────────────
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x6a4c2a, roughness: 0.8 });
  for (const [cx, cz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.52, 2.0, 8), pillarMat);
    pillar.position.set(cx * PLAT_W / 2, 1.0, cz * PLAT_D / 2);
    world.add(pillar);
  }

  // ── Spawn markers ───────────────────────────────────────────────────────
  const FPS_COLORS = [0x00cc44, 0x0088ff, 0xff4400, 0xffcc00];
  for (let i = 0; i < ARENA_SPAWN_POINTS.length; i++) {
    const sp = ARENA_SPAWN_POINTS[i];
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.9, 24),
      new THREE.MeshBasicMaterial({ color: FPS_COLORS[i], transparent: true, opacity: 0.4, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(sp.x, 0.02, sp.z);
    world.add(ring);
  }

  // ── Floating platforms ──────────────────────────────────────────────────
  const floatPlatMat = new THREE.MeshStandardMaterial({ color: 0x4a6a8a, roughness: 0.7, metalness: 0.2 });
  const floatEdgeMat = new THREE.MeshStandardMaterial({ color: 0x00b4ff, emissive: 0x003366, roughness: 0.5 });
  const FLOAT_PLATS = [
    { x:  14, y: 10, z:  14, w: 7, d: 7 },
    { x: -14, y: 10, z: -14, w: 7, d: 7 },
    { x:  0,  y: 16, z:  0,  w: 6, d: 6 },
    { x: -14, y: 12, z:  14, w: 5, d: 5 },
    { x:  14, y: 12, z: -14, w: 5, d: 5 },
  ];
  const FLOAT_H = 0.6;

  for (const fp of FLOAT_PLATS) {
    const geo = new THREE.BoxGeometry(fp.w, FLOAT_H, fp.d);
    const mesh = new THREE.Mesh(geo, floatPlatMat);
    mesh.position.set(fp.x, fp.y - FLOAT_H / 2, fp.z);
    world.add(mesh);

    // Glowing edge trim
    const trimH = 0.08;
    const trimT = 0.12;
    const edges = [
      { pos: [fp.x, fp.y - trimH / 2, fp.z + fp.d / 2 + trimT / 2], sx: fp.w, sy: trimH, sz: trimT },
      { pos: [fp.x, fp.y - trimH / 2, fp.z - fp.d / 2 - trimT / 2], sx: fp.w, sy: trimH, sz: trimT },
      { pos: [fp.x + fp.w / 2 + trimT / 2, fp.y - trimH / 2, fp.z], sx: trimT, sy: trimH, sz: fp.d },
      { pos: [fp.x - fp.w / 2 - trimT / 2, fp.y - trimH / 2, fp.z], sx: trimT, sy: trimH, sz: fp.d },
    ];
    for (const e of edges) {
      const em = new THREE.Mesh(new THREE.BoxGeometry(e.sx, e.sy, e.sz), floatEdgeMat);
      em.position.set(...e.pos);
      world.add(em);
    }
  }

  // gy: check floating platforms (highest below player wins), then main platform
  // playerY is optional — if provided, only return platforms the player is above
  function gy(x, z, playerY) {
    let best = -9999;
    // Main platform
    if (Math.abs(x) < PLAT_W / 2 && Math.abs(z) < PLAT_D / 2) best = 0;
    // Floating platforms — only land if player feet are at or above platform top
    for (const fp of FLOAT_PLATS) {
      if (Math.abs(x - fp.x) < fp.w / 2 && Math.abs(z - fp.z) < fp.d / 2) {
        if (fp.y > best && (playerY === undefined || playerY >= fp.y)) best = fp.y;
      }
    }
    return best;
  }

  return {
    world,
    gy,
    aabbs: [],
    colliders: [],
    PLAT_W,
    PLAT_D,
  };
}
