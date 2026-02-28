import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { WORLD } from "./constants.js";

export function createWorld(scene) {
  const world = new THREE.Group();
  scene.add(world);

  const gy = (x, z) => ((Math.sin(x * 0.04) + Math.cos(z * 0.037)) * 0.8) * (1 - Math.exp(-(x * x) / 260));

  const terrainGeo = new THREE.PlaneGeometry(640, 640, 180, 180);
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

  const colliders = [];
  const aabbs = [];
  const addCollider = (m) => {
    colliders.push(m);
    aabbs.push(new THREE.Box3().setFromObject(m));
  };
  const put = (m, x, z, y = 0) => m.position.set(x, gy(x, z) + y, z);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x374252, roughness: 0.95, transparent: true, opacity: 0 });
  function wall(x, z, sx, sy, sz) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), wallMat);
    put(m, x, z, sy / 2);
    world.add(m);
    addCollider(m);
  }
  wall(0, -150, 320, 10, 10);
  wall(0, 150, 320, 10, 10);
  wall(-150, 0, 10, 10, 320);
  wall(150, 0, 10, 10, 320);

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

  // Open-top cave vibe: rocky perimeter ring with varied heights and occasional tall stacks.
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const radius = 136 + Math.sin(i * 0.9) * 6 + (Math.random() - 0.5) * 8;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius * 0.96;
    if (Math.hypot(x, z - WORLD.NEST_Z) < nestClearRadius) continue;
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

  // Cliff chunks to create heavier silhouettes.
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + Math.random() * 0.2;
    const radius = 126 + Math.random() * 10;
    const sx = 12 + Math.random() * 10;
    const sy = 14 + Math.random() * 18;
    const sz = 8 + Math.random() * 9;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius * 0.94;
    if (Math.hypot(x, z - WORLD.NEST_Z) < nestClearRadius + 10) continue;
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), cliffMat);
    m.rotation.y = a + Math.random() * 0.6;
    put(m, x, z, sy * 0.5);
    world.add(m);
    addCollider(m);
  }

  for (let i = 0; i < 24; i++) {
    const x = (Math.random() * 2 - 1) * 100;
    const z = (Math.random() * 2 - 1) * 85;
    if (Math.abs(x) < 16) continue;
    const c = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 2, 2.4),
      new THREE.MeshStandardMaterial({ color: 0x4a3f34, roughness: 0.9 })
    );
    put(c, x, z, 1);
    world.add(c);
    addCollider(c);
  }

  const railMat = new THREE.MeshStandardMaterial({ color: 0x69778b, roughness: 0.55, metalness: 0.7 });
  const r1 = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.18, WORLD.TRACK_START - WORLD.TRACK_END + 6), railMat);
  const r2 = r1.clone();
  r1.position.set(-2, gy(-2, 0) + 0.17, (WORLD.TRACK_START + WORLD.TRACK_END) / 2);
  r2.position.set(2, gy(2, 0) + 0.17, (WORLD.TRACK_START + WORLD.TRACK_END) / 2);
  world.add(r1, r2);

  for (let z = WORLD.TRACK_END; z <= WORLD.TRACK_START; z += 4) {
    const s = new THREE.Mesh(
      new THREE.BoxGeometry(5.2, 0.25, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x3c2b22, roughness: 1 })
    );
    s.position.set(0, gy(0, z) + 0.1, z);
    world.add(s);
  }

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
  core.position.set(0, gy(0, WORLD.NEST_Z) + 4.9, WORLD.NEST_Z);
  nest.add(core);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const r = 12 + Math.random() * 6;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const p = new THREE.Mesh(
      new THREE.DodecahedronGeometry(2.1 + Math.random() * 1.2, 0),
      nestPodMat
    );
    put(p, x, WORLD.NEST_Z + z, 1.2 + Math.random() * 0.4);
    nest.add(p);
  }

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

  const cart = { p: 0, fwd: 7.5, back: 2.0, rad: 8.2 };
  const setCar = () => {
    const z = THREE.MathUtils.lerp(WORLD.TRACK_START, WORLD.TRACK_END, cart.p);
    car.position.set(0, gy(0, z) + 1.7, z);
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
  };
}
