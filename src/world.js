import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { WORLD } from "./constants.js";

export async function createWorld(scene) {
  const world = new THREE.Group();
  scene.add(world);

  // ── Build S-curve track from waypoints ──────────────────────────────
  const waypoints = WORLD.TRACK_WAYPOINTS.map(
    (p) => new THREE.Vector3(p.x, p.y, p.z)
  );
  const trackPath = new THREE.CatmullRomCurve3(waypoints, false, "catmullrom", 0.5);
  const trackLength = trackPath.getLength();

  // Pre-compute sample points for fast distance lookups (used by gy and nearestTrackProgress)
  const TRACK_SAMPLES = 200;
  const trackSamples = [];
  for (let i = 0; i <= TRACK_SAMPLES; i++) {
    const t = i / TRACK_SAMPLES;
    const pt = trackPath.getPointAt(t);
    trackSamples.push({ t, x: pt.x, z: pt.z });
  }

  function getTrackPoint(t) {
    return trackPath.getPointAt(Math.max(0, Math.min(1, t)));
  }
  function getTrackTangent(t) {
    return trackPath.getTangentAt(Math.max(0, Math.min(1, t)));
  }

  // Find nearest progress value on track for a world position
  function nearestTrackProgress(x, z) {
    let bestT = 0;
    let bestDist = Infinity;
    for (const s of trackSamples) {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestT = s.t;
      }
    }
    return { t: bestT, dist: Math.sqrt(bestDist) };
  }

  // Distance from point to nearest track sample (squared, for perf)
  function distToTrackSq(x, z) {
    let best = Infinity;
    for (const s of trackSamples) {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < best) best = d;
    }
    return best;
  }

  // ── Terrain height ──────────────────────────────────────────────────
  const TRACK_FLATTEN_RADIUS = 14; // flatten terrain within this distance of track
  const TRACK_FLATTEN_RADIUS_SQ = TRACK_FLATTEN_RADIUS * TRACK_FLATTEN_RADIUS;

  const gy = (x, z) => {
    const base = ((Math.sin(x * 0.04) + Math.cos(z * 0.037)) * 0.8);
    const dSq = distToTrackSq(x, z);
    if (dSq < TRACK_FLATTEN_RADIUS_SQ) {
      const blend = Math.sqrt(dSq) / TRACK_FLATTEN_RADIUS;
      return base * blend * blend;
    }
    return base;
  };

  // ── Terrain mesh ────────────────────────────────────────────────────
  const terrainGeo = new THREE.PlaneGeometry(1000, 1000, 220, 220);
  terrainGeo.rotateX(-Math.PI / 2);
  const tp = terrainGeo.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const x = tp.getX(i);
    const z = tp.getZ(i);
    tp.setY(i, gy(x, z));
  }
  terrainGeo.computeVertexNormals();
  const sandTex = new THREE.TextureLoader().load("./assets/sand.png");
  sandTex.wrapS = THREE.RepeatWrapping;
  sandTex.wrapT = THREE.RepeatWrapping;
  sandTex.repeat.set(26, 26);
  sandTex.colorSpace = THREE.SRGBColorSpace;
  sandTex.anisotropy = 8;
  world.add(
    new THREE.Mesh(
      terrainGeo,
      new THREE.MeshStandardMaterial({ color: 0x8a7d68, roughness: 1, metalness: 0, map: sandTex })
    )
  );

  // ── Colliders ───────────────────────────────────────────────────────
  const colliders = [];
  const aabbs = [];
  const addCollider = (m) => {
    colliders.push(m);
    aabbs.push(new THREE.Box3().setFromObject(m));
  };
  const put = (m, x, z, y = 0) => m.position.set(x, gy(x, z) + y, z);

  // Invisible boundary walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x374252, roughness: 0.95, transparent: true, opacity: 0 });
  function boundaryWall(x, z, sx, sy, sz) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), wallMat);
    put(m, x, z, sy / 2);
    world.add(m);
    addCollider(m);
  }
  boundaryWall(0, -260, 540, 10, 10);
  boundaryWall(0, 260, 540, 10, 10);
  boundaryWall(-260, 0, 10, 10, 540);
  boundaryWall(260, 0, 10, 10, 540);

  // ── Rocks ───────────────────────────────────────────────────────────
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x3a332c, roughness: 0.98, metalness: 0.02 });
  const cliffMat = new THREE.MeshStandardMaterial({ color: 0x2d2823, roughness: 1, metalness: 0 });
  const nestClearRadius = 42;

  function addRock(x, z, sx, sy, sz, rotY = 0) {
    const g = new THREE.DodecahedronGeometry(1, 0);
    g.scale(sx, sy, sz);
    const m = new THREE.Mesh(g, rockMat);
    m.rotation.set((Math.random() - 0.5) * 0.35, rotY, (Math.random() - 0.5) * 0.25);
    put(m, x, z, sy * 0.9);
    world.add(m);
    addCollider(m);
  }

  // Perimeter ring
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    const radius = 240 + Math.sin(i * 0.9) * 6 + (Math.random() - 0.5) * 8;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius * 0.96;
    if (Math.hypot(x - WORLD.NEST_X, z - WORLD.NEST_Z) < nestClearRadius) continue;
    const h = 7 + Math.random() * 9;
    addRock(x, z, 5 + Math.random() * 4, h, 5 + Math.random() * 4, a + Math.PI * 0.5);
    if (Math.random() < 0.28) {
      addRock(
        x * 0.95 + (Math.random() - 0.5) * 4,
        z * 0.95 + (Math.random() - 0.5) * 4,
        4 + Math.random() * 3,
        h + 5 + Math.random() * 8,
        4 + Math.random() * 3,
        a
      );
    }
  }

  // Cliff chunks
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2 + Math.random() * 0.2;
    const radius = 230 + Math.random() * 10;
    const sx = 12 + Math.random() * 10;
    const sy = 14 + Math.random() * 18;
    const sz = 8 + Math.random() * 9;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius * 0.94;
    if (Math.hypot(x - WORLD.NEST_X, z - WORLD.NEST_Z) < nestClearRadius + 10) continue;
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), cliffMat);
    m.rotation.y = a + Math.random() * 0.6;
    put(m, x, z, sy * 0.5);
    world.add(m);
    addCollider(m);
  }

  // Scattered egg sacs — avoid track
  const eggSacPositions = [];
  for (let i = 0; i < 48; i++) {
    const ex = (Math.random() * 2 - 1) * 200;
    const ez = (Math.random() * 2 - 1) * 190;
    if (distToTrackSq(ex, ez) < 16 * 16) continue;
    eggSacPositions.push({ x: ex, z: ez, rotY: Math.random() * Math.PI * 2 });
  }
  {
    const { GLTFLoader } = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js/+esm");
    const gltfLoader = new GLTFLoader();
    const gltf = await gltfLoader.loadAsync("./assets/Egg-sac.glb");
    // Extract geometries from loaded scene, replace materials with tinted ones
    const eggSacMats = {
      Flesh: new THREE.MeshStandardMaterial({
        color: 0x8b3a3a,
        roughness: 0.75,
        metalness: 0,
        emissive: 0x2a0808,
        emissiveIntensity: 0.4,
      }),
      Egg: new THREE.MeshStandardMaterial({
        color: 0xc8a86e,
        roughness: 0.5,
        metalness: 0,
        emissive: 0x1a0e04,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.85,
      }),
    };
    const srcParts = [];
    gltf.scene.traverse((child) => {
      if (child.isMesh) {
        const mat = eggSacMats[child.material.name] || eggSacMats.Flesh;
        srcParts.push({ geo: child.geometry, mat });
      }
    });
    for (const pos of eggSacPositions) {
      const group = new THREE.Group();
      for (const part of srcParts) {
        const m = new THREE.Mesh(part.geo, part.mat);
        group.add(m);
      }
      group.scale.setScalar(2);
      group.rotation.y = pos.rotY;
      group.position.set(pos.x, gy(pos.x, pos.z), pos.z);
      world.add(group);
    }
  }

  // ── Rails along the curve ───────────────────────────────────────────
  const railMat = new THREE.MeshStandardMaterial({ color: 0x69778b, roughness: 0.55, metalness: 0.7 });
  const RAIL_SEG_LEN = 2;
  const railSegCount = Math.ceil(trackLength / RAIL_SEG_LEN);
  const railGeo = new THREE.BoxGeometry(0.35, 0.18, RAIL_SEG_LEN + 0.1);

  for (let i = 0; i < railSegCount; i++) {
    const t = (i + 0.5) / railSegCount;
    const pt = trackPath.getPointAt(t);
    const tan = trackPath.getTangentAt(t);
    const angle = Math.atan2(tan.x, tan.z);

    // Perpendicular offset for the two rails (±2 units)
    const perpX = Math.cos(angle);
    const perpZ = -Math.sin(angle);

    for (const side of [-2, 2]) {
      const rx = pt.x + perpX * side;
      const rz = pt.z + perpZ * side;
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.position.set(rx, gy(rx, rz) + 0.17, rz);
      rail.rotation.y = angle;
      world.add(rail);
    }
  }

  // ── Sleepers along the curve ────────────────────────────────────────
  const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x3c2b22, roughness: 1 });
  const sleeperGeo = new THREE.BoxGeometry(5.2, 0.25, 0.55);
  const SLEEPER_SPACING = 4;
  const sleeperCount = Math.floor(trackLength / SLEEPER_SPACING);

  for (let i = 0; i <= sleeperCount; i++) {
    const t = i / sleeperCount;
    const pt = trackPath.getPointAt(t);
    const tan = trackPath.getTangentAt(t);
    const angle = Math.atan2(tan.x, tan.z);

    const sleeper = new THREE.Mesh(sleeperGeo, sleeperMat);
    sleeper.position.set(pt.x, gy(pt.x, pt.z) + 0.1, pt.z);
    sleeper.rotation.y = angle;
    world.add(sleeper);
  }

  // ── Nest ────────────────────────────────────────────────────────────
  const nest = new THREE.Group();
  world.add(nest);
  const nestTex = new THREE.TextureLoader().load("./assets/nest.png");
  nestTex.wrapS = THREE.RepeatWrapping;
  nestTex.wrapT = THREE.RepeatWrapping;
  nestTex.repeat.set(1.5, 1.5);
  nestTex.colorSpace = THREE.SRGBColorSpace;
  const nestCoreMat = new THREE.MeshStandardMaterial({
    color: 0xb08a7a,
    roughness: 0.88,
    emissive: 0x2a0e08,
    emissiveIntensity: 0.9,
    map: nestTex,
  });
  const nestPodMat = new THREE.MeshStandardMaterial({
    color: 0xa17163,
    roughness: 0.95,
    map: nestTex,
  });
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(8.4, 24, 20),
    nestCoreMat
  );
  core.position.set(WORLD.NEST_X, gy(WORLD.NEST_X, WORLD.NEST_Z) + 4.9, WORLD.NEST_Z);
  nest.add(core);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const r = 12 + Math.random() * 6;
    const px = WORLD.NEST_X + Math.cos(a) * r;
    const pz = WORLD.NEST_Z + Math.sin(a) * r;
    const p = new THREE.Mesh(
      new THREE.DodecahedronGeometry(2.1 + Math.random() * 1.2, 0),
      nestPodMat
    );
    put(p, px, pz, 1.2 + Math.random() * 0.4);
    nest.add(p);
  }

  // ── Cart ────────────────────────────────────────────────────────────
  const rustyMetalTex = new THREE.TextureLoader().load("./assets/rustymetal.png");
  rustyMetalTex.wrapS = THREE.RepeatWrapping;
  rustyMetalTex.wrapT = THREE.RepeatWrapping;
  rustyMetalTex.repeat.set(1.8, 1.4);
  rustyMetalTex.colorSpace = THREE.SRGBColorSpace;

  const car = new THREE.Group();
  world.add(car);
  const carMat = new THREE.MeshStandardMaterial({
    color: 0xc9c1b6,
    roughness: 0.7,
    metalness: 0.35,
    map: rustyMetalTex,
  });
  car.add(new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.7, 6.2), carMat));
  const roof = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.35, 5.4), carMat);
  roof.position.y = 1.5;
  car.add(roof);
  for (const x of [-1.7, 1.7]) {
    for (const z of [-2.4, 2.4]) {
      const w = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.42, 0.35, 12),
        new THREE.MeshStandardMaterial({ color: 0x20262e, roughness: 0.45, metalness: 0.6 })
      );
      w.rotation.z = Math.PI / 2;
      w.position.set(x, -1.18, z);
      car.add(w);
    }
  }

  // Load bomb model and place on top of cart
  {
    const { GLTFLoader: BombLoader } = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js/+esm");
    const bombLoader = new BombLoader();
    const bombGltf = await bombLoader.loadAsync("./assets/bomb.glb");
    const bomb = bombGltf.scene;
    bomb.position.set(0, 2.2, 0);
    bomb.rotation.y = Math.PI;
    car.add(bomb);
  }

  const cart = { p: 0, fwd: 7.5, back: 2.0, rad: 8.2 };
  const setCar = () => {
    const pt = getTrackPoint(cart.p);
    const tan = getTrackTangent(cart.p);
    const angle = Math.atan2(tan.x, tan.z);
    car.position.set(pt.x, gy(pt.x, pt.z) + 1.7, pt.z);
    car.rotation.y = angle;
  };
  setCar();

  return {
    world,
    gy,
    colliders,
    aabbs,
    car,
    cart,
    setCar,
    trackPath,
    trackLength,
    getTrackPoint,
    getTrackTangent,
    nearestTrackProgress,
  };
}
