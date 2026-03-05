import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { ASSETS, WORLD, RTS } from "./constants.js";
import { createUI } from "./ui.js";
import { attachInput } from "./input.js";
import { createWorld } from "./world.js";
import { createWeaponView } from "./weaponView.js";
import { connectToGame, createRoom, joinRoom } from "./network.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export async function initGame() {
  const ui = createUI();

  const scene = new THREE.Scene();
  const skyTex = new THREE.TextureLoader().load("./assets/sky.png");
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;
  scene.fog = new THREE.Fog(0x2d1f16, 26, 300);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(94, innerWidth / innerHeight, 0.05, 900);
  scene.add(new THREE.HemisphereLight(0xffc98a, 0x2a1b13, 0.62));
  const sun = new THREE.DirectionalLight(0xffb15c, 1.35);
  sun.position.set(120, 180, 30);
  scene.add(sun);

  const map = createWorld(scene);
  const weaponView = await createWeaponView(scene, ASSETS);

  // ── Alien-bug model + texture pre-load ──────────────────────────────────
  let bugGLTF = null, bugBaseMat = null, skeletonClone = null;
  const BUG_SCALE = 3.0;
  {
    const [{ GLTFLoader }, su] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js/+esm"),
      import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/utils/SkeletonUtils.js/+esm"),
    ]);
    skeletonClone = su.clone;
    const loader = new GLTFLoader();
    bugGLTF = await loader.loadAsync("./assets/alien-bug.glb");
    const tl = new THREE.TextureLoader();
    const [diff, rough, norm] = await Promise.all([
      tl.loadAsync("./assets/tex/bug-d.png"),
      tl.loadAsync("./assets/tex/bug-rought.png"),
      tl.loadAsync("./assets/tex/bug-norm.png"),
    ]);
    diff.colorSpace = THREE.SRGBColorSpace;
    bugBaseMat = new THREE.MeshStandardMaterial({
      map: diff, roughnessMap: rough, normalMap: norm, roughness: 1, metalness: 0,
    });
  }
  // ────────────────────────────────────────────────────────────────────────

  const player = {
    pos: new THREE.Vector3(
      WORLD.SPAWN_X,
      map.gy(WORLD.SPAWN_X, WORLD.SPAWN_Z) + 1.75,
      WORLD.SPAWN_Z
    ),
    vel: new THREE.Vector3(),
    yaw: WORLD.SPAWN_YAW,
    pitch: 0,
    ground: false,
    hp: 200,
    height: 1.75,
    r: 0.36,
    g: 22,
    j: 6.9,
    ws: 6.8,
    ss: 9.6,
    as: 6.2,
    ag: 45,
    aa: 12,
    fg: 10,
    fa: 0.35,
  };

  const game = { win: false, started: false, deaths: 0, kills: 0, resp: false, respT: 0, spawnT: 0, deathRoll: 0, elapsed: 0, startTime: 0 };
  const weapon = {
    rate: 11.2,
    hip: 0.011,
    ads: 0.0032,
    dmg: 36,
    range: 280,
    rp: 0.04,
    ry: 0.011,
    can: 0,
  };

  const input = attachInput({
    element: renderer.domElement,
    onLookDelta: (dx, dy) => {
      player.yaw += dx;
      player.pitch = clamp(player.pitch + dy, -1.45, 1.45);
    },
    onLockChange: (locked) => {
      ui.msg(locked ? "" : "Click game to lock mouse.");
    },
  });

  function hud() {
    ui.hud({
      hp: player.hp,
      maxHp: 200,
      enemies: enemies.length,
      kills: game.kills,
      deaths: game.deaths,
      progress: map.cart.p,
      elapsed: game.elapsed,
    });
  }

  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const wishMove = new THREE.Vector3();
  function wish(out) {
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
    fwd.normalize();
    right.crossVectors(fwd, up).normalize();
    out.set(0, 0, 0);
    if (input.keys.has("KeyW")) out.add(fwd);
    if (input.keys.has("KeyS")) out.sub(fwd);
    if (input.keys.has("KeyD")) out.add(right);
    if (input.keys.has("KeyA")) out.sub(right);
    if (out.lengthSq() > 0) out.normalize();
    return out;
  }
  function accel(dir, spd, a, dt) {
    const current = player.vel.dot(dir);
    const add = spd - current;
    if (add <= 0) return;
    const speed = Math.min(add, a * dt * spd);
    player.vel.addScaledVector(dir, speed);
  }
  function friction(v, dt) {
    const speed = Math.hypot(player.vel.x, player.vel.z);
    if (speed < 1e-4) return;
    const drop = speed * v * dt;
    const nextSpeed = Math.max(0, speed - drop);
    const k = nextSpeed / speed;
    player.vel.x *= k;
    player.vel.z *= k;
  }
  function collidePlayer() {
    const y = map.gy(player.pos.x, player.pos.z);
    if (player.pos.y < y + player.height) {
      player.pos.y = y + player.height;
      if (player.vel.y < 0) player.vel.y = 0;
      player.ground = true;
    } else {
      player.ground = false;
    }
    for (const b of map.aabbs) {
      const bot = player.pos.y - player.height;
      const top = player.pos.y + 0.15;
      if (!(top > b.min.y && bot < b.max.y)) continue;
      const cx = Math.max(b.min.x, Math.min(player.pos.x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(player.pos.z, b.max.z));
      const dx = player.pos.x - cx;
      const dz = player.pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= player.r * player.r) continue;
      const d = Math.max(0.00001, Math.sqrt(d2));
      const p = player.r - d;
      player.pos.x += (dx / d) * p;
      player.pos.z += (dz / d) * p;
      const nx = dx / d;
      const nz = dz / d;
      const vn = player.vel.x * nx + player.vel.z * nz;
      if (vn < 0) {
        player.vel.x -= vn * nx;
        player.vel.z -= vn * nz;
      }
    }
  }

  const gore = [];
  const gorePixelGeo = new THREE.BoxGeometry(1, 1, 1);
  const goreChunkGeo = new THREE.TetrahedronGeometry(1, 0);
  const goreMats = [
    new THREE.MeshBasicMaterial({ color: 0x7a0000 }),
    new THREE.MeshBasicMaterial({ color: 0xa00000 }),
    new THREE.MeshBasicMaterial({ color: 0xc01010 }),
    new THREE.MeshBasicMaterial({ color: 0x4a0000 }),
  ];
  const acidGoreMats = [
    new THREE.MeshBasicMaterial({ color: 0x00aa22 }),
    new THREE.MeshBasicMaterial({ color: 0x00dd44 }),
    new THREE.MeshBasicMaterial({ color: 0x33ff55 }),
    new THREE.MeshBasicMaterial({ color: 0x007a18 }),
  ];
  function spawnAcidGore(pos) {
    const chunks = 7;
    const pixels = 26;
    for (let i = 0; i < chunks + pixels; i++) {
      const isChunk = i < chunks;
      const mesh = new THREE.Mesh(
        isChunk ? goreChunkGeo : gorePixelGeo,
        acidGoreMats[Math.floor(Math.random() * acidGoreMats.length)]
      );
      const size = isChunk ? 0.12 + Math.random() * 0.14 : 0.04 + Math.random() * 0.07;
      mesh.scale.setScalar(size);
      mesh.position.set(
        pos.x + (Math.random() - 0.5) * 0.8,
        pos.y + (Math.random() - 0.5) * 0.4,
        pos.z + (Math.random() - 0.5) * 0.8
      );
      mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, 0);
      scene.add(mesh);
      const speed = isChunk ? 2.5 + Math.random() * 4 : 1.5 + Math.random() * 6;
      const angle = Math.random() * Math.PI * 2;
      const vy = isChunk ? speed * (0.4 + Math.random() * 0.9) : speed * Math.random() * 0.8;
      gore.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(angle) * speed, vy, Math.sin(angle) * speed),
        life: 0.7 + Math.random() * 1.1,
      });
    }
    while (gore.length > 300) scene.remove(gore.shift().mesh);
  }

  function spawnGore(pos) {
    const chunks = 7;
    const pixels = 26;
    for (let i = 0; i < chunks + pixels; i++) {
      const isChunk = i < chunks;
      const mesh = new THREE.Mesh(
        isChunk ? goreChunkGeo : gorePixelGeo,
        goreMats[Math.floor(Math.random() * goreMats.length)]
      );
      const size = isChunk ? 0.12 + Math.random() * 0.14 : 0.04 + Math.random() * 0.07;
      mesh.scale.setScalar(size);
      mesh.position.set(
        pos.x + (Math.random() - 0.5) * 0.8,
        pos.y + (Math.random() - 0.5) * 0.4,
        pos.z + (Math.random() - 0.5) * 0.8
      );
      mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, 0);
      scene.add(mesh);
      const speed = isChunk ? 2.5 + Math.random() * 4 : 1.5 + Math.random() * 6;
      const angle = Math.random() * Math.PI * 2;
      const vy = isChunk ? speed * (0.4 + Math.random() * 0.9) : speed * Math.random() * 0.8;
      gore.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(angle) * speed, vy, Math.sin(angle) * speed),
        life: 0.7 + Math.random() * 1.1,
      });
    }
    while (gore.length > 300) scene.remove(gore.shift().mesh);
  }

  const tracers = [];
  function spawnTracer(a, b) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
    );
    scene.add(line);
    tracers.push({ line, life: 0.06 });
  }

  const enemies = [];
  const targets = [];
  const rayTargets = [];
  const walls = []; // { id, mesh, hp, maxHp, z }

  // ── Wall (nest barrier) ──────────────────────────────────────────────
  const nestWallTex = new THREE.TextureLoader().load("./assets/nest.png");
  nestWallTex.wrapS = THREE.RepeatWrapping;
  nestWallTex.wrapT = THREE.RepeatWrapping;
  nestWallTex.repeat.set(2, 1);
  nestWallTex.colorSpace = THREE.SRGBColorSpace;

  function spawnWall(id, z, hp) {
    const geo = new THREE.BoxGeometry(RTS.WALL_WIDTH, RTS.WALL_HEIGHT, RTS.WALL_DEPTH);
    const mat = new THREE.MeshStandardMaterial({
      map: nestWallTex,
      color: 0xb08a7a,
      roughness: 0.88,
      emissive: 0x2a0e08,
      emissiveIntensity: 0.6,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const y = map.gy(0, z);
    mesh.position.set(0, y + RTS.WALL_HEIGHT / 2, z);
    mesh.userData.isWall = true;
    mesh.userData.wallId = id;
    map.world.add(mesh);
    targets.push(mesh);
    const w = { id, mesh, mat, hp, maxHp: hp, z };
    walls.push(w);
    // Add as AABB collider so players/enemies can't walk through
    const aabb = new THREE.Box3().setFromObject(mesh);
    map.aabbs.push(aabb);
    w._aabb = aabb;
    rebuildRayTargets();
    return w;
  }

  function destroyWall(id) {
    const idx = walls.findIndex((w) => w.id === id);
    if (idx < 0) return;
    const w = walls[idx];
    // Gore explosion
    const center = w.mesh.position.clone();
    center.y += RTS.WALL_HEIGHT * 0.3;
    for (let i = 0; i < 4; i++) {
      spawnGore(center.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * RTS.WALL_WIDTH,
        Math.random() * 2,
        (Math.random() - 0.5) * RTS.WALL_DEPTH * 2
      )));
    }
    // Remove from targets
    const ti = targets.indexOf(w.mesh);
    if (ti >= 0) targets.splice(ti, 1);
    // Remove AABB
    const ai = map.aabbs.indexOf(w._aabb);
    if (ai >= 0) map.aabbs.splice(ai, 1);
    map.world.remove(w.mesh);
    walls.splice(idx, 1);
    rebuildRayTargets();
  }

  function getWallBlockZ() {
    // Return the highest Z (closest to start) wall that blocks the cart
    let blockZ = null;
    for (const w of walls) {
      // Cart moves from TRACK_START (high Z) toward TRACK_END (low Z)
      // Wall blocks if the cart hasn't passed it yet
      const cartZ = THREE.MathUtils.lerp(WORLD.TRACK_START, WORLD.TRACK_END, map.cart.p);
      if (w.z < cartZ) {
        if (blockZ === null || w.z > blockZ) blockZ = w.z;
      }
    }
    return blockZ;
  }
  // ──────────────────────────────────────────────────────────────────────

  function rebuildRayTargets() {
    rayTargets.length = 0;
    for (const c of map.colliders) rayTargets.push(c);
    for (const t of targets) rayTargets.push(t);
  }

  function mkAlienBug() {
    const g = new THREE.Group();
    const model = skeletonClone(bugGLTF.scene);
    model.scale.setScalar(BUG_SCALE);
    model.rotation.y = Math.PI; // model faces -Z in GLB, game AI expects +Z as forward
    g.add(model);

    // Per-enemy material clone so hit-flash is independent per bug
    const mat = bugBaseMat.clone();
    model.traverse((obj) => { if (obj.isMesh) obj.material = mat; });

    // Animation mixer + actions
    const mixer = new THREE.AnimationMixer(model);
    const clips = bugGLTF.animations;
    const getAction = (name) => {
      const clip = THREE.AnimationClip.findByName(clips, name);
      return clip ? mixer.clipAction(clip) : null;
    };
    const actions = { idle: getAction("Idle"), run: getAction("Run"), attack: getAction("Attack.000") };
    for (const a of Object.values(actions)) if (a) a.setLoop(THREE.LoopRepeat, Infinity);
    if (actions.idle) actions.idle.play();

    // Invisible hit-proxy meshes (raycasting targets)
    const invisMat = new THREE.MeshBasicMaterial({ visible: false });
    const bodyProxy = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 6), invisMat);
    bodyProxy.position.set(0, 0.55, 0); // mid-body offset in model space
    model.add(bodyProxy);

    const headProxy = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 6), invisMat.clone());
    const headBone = model.getObjectByName("Head");
    if (headBone) headBone.add(headProxy); // follows head animation

    bodyProxy.userData.hitPart = "body";
    bodyProxy.userData.enemyRoot = g;
    headProxy.userData.hitPart = "head";
    headProxy.userData.enemyRoot = g;
    targets.push(bodyProxy, headProxy);

    return { g, model, mixer, actions, mat, bodyProxy, headProxy, curAction: "idle" };
  }

  function setEnemyAction(en, name) {
    if (en.curAction === name || !en.actions[name]) return;
    const prev = en.actions[en.curAction];
    const next = en.actions[name];
    next.reset().fadeIn(0.15).play();
    if (prev) prev.fadeOut(0.15);
    en.curAction = name;
  }

  function push(pos, r, v) {
    for (const b of map.aabbs) {
      const bottom = pos.y;
      const top = pos.y + 1.8;
      if (top < b.min.y || bottom > b.max.y) continue;
      const cx = Math.max(b.min.x, Math.min(pos.x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(pos.z, b.max.z));
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      const d = Math.max(0.00001, Math.sqrt(d2));
      const p = r - d;
      pos.x += (dx / d) * p;
      pos.z += (dz / d) * p;
      const nx = dx / d;
      const nz = dz / d;
      const vn = v.x * nx + v.z * nz;
      if (vn < 0) {
        v.x -= vn * nx;
        v.z -= vn * nz;
      }
    }
  }

  // ── Spawning ────────────────────────────────────────────────────────────
  // Network-driven spawn (used in multiplayer)
  function spawnAlienBugAt(networkId, x, z, hp, speed, bugType) {
    const m = mkAlienBug();
    m.g.position.set(x, map.gy(x, z), z);
    map.world.add(m.g);
    enemies.push({
      mesh: m.g,
      mixer: m.mixer,
      actions: m.actions,
      mat: m.mat,
      bodyProxy: m.bodyProxy,
      headProxy: m.headProxy,
      curAction: m.curAction,
      networkId,
      hp,
      bugType: bugType || "basic",
      vel: new THREE.Vector3(),
      yaw: Math.random() * Math.PI * 2,
      s: speed,
      acc: 16,
      tr: 11,
      atk: 0,
      jump: 0.9 + Math.random(),
      vy: 0,
      air: false,
      r: 0.6 * BUG_SCALE,
      flash: 0,
    });
    rebuildRayTargets();
    hud();
  }

  // Original singleplayer spawn (used as fallback)
  function spawnAlienBug() {
    const a = Math.random() * Math.PI * 2;
    const r = 7 + Math.random() * 6;
    const x = Math.cos(a) * r;
    const z = WORLD.NEST_Z + Math.sin(a) * r;
    const isAcid = Math.random() < 0.15;
    const hp = isAcid ? RTS.ACID_BUG_HP : (58 + game.deaths * 12 + Math.random() * 20);
    const s = isAcid ? RTS.ACID_BUG_SPEED : (5.4 + game.deaths * 0.25 + Math.random());
    spawnAlienBugAt(null, x, z, hp, s, isAcid ? "acid" : "basic");
  }
  // ────────────────────────────────────────────────────────────────────────

  function clearEnemies() {
    for (const e of enemies) {
      e.mixer.stopAllAction();
      map.world.remove(e.mesh);
    }
    enemies.length = 0;
    targets.length = 0;
    rebuildRayTargets();
    hud();
  }

  const rayc = new THREE.Raycaster();
  const shootDir = new THREE.Vector3();
  const fromCam = new THREE.Vector3();
  const muzzle = new THREE.Vector3();
  const muzzleDir = new THREE.Vector3();
  const laserDir = new THREE.Vector3();
  const laserUp = new THREE.Vector3();
  const laserAimFrom = new THREE.Vector3();
  const laserAimHit = new THREE.Vector3();
  const laserPoints = [new THREE.Vector3(), new THREE.Vector3()];
  const laserLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(laserPoints),
    new THREE.LineBasicMaterial({ color: 0x40ff6a, transparent: true, opacity: 0.9 })
  );
  scene.add(laserLine);

  const muzzleFlashMat = new THREE.MeshBasicMaterial({ color: 0xffd07a, transparent: true, opacity: 0 });
  const muzzleFlash = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), muzzleFlashMat);
  scene.add(muzzleFlash);
  const muzzleFlashLight = new THREE.PointLight(0xffc36a, 0, 5, 2);
  scene.add(muzzleFlashLight);
  let muzzleFlashLife = 0;
  const shellGeo = new THREE.SphereGeometry(0.03, 8, 8);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xb98a52, roughness: 0.45, metalness: 0.7 });
  const shells = [];
  const shellSpawnPos = new THREE.Vector3();
  const shellSpawnVel = new THREE.Vector3();

  function aimDir(out) {
    out.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const spread = input.pointer.aim ? weapon.ads : weapon.hip;
    out.x += (Math.random() - 0.5) * spread;
    out.y += (Math.random() - 0.5) * spread;
    out.z += (Math.random() - 0.5) * spread;
    return out.normalize();
  }

  function updateLaser() {
    weaponView.getMuzzleWorld(muzzle);
    laserAimFrom.copy(camera.position);
    laserDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    laserUp.copy(camera.up).applyQuaternion(camera.quaternion);
    laserDir.addScaledVector(laserUp, -0.012).normalize();

    rayc.set(laserAimFrom, laserDir);
    rayc.far = weapon.range;
    const hits = rayc.intersectObjects(rayTargets, true);
    if (hits.length) {
      laserAimHit.copy(hits[0].point);
    } else {
      laserAimHit.copy(laserAimFrom).addScaledVector(laserDir, weapon.range);
    }

    laserPoints[0].copy(muzzle);
    laserPoints[1].copy(laserAimHit);
    laserLine.geometry.setFromPoints(laserPoints);
  }

  // ── Other FPS players (human model) ──────────────────────────────────
  const otherPlayers = new Map(); // sessionId → { group, model, gun }
  const FPS_COLORS = WORLD.FPS_COLORS;

  // Pre-load human + gun models (reuses GLTFLoader + SkeletonUtils already imported for bugs)
  let humanGLTF = null, gunGLTF = null;
  {
    const [{ GLTFLoader }, su] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js/+esm"),
      import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/utils/SkeletonUtils.js/+esm"),
    ]);
    if (!skeletonClone) skeletonClone = su.clone;
    const loader = new GLTFLoader();
    [humanGLTF, gunGLTF] = await Promise.all([
      loader.loadAsync("./assets/HumanBase.glb"),
      loader.loadAsync("./assets/smg.glb"),
    ]);
  }

  function createPlayerModel(colorIndex) {
    const color = FPS_COLORS[colorIndex] || 0x00cc44;
    const group = new THREE.Group();

    // Clone only the male rig subtree
    const maleRig = humanGLTF.scene.getObjectByName("basemesh_male_rig");
    const model = skeletonClone(maleRig);
    model.scale.setScalar(1.0);
    model.rotation.y = Math.PI; // face forward

    // Tint all meshes with the player's color
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    model.traverse((obj) => { if (obj.isMesh) obj.material = mat; });

    group.add(model);

    // Gun model attached to right hand bone
    const gun = gunGLTF.scene.clone(true);
    gun.scale.setScalar(0.14);
    gun.rotation.set(0, Math.PI, 0);
    const rightHand = model.getObjectByName("hand.R");
    if (rightHand) {
      gun.position.set(0, 0.05, 0);
      rightHand.add(gun);
    } else {
      gun.position.set(0.55, 1.3, -0.3);
      group.add(gun);
    }

    return { group, model, gun };
  }

  function syncOtherPlayers(state, mySessionId) {
    const seen = new Set();
    state.players.forEach((p, sid) => {
      if (sid === mySessionId) return;
      if (p.role !== "fps") return;
      seen.add(sid);

      let op = otherPlayers.get(sid);
      if (!op) {
        op = createPlayerModel(p.colorIndex);
        op._tx = p.x; op._ty = p.y; op._tz = p.z;
        op._tyaw = p.yaw; op._tpitch = p.pitch;
        scene.add(op.group);
        otherPlayers.set(sid, op);
      }
      // Update targets for lerp
      op._tx = p.x;
      op._ty = p.y;
      op._tz = p.z;
      op._tyaw = p.yaw;
      op._tpitch = p.pitch;
    });

    // Remove players no longer in state
    for (const [sid, op] of otherPlayers) {
      if (!seen.has(sid)) {
        scene.remove(op.group);
        otherPlayers.delete(sid);
      }
    }
  }

  function lerpOtherPlayers(dt) {
    const rate = Math.min(1, 12 * dt);
    for (const [, op] of otherPlayers) {
      const g = op.group;
      g.position.x += (op._tx - g.position.x) * rate;
      g.position.y += ((op._ty - 1.75) - g.position.y) * rate; // feet on ground
      g.position.z += (op._tz - g.position.z) * rate;

      // Yaw — rotate the model to face movement direction
      let dyaw = op._tyaw - g.rotation.y;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      g.rotation.y += dyaw * rate;
    }
  }
  // ──────────────────────────────────────────────────────────────────────

  // ── Network state ──────────────────────────────────────────────────────
  let room = null;
  let isMultiplayer = false;
  let networkSendTimer = 0;
  let mySessionId = null;
  let myColorIndex = 0;
  let isEnemyHost = true; // am I the AI-host for enemies?
  let isCoopMode = false; // coop = multiple shooters, no commander

  function updateHostStatus() {
    // Lowest colorIndex among connected FPS players is the host
    if (!room || !room.state) { isEnemyHost = true; return; }
    let lowestColor = myColorIndex;
    room.state.players.forEach((p) => {
      if (p.role === "fps" && p.colorIndex < lowestColor) {
        lowestColor = p.colorIndex;
      }
    });
    isEnemyHost = (lowestColor === myColorIndex);
  }
  // ──────────────────────────────────────────────────────────────────────

  function shoot() {
    if (!input.pointer.locked || game.win || game.resp || !game.started) return;
    const now = performance.now() / 1000;
    if (now < weapon.can) return;

    weapon.can = now + 1 / weapon.rate;

    const recoilMul = input.pointer.aim ? 0.72 : 1;
    player.pitch = clamp(player.pitch + weapon.rp * recoilMul, -1.45, 1.45);
    player.yaw += (Math.random() * 2 - 1) * weapon.ry * (input.pointer.aim ? 0.55 : 1);
    weaponView.kick();
    muzzleFlashLife = 0.055;
    spawnShell();

    const dir = aimDir(shootDir);
    fromCam.copy(camera.position);
    rayc.set(fromCam, dir);
    rayc.far = weapon.range;
    const hits = rayc.intersectObjects(rayTargets, true);

    let camHit = fromCam.clone().addScaledVector(dir, weapon.range);
    let enemy = null;
    let part = null;
    let hitWallId = null;
    if (hits.length) {
      camHit = hits[0].point.clone();
      const o = hits[0].object;
      if (o?.userData?.enemyRoot) {
        enemy = o.userData.enemyRoot;
        part = o.userData.hitPart || "body";
      } else if (o?.userData?.isWall) {
        hitWallId = o.userData.wallId;
      }
    }

    weaponView.getMuzzleWorld(muzzle);
    muzzleDir.copy(camHit).sub(muzzle);
    const d = muzzleDir.length();
    muzzleDir.normalize();
    rayc.set(muzzle, muzzleDir);
    rayc.far = Math.max(0.1, d);
    const muzzleHits = rayc.intersectObjects(rayTargets, true);

    let finalHit = camHit.clone();
    let eRoot = enemy;
    let ePart = part;
    let finalWallId = hitWallId;
    if (muzzleHits.length && muzzleHits[0].distance < d - 0.02) {
      finalHit = muzzleHits[0].point.clone();
      const mo = muzzleHits[0].object;
      if (mo?.userData?.isWall) {
        finalWallId = mo.userData.wallId;
        eRoot = null;
      } else {
        eRoot = mo?.userData?.enemyRoot || null;
        ePart = mo?.userData?.hitPart || "body";
        finalWallId = null;
      }
    }

    spawnTracer(muzzle.clone(), finalHit.clone());

    // Broadcast shot tracer to other players
    if (room && isMultiplayer) {
      room.send("playerShot", {
        fx: muzzle.x, fy: muzzle.y, fz: muzzle.z,
        tx: finalHit.x, ty: finalHit.y, tz: finalHit.z,
      });
    }

    // Wall hit
    if (finalWallId) {
      const w = walls.find((v) => v.id === finalWallId);
      if (w) {
        w.hp -= weapon.dmg;
        // Flash the wall material
        w.mat.emissive.setHex(0x552200);
        w.mat.emissiveIntensity = 1.5;
        setTimeout(() => { w.mat.emissive.setHex(0x2a0e08); w.mat.emissiveIntensity = 0.6; }, 80);
        if (room) {
          room.send("wallHit", { id: finalWallId, dmg: weapon.dmg });
        }
        if (w.hp <= 0) {
          destroyWall(finalWallId);
        }
      }
      return;
    }

    if (!eRoot) return;

    const en = enemies.find((v) => v.mesh === eRoot);
    if (!en) return;
    en.hp -= ePart === "head" ? weapon.dmg * 1.55 : weapon.dmg;
    en.flash = 0.1;
    if (en.hp > 0) return;

    const bi = targets.indexOf(en.bodyProxy);
    if (bi >= 0) targets.splice(bi, 1);
    const hi = targets.indexOf(en.headProxy);
    if (hi >= 0) targets.splice(hi, 1);
    game.kills++;
    en.mixer.stopAllAction();
    const gorePos = en.mesh.position.clone();
    gorePos.y += BUG_SCALE * 0.55;
    if (en.bugType === "acid") {
      spawnAcidGore(gorePos);
      // In singleplayer, trigger blind locally; in multiplayer the server broadcasts it
      if (!isMultiplayer) {
        const dx = player.pos.x - en.mesh.position.x;
        const dz = player.pos.z - en.mesh.position.z;
        if (Math.hypot(dx, dz) <= RTS.ACID_BLIND_RADIUS) {
          activateBlind();
        }
      }
    } else {
      spawnGore(gorePos);
    }
    map.world.remove(en.mesh);
    enemies.splice(enemies.indexOf(en), 1);
    rebuildRayTargets();
    hud();

    // Report kill to server
    if (room && en.networkId) {
      room.send("enemyKilled", { id: en.networkId });
    }
  }

  function spawnShell() {
    weaponView.getEjectWorld(shellSpawnPos);
    weaponView.getEjectVelocity(shellSpawnVel);
    const mesh = new THREE.Mesh(shellGeo, shellMat);
    mesh.position.copy(shellSpawnPos);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    scene.add(mesh);
    const speed = 4.1 + Math.random() * 1.8;
    shells.push({
      mesh,
      vel: shellSpawnVel.clone().multiplyScalar(speed),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 15,
        (Math.random() - 0.5) * 15,
        (Math.random() - 0.5) * 15
      ),
      life: 2.3,
      bounces: 0,
    });
    if (shells.length > 70) {
      const old = shells.shift();
      if (old) scene.remove(old.mesh);
    }
  }

  // Singleplayer spawn logic (only used when not connected to multiplayer)
  const spawnInterval = () => Math.max(0.34, 2.2 - game.deaths * 0.3 - map.cart.p * 1.1);
  const maxEnemies = () => 12 + game.deaths * 4 + Math.floor(map.cart.p * 8);

  function spawnTick(dt) {
    // In coop, only the enemy host spawns; in full multiplayer (with commander), skip
    if (game.win) return;
    if (isMultiplayer && !isCoopMode) return;
    if (isCoopMode && !isEnemyHost) return;

    game.spawnT -= dt;
    if (game.spawnT > 0) return;
    game.spawnT = spawnInterval();
    if (enemies.length >= maxEnemies()) return;
    for (let i = 0; i < Math.min(1 + (game.deaths >= 2 ? 1 : 0), 3); i++) {
      if (isCoopMode) {
        spawnAlienBugCoop();
      } else {
        spawnAlienBug();
      }
    }
  }

  // Coop spawn: create enemy locally and register on server so it syncs
  function spawnAlienBugCoop() {
    const a = Math.random() * Math.PI * 2;
    const r = 7 + Math.random() * 6;
    const x = Math.cos(a) * r;
    const z = WORLD.NEST_Z + Math.sin(a) * r;
    const isAcid = Math.random() < 0.15;
    const hp = isAcid ? RTS.ACID_BUG_HP : (58 + game.deaths * 12 + Math.random() * 20);
    const s = isAcid ? RTS.ACID_BUG_SPEED : (5.4 + game.deaths * 0.25 + Math.random());
    const bugType = isAcid ? "acid" : "basic";
    // Ask server to create and broadcast the enemy
    if (room) {
      room.send("coopSpawnEnemy", { x, z, hp, speed: s, bugType });
    }
  }

  function killPlayer() {
    if (game.resp || game.win) return;
    game.deaths++;
    game.resp = true;
    game.respT = 3;
    player.hp = 0;
    ui.setStatus("Killed - Respawning...");
    ui.banner("YOU WERE SHREDDED", 1.8);
    drawGunSplatter();
    hud();
  }

  function respawnPlayer() {
    game.resp = false;
    player.hp = 200;
    player.vel.set(0, 0, 0);
    player.pos.set(
      WORLD.SPAWN_X,
      map.gy(WORLD.SPAWN_X, WORLD.SPAWN_Z) + player.height,
      WORLD.SPAWN_Z
    );
    player.yaw = WORLD.SPAWN_YAW;
    player.pitch = 0;
    player.height = 1.75;
    game.deathRoll = 0;
    ui.setStatus("Respawned");
    ui.banner("BACK IN", 1);
    clearGunSplatter();
    hud();
  }

  function carTick(dt) {
    const dx = player.pos.x - map.car.position.x;
    const dz = player.pos.z - map.car.position.z;
    const near = Math.hypot(dx, dz) <= map.cart.rad;

    if (!game.win) {
      if (near && !game.resp) {
        map.cart.p += (map.cart.fwd * dt) / (WORLD.TRACK_START - WORLD.TRACK_END);
        ui.setStatus("Escorting car to nest");
      } else if (game.resp && !isMultiplayer) {
        // Only roll back in singleplayer — in multiplayer another player may be pushing
        map.cart.p -= (map.cart.back * dt) / (WORLD.TRACK_START - WORLD.TRACK_END);
        ui.setStatus("Car rolling back - spawn rate rising");
      } else if (!near && !game.resp) {
        ui.setStatus("Get closer");
      }
    }

    // In multiplayer, sync cart from server (server holds authoritative max)
    if (isMultiplayer && room && room.state) {
      const serverP = room.state.cartProgress;
      if (!isNaN(serverP)) {
        map.cart.p = Math.max(map.cart.p, serverP);
      }
    }

    // Block cart at wall positions
    for (const w of walls) {
      // Convert wall Z to progress value
      const wallP = (WORLD.TRACK_START - w.z) / (WORLD.TRACK_START - WORLD.TRACK_END);
      if (map.cart.p >= wallP - 0.005) {
        map.cart.p = Math.min(map.cart.p, wallP - 0.005);
        if (near && !game.resp) ui.setStatus("Wall blocking the cart - destroy it!");
      }
    }

    map.cart.p = clamp(map.cart.p, 0, 1);
    map.setCar();
    if (!game.win && map.cart.p >= 0.995) {
      game.win = true;
      ui.setStatus("Mission complete!");
      ui.banner("YOU WIN", 3);
      clearEnemies();
      nestExplosion();
      if (room) {
        room.send("win", {});
      }
      setTimeout(showWinOverlay, 3500);
    }
  }

  // Non-host clients lerp enemies toward server-authoritative positions
  function enemySyncTick(dt) {
    if (!room || !room.state) return;
    const rate = Math.min(1, 15 * dt);
    room.state.enemies.forEach((se, id) => {
      const en = enemies.find((e) => e.networkId === id);
      if (!en) return;
      en.mesh.position.x += (se.x - en.mesh.position.x) * rate;
      en.mesh.position.z += (se.z - en.mesh.position.z) * rate;
      if (se.y) en.mesh.position.y += (se.y - en.mesh.position.y) * rate;
      let dyaw = se.yaw - en.yaw;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      en.yaw += dyaw * rate;
      en.mesh.rotation.y = en.yaw;
      // Determine action from distance to local player
      const dx = player.pos.x - en.mesh.position.x;
      const dz = player.pos.z - en.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      en.mixer.update(dt);
      setEnemyAction(en, dist > 0.8 ? "run" : "attack");
      // Hit flash
      en.flash = Math.max(0, en.flash - dt);
      if (en.flash > 0) {
        en.mat.emissive.setHex(0x250404);
        en.mat.emissiveIntensity = 1;
      } else {
        en.mat.emissive.setHex(0);
        en.mat.emissiveIntensity = 0;
      }
      // Attack damage — still local so each player takes damage independently
      en.atk = Math.max(0, en.atk - dt);
      if (en.atk <= 0 && dist < 1.5 * BUG_SCALE) {
        en.atk = 0.75;
        const playerInSafe = Math.hypot(player.pos.x - WORLD.SPAWN_X, player.pos.z - WORLD.SPAWN_Z) <= WORLD.SPAWN_SAFE_RADIUS;
        if (!game.resp && !playerInSafe) {
          const dmgScale = 1 / (1 + enemies.length * 0.12);
          player.hp -= (8 + Math.random() * 4 + game.deaths * 0.8) * dmgScale;
          player.hp = Math.max(0, player.hp);
          if (player.hp <= 0) killPlayer();
          hud();
        }
      }
    });
  }

  function aiTick(dt, t) {
    // Non-host clients don't run AI — they lerp from server state
    if (isMultiplayer && !isEnemyHost) {
      enemySyncTick(dt);
      return;
    }

    for (const en of enemies) {
      const dxSpawn = en.mesh.position.x - WORLD.SPAWN_X;
      const dzSpawn = en.mesh.position.z - WORLD.SPAWN_Z;
      const distSpawn = Math.hypot(dxSpawn, dzSpawn);
      if (distSpawn < WORLD.SPAWN_SAFE_RADIUS) {
        const n = Math.max(0.0001, distSpawn);
        const pushOut = WORLD.SPAWN_SAFE_RADIUS - n;
        en.mesh.position.x += (dxSpawn / n) * pushOut;
        en.mesh.position.z += (dzSpawn / n) * pushOut;
      }

      const playerToSpawnX = player.pos.x - WORLD.SPAWN_X;
      const playerToSpawnZ = player.pos.z - WORLD.SPAWN_Z;
      const playerInSafe = Math.hypot(playerToSpawnX, playerToSpawnZ) <= WORLD.SPAWN_SAFE_RADIUS;
      const trg = game.resp || playerInSafe ? map.car.position : player.pos;
      const dx = trg.x - en.mesh.position.x;
      const dz = trg.z - en.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      const want = Math.atan2(dx, -dz);
      let dy = want - en.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      en.yaw += dy * Math.min(1, en.tr * dt);

      const f = new THREE.Vector3(Math.sin(en.yaw), 0, -Math.cos(en.yaw));
      if (!en.air) {
        const m = dist > 0.8 ? 1 : 0;
        const move = f.multiplyScalar(en.s * m);
        en.vel.x += (move.x - en.vel.x) * Math.min(1, en.acc * dt);
        en.vel.z += (move.z - en.vel.z) * Math.min(1, en.acc * dt);
        en.mesh.position.x += en.vel.x * dt;
        en.mesh.position.z += en.vel.z * dt;
        en.jump -= dt;
        if (dist < 14 && en.jump <= 0) {
          en.air = true;
          en.jump = 1.9 + Math.random() * 0.9;
          const js = 8.5 + Math.random() * 1.3;
          const nx = dx / Math.max(0.001, dist);
          const nz = dz / Math.max(0.001, dist);
          en.vel.x = nx * js;
          en.vel.z = nz * js;
          en.vy = 6.8 + Math.random();
        }
      } else {
        en.vy -= 22 * dt;
        en.mesh.position.x += en.vel.x * dt;
        en.mesh.position.z += en.vel.z * dt;
        en.mesh.position.y += en.vy * dt;
        const y = map.gy(en.mesh.position.x, en.mesh.position.z);
        if (en.mesh.position.y <= y) {
          en.mesh.position.y = y;
          en.air = false;
          en.vy = 0;
        }
      }

      push(en.mesh.position, en.r, en.vel);
      if (!en.air) en.mesh.position.y = map.gy(en.mesh.position.x, en.mesh.position.z);
      en.mesh.rotation.y = en.yaw;

      en.mixer.update(dt);
      setEnemyAction(en, (en.air || dist > 0.8) ? "run" : "attack");

      en.flash = Math.max(0, en.flash - dt);
      if (en.flash > 0) {
        en.mat.emissive.setHex(0x250404);
        en.mat.emissiveIntensity = 1;
      } else {
        en.mat.emissive.setHex(0);
        en.mat.emissiveIntensity = 0;
      }

      en.atk = Math.max(0, en.atk - dt);
      if (en.atk <= 0 && dist < 1.5 * BUG_SCALE) {
        en.atk = 0.75;
        if (!game.resp && !playerInSafe) {
          const dmgScale = 1 / (1 + enemies.length * 0.12);
          player.hp -= (8 + Math.random() * 4 + game.deaths * 0.8) * dmgScale;
          player.hp = Math.max(0, player.hp);
          if (player.hp <= 0) killPlayer();
          hud();
        }
      }
    }

    // Push enemies apart so they don't stack on each other
    for (let i = 0; i < enemies.length; i++) {
      for (let j = i + 1; j < enemies.length; j++) {
        const a = enemies[i];
        const b = enemies[j];
        const minDist = a.r + b.r;
        const dx = b.mesh.position.x - a.mesh.position.x;
        const dz = b.mesh.position.z - a.mesh.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minDist * minDist || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const sep = (minDist - d) * 0.5;
        const nx = dx / d;
        const nz = dz / d;
        a.mesh.position.x -= nx * sep;
        a.mesh.position.z -= nz * sep;
        b.mesh.position.x += nx * sep;
        b.mesh.position.z += nz * sep;
      }
    }
  }

  // ── Network send (10 Hz) ───────────────────────────────────────────────
  function networkTick(dt) {
    if (!room || !isMultiplayer) return;
    networkSendTimer += dt;
    if (networkSendTimer < 0.1) return;
    networkSendTimer = 0;

    // Send player state
    room.send("playerUpdate", {
      x: player.pos.x,
      y: player.pos.y,
      z: player.pos.z,
      yaw: player.yaw,
      pitch: player.pitch,
      hp: player.hp,
      cartProgress: map.cart.p,
    });

    // Only the enemy host sends positions (authoritative AI)
    if (isEnemyHost && enemies.length > 0) {
      const positions = [];
      for (const en of enemies) {
        if (en.networkId) {
          positions.push({
            id: en.networkId,
            x: en.mesh.position.x,
            y: en.mesh.position.y,
            z: en.mesh.position.z,
            yaw: en.yaw,
          });
        }
      }
      if (positions.length > 0) {
        room.send("enemyPositions", positions);
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  rebuildRayTargets();
  hud();

  // ── Overlay helpers ────────────────────────────────────────────────────
  let playerName = "Anonymous";

  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  function makeOverlayBtn(label) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = [
      "margin-top:16px", "padding:16px 52px", "font-size:26px",
      "font-family:monospace", "background:#c0000a", "color:#fff",
      "border:none", "border-radius:6px", "cursor:pointer", "letter-spacing:4px",
    ].join(";");
    btn.onmouseenter = () => btn.style.background = "#8a0008";
    btn.onmouseleave = () => btn.style.background = "#c0000a";
    return btn;
  }

  function lbRows(container, top3) {
    const medals = ["🥇", "🥈", "🥉"];
    if (!top3.length) {
      const none = document.createElement("div");
      none.textContent = "No scores yet — be the first!";
      none.style.cssText = "color:#555;font-size:14px;margin-top:4px;";
      container.appendChild(none);
      return;
    }
    top3.forEach((e, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:14px;align-items:center;margin-bottom:5px;font-size:17px;min-width:300px;";
      const medal = document.createElement("span"); medal.textContent = medals[i];
      const nm = document.createElement("span"); nm.textContent = e.name; nm.style.cssText = "flex:1;text-align:left;";
      const kl = document.createElement("span"); kl.textContent = `${e.kills}K`; kl.style.cssText = "color:#00dfff;";
      const tm = document.createElement("span"); tm.textContent = formatTime(e.time); tm.style.cssText = "color:#aaa;";
      row.append(medal, nm, kl, tm);
      container.appendChild(row);
    });
  }

  function nestExplosion() {
    const center = map.car.position.clone();
    center.y += 2;
    for (let i = 0; i < 8; i++) {
      spawnGore(center.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 14,
        Math.random() * 5,
        (Math.random() - 0.5) * 14
      )));
    }
  }

  function showStartScreen() {
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.style.cssText = [
        "position:fixed", "inset:0", "display:flex", "flex-direction:column",
        "align-items:center", "justify-content:center",
        "background:rgba(0,0,0,0.87)", "z-index:999", "gap:14px",
        "font-family:monospace",
      ].join(";");

      const title = document.createElement("h1");
      title.textContent = "NEST RUN";
      title.style.cssText = "color:#fff;font-size:68px;margin:0;letter-spacing:8px;";

      const sub = document.createElement("p");
      sub.textContent = "Escort the rail car to the alien nest";
      sub.style.cssText = "color:#aaa;font-size:16px;margin:0;letter-spacing:1px;";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.placeholder = "Enter your name";
      nameInput.maxLength = 20;
      nameInput.style.cssText = [
        "padding:10px 20px", "font-size:20px", "font-family:monospace",
        "background:#111", "color:#fff", "border:2px solid #444",
        "border-radius:6px", "outline:none", "text-align:center", "width:260px",
      ].join(";");
      nameInput.onfocus = () => nameInput.style.borderColor = "#00b4ff";
      nameInput.onblur  = () => nameInput.style.borderColor = "#444";

      const lb = document.createElement("div");
      lb.style.cssText = "color:#fff;font-family:monospace;text-align:center;";
      lb.innerHTML = '<div style="color:rgba(0,190,255,.5);font-size:11px;letter-spacing:.2em;margin-bottom:8px;text-transform:uppercase;">Top 3</div>';
      fetch("/api/leaderboard").then(r => r.json()).then(top3 => lbRows(lb, top3)).catch(() => {});

      const btn = makeOverlayBtn("▶  PLAY");
      const start = () => {
        playerName = nameInput.value.trim() || "Anonymous";
        document.body.removeChild(ov);
        renderer.domElement.requestPointerLock();
        resolve(playerName);
      };
      btn.onclick = start;
      nameInput.onkeydown = (e) => { if (e.key === "Enter") start(); };

      ov.append(title, sub, nameInput, lb, btn);
      document.body.appendChild(ov);
    });
  }

  async function showWinOverlay() {
    document.exitPointerLock();
    let top3 = [];
    try {
      const res = await fetch("/api/leaderboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: playerName, kills: game.kills, time: Math.round(game.elapsed) }),
      });
      if (res.ok) top3 = await res.json();
    } catch (e) { console.error("[leaderboard]", e); }

    const ov = document.createElement("div");
    ov.style.cssText = [
      "position:fixed", "inset:0", "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "background:rgba(0,0,0,0.82)", "z-index:999", "gap:12px",
      "font-family:monospace",
    ].join(";");

    const winTitle = document.createElement("h1");
    winTitle.textContent = "MISSION COMPLETE";
    winTitle.style.cssText = "color:#00e87a;font-size:52px;margin:0;letter-spacing:4px;";

    const stats = document.createElement("p");
    stats.textContent = `${playerName}  ·  ${game.kills} kills  ·  ${formatTime(game.elapsed)}`;
    stats.style.cssText = "color:#f1c40f;font-size:22px;margin:0;letter-spacing:2px;";

    const lb = document.createElement("div");
    lb.style.cssText = "color:#fff;font-family:monospace;text-align:center;";
    lb.innerHTML = '<div style="color:rgba(0,190,255,.5);font-size:11px;letter-spacing:.2em;margin-bottom:8px;text-transform:uppercase;">Top 3</div>';
    lbRows(lb, top3);

    const btn = makeOverlayBtn("PLAY AGAIN");
    btn.onclick = () => window.location.href = "/";

    ov.append(winTitle, stats, lb, btn);
    document.body.appendChild(ov);
  }

  function showGameOver(winner) {
    document.exitPointerLock();
    game.win = true;
    const ov = document.createElement("div");
    ov.style.cssText = [
      "position:fixed", "inset:0", "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "background:rgba(0,0,0,0.82)", "z-index:999", "gap:12px",
      "font-family:monospace",
    ].join(";");

    const title = document.createElement("h1");
    if (winner === "rts") {
      title.textContent = "TIME'S UP - COMMANDER WINS";
      title.style.cssText = "color:#e84000;font-size:42px;margin:0;letter-spacing:4px;";
    } else if (winner === "disconnect") {
      title.textContent = "OPPONENT DISCONNECTED";
      title.style.cssText = "color:#888;font-size:42px;margin:0;letter-spacing:4px;";
    } else {
      title.textContent = "GAME OVER";
      title.style.cssText = "color:#e84000;font-size:42px;margin:0;letter-spacing:4px;";
    }

    const btn = makeOverlayBtn("PLAY AGAIN");
    btn.onclick = () => window.location.href = "/";

    ov.append(title, btn);
    document.body.appendChild(ov);
  }
  // ──────────────────────────────────────────────────────────────────────

  const veil = document.getElementById("veil");

  const splatterCanvas = document.createElement("canvas");
  splatterCanvas.width = innerWidth;
  splatterCanvas.height = innerHeight;
  splatterCanvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:10;";
  document.body.appendChild(splatterCanvas);
  const splatterCtx = splatterCanvas.getContext("2d");

  function drawGunSplatter() {
    const ctx = splatterCtx;
    const w = splatterCanvas.width;
    const h = splatterCanvas.height;
    for (let i = 0; i < 11; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = 5 + Math.random() * 22;
      const red = 100 + Math.floor(Math.random() * 50);
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.6 + Math.random() * 0.7), Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${red},0,0,${0.55 + Math.random() * 0.45})`;
      ctx.fill();
      // small satellite drops
      for (let j = 0; j < 3; j++) {
        const sx = x + (Math.random() - 0.5) * r * 3;
        const sy = y + (Math.random() - 0.5) * r * 3;
        const sr = 2 + Math.random() * 6;
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${red},0,0,${0.4 + Math.random() * 0.5})`;
        ctx.fill();
      }
      // drip
      if (Math.random() > 0.45) {
        const dripLen = 20 + Math.random() * 55;
        ctx.beginPath();
        ctx.moveTo(x, y + r);
        ctx.quadraticCurveTo(x + (Math.random() - 0.5) * 8, y + r + dripLen * 0.5, x + (Math.random() - 0.5) * 6, y + r + dripLen);
        ctx.lineWidth = 1.5 + Math.random() * 3.5;
        ctx.strokeStyle = `rgba(${red},0,0,${0.45 + Math.random() * 0.45})`;
        ctx.stroke();
      }
    }
  }

  function clearGunSplatter() {
    splatterCtx.clearRect(0, 0, splatterCanvas.width, splatterCanvas.height);
  }

  // ── Acid blind effect ──────────────────────────────────────────────────
  let blindTimer = 0;
  let blindActive = false;

  const blindCanvas = document.createElement("canvas");
  const BLIND_PX = 48; // pixelation grid size
  blindCanvas.width = BLIND_PX;
  blindCanvas.height = BLIND_PX;
  blindCanvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:11;display:none;image-rendering:pixelated;";
  document.body.appendChild(blindCanvas);
  const blindCtx = blindCanvas.getContext("2d");

  const blindText = document.createElement("div");
  blindText.textContent = "BLINDED";
  blindText.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);font-size:72px;font-weight:900;color:#fff;font-family:monospace;letter-spacing:8px;pointer-events:none;z-index:12;display:none;text-shadow:0 0 20px rgba(0,255,0,0.8);";
  document.body.appendChild(blindText);

  function updateBlindTexture(t) {
    const ctx = blindCtx;
    const w = BLIND_PX;
    const h = BLIND_PX;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Animated noise with green variation
        const n = Math.sin(x * 3.7 + t * 2.1) * Math.cos(y * 4.3 + t * 1.7) * 0.5 + 0.5;
        const flicker = Math.random() * 0.15;
        const g = Math.floor(80 + (n + flicker) * 120);
        const r = Math.floor(g * 0.12);
        const b = Math.floor(g * 0.08);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  function activateBlind() {
    blindTimer = RTS.ACID_BLIND_DURATION;
    if (!blindActive) {
      blindActive = true;
      blindCanvas.style.display = "block";
      blindText.style.display = "block";
    }
  }

  function deactivateBlind() {
    blindActive = false;
    blindCanvas.style.display = "none";
    blindText.style.display = "none";
  }
  // ──────────────────────────────────────────────────────────────────────

  const hipOffset = new THREE.Vector3();
  const adsOffset = new THREE.Vector3();
  let last = performance.now() / 1000;
  let bob = 0;
  function loop() {
    requestAnimationFrame(loop);
    const t = performance.now() / 1000;
    const dt = Math.min(0.033, t - last);
    last = t;

    if (!game.win) game.elapsed = t - game.startTime;

    // Acid blind timer
    if (blindTimer > 0) {
      blindTimer -= dt;
      if (blindTimer <= 0) {
        blindTimer = 0;
        deactivateBlind();
      } else {
        updateBlindTexture(t);
      }
    }

    if (game.resp) {
      player.pitch = THREE.MathUtils.lerp(player.pitch, 1.3, Math.min(1, 5 * dt));
      player.height = THREE.MathUtils.lerp(player.height, 0.28, Math.min(1, 3 * dt));
      game.deathRoll = THREE.MathUtils.lerp(game.deathRoll, 0.6, Math.min(1, 4 * dt));
    }

    camera.rotation.order = "YXZ";
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch;
    camera.rotation.z = game.deathRoll;

    wish(wishMove);
    const sprint = input.keys.has("ShiftLeft") || input.keys.has("ShiftRight");
    const speed = player.ground ? (sprint ? player.ss : player.ws) : player.as;

    if (!game.resp && !game.win && game.started) {
      if (player.ground) {
        friction(player.fg, dt);
        accel(wishMove, speed, player.ag, dt);
      } else {
        friction(player.fa, dt);
        accel(wishMove, speed, player.aa, dt);
      }
      player.vel.y -= player.g * dt;
      if (player.ground && input.keys.has("Space")) {
        player.vel.y = player.j;
        player.ground = false;
      }
    } else {
      friction(9, dt);
      player.vel.y -= player.g * dt;
    }

    player.pos.addScaledVector(player.vel, dt);
    collidePlayer();

    if (game.resp) {
      game.respT -= dt;
      if (game.respT <= 0) respawnPlayer();
    }

    carTick(dt);
    spawnTick(dt);
    aiTick(dt, t);
    networkTick(dt);
    lerpOtherPlayers(dt);

    const hs = Math.hypot(player.vel.x, player.vel.z);
    bob += (player.ground ? hs : hs * 0.2) * dt * 2.8;
    const by = player.ground ? Math.sin(bob) * 0.035 : 0;
    const bx = player.ground ? Math.cos(bob * 0.5) * 0.02 : 0;
    camera.position.set(player.pos.x + bx, player.pos.y + by, player.pos.z);

    veil.style.opacity = game.resp ? (game.respT / 3) * 0.55 : 0;

    const fov = input.pointer.aim ? 70 : sprint ? 100 : 94;
    camera.fov += (fov - camera.fov) * Math.min(1, 12 * dt);
    camera.updateProjectionMatrix();
    ui.setCrosshairAim(input.pointer.aim);

    const sway = input.pointer.aim ? 0.35 : 1;
    const movingForward = input.keys.has("KeyW") && !input.keys.has("KeyS");
    const swayFreqX = 2.1;
    const swayFreqY = movingForward ? 1.25 : 2;
    const swx = (Math.sin(t * swayFreqX) * 0.014 + bx * 0.8) * sway;
    const swy = (Math.cos(t * swayFreqY) * 0.01 + by * 0.7) * sway;

    hipOffset.set(0.41 + swx, 0.08 + swy, -0.44);
    adsOffset.set(0.24 + swx * 0.4, 0.13 + swy * 0.4, -0.3);
    weaponView.gun.position.copy(camera.position);
    weaponView.gun.quaternion.copy(camera.quaternion);
    weaponView.gun.position.add((input.pointer.aim ? adsOffset : hipOffset).clone().applyQuaternion(camera.quaternion));
    weaponView.settle(dt);
    updateLaser();

    weaponView.getMuzzleWorld(muzzle);
    if (muzzleFlashLife > 0) {
      muzzleFlashLife = Math.max(0, muzzleFlashLife - dt);
      const k = muzzleFlashLife / 0.055;
      muzzleFlash.position.copy(muzzle);
      muzzleFlash.scale.setScalar(1 + (1 - k) * 1.8);
      muzzleFlashMat.opacity = 0.9 * k;
      muzzleFlashLight.position.copy(muzzle);
      muzzleFlashLight.intensity = 2.4 * k;
      muzzleFlash.visible = true;
    } else {
      muzzleFlash.visible = false;
      muzzleFlashMat.opacity = 0;
      muzzleFlashLight.intensity = 0;
    }

    if (input.pointer.fire) shoot();
    for (let i = shells.length - 1; i >= 0; i--) {
      const s = shells[i];
      s.life -= dt;
      s.vel.y -= 16 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;

      const floorY = map.gy(s.mesh.position.x, s.mesh.position.z) + 0.03;
      if (s.mesh.position.y < floorY) {
        s.mesh.position.y = floorY;
        if (s.vel.y < 0) {
          s.vel.y *= -0.35;
          s.vel.x *= 0.65;
          s.vel.z *= 0.65;
          s.bounces += 1;
        }
      }

      if (s.life <= 0 || s.bounces > 3) {
        scene.remove(s.mesh);
        shells.splice(i, 1);
      }
    }

    for (let i = tracers.length - 1; i >= 0; i--) {
      tracers[i].life -= dt;
      tracers[i].line.material.opacity = Math.max(0, tracers[i].life / 0.06);
      if (tracers[i].life <= 0) {
        scene.remove(tracers[i].line);
        tracers.splice(i, 1);
      }
    }

    for (let i = gore.length - 1; i >= 0; i--) {
      const g = gore[i];
      g.life -= dt;
      if (g.life <= 0) { scene.remove(g.mesh); gore.splice(i, 1); continue; }
      g.vel.y -= 16 * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      const floorY = map.gy(g.mesh.position.x, g.mesh.position.z);
      if (g.mesh.position.y < floorY) {
        g.mesh.position.y = floorY;
        if (g.vel.y < 0) { g.vel.y *= -0.25; g.vel.x *= 0.55; g.vel.z *= 0.55; }
      }
    }

    renderer.render(scene, camera);
  }

  renderer.render(scene, camera);
  playerName = await showStartScreen();
  ui.msg("Click the game to lock mouse.");

  // ── Multiplayer connection ─────────────────────────────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const paramRoomId = urlParams.get("roomId");
  const paramCreate = urlParams.get("create") === "true";
  const paramRoomName = urlParams.get("roomName");
  const paramRole = urlParams.get("role") || "fps";

  let waitingOverlay = null;
  try {
    // Connect based on URL params
    if (paramCreate) {
      room = await createRoom(paramRole, paramRoomName || "Game Room");
    } else if (paramRoomId) {
      room = await joinRoom(paramRoomId, paramRole);
    } else {
      // Legacy: no params, joinOrCreate
      room = await connectToGame("fps");
    }
    isMultiplayer = true;
    mySessionId = room.sessionId;
    console.log("[network] Connected as FPS player, sessionId:", mySessionId);

    // Show waiting overlay until game starts
    waitingOverlay = document.createElement("div");
    waitingOverlay.style.cssText = [
      "position:fixed", "inset:0", "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "background:rgba(0,0,0,0.75)", "z-index:999", "gap:14px",
      "font-family:monospace",
    ].join(";");
    const waitText = document.createElement("h2");
    waitText.textContent = "Waiting for Commander...";
    waitText.id = "wait-text";
    waitText.style.cssText = "color:#00b4ff;font-size:32px;letter-spacing:3px;";
    const waitSub = document.createElement("p");
    waitSub.id = "wait-sub";
    waitSub.textContent = "Share this room or wait for countdown";
    waitSub.style.cssText = "color:#888;font-size:14px;";
    const waitCountdown = document.createElement("p");
    waitCountdown.id = "wait-countdown";
    waitCountdown.textContent = "";
    waitCountdown.style.cssText = "color:#f1c40f;font-size:24px;font-weight:700;letter-spacing:2px;";
    waitingOverlay.append(waitText, waitSub, waitCountdown);
    document.body.appendChild(waitingOverlay);

    // Listen for countdown
    room.onMessage("countdown", (data) => {
      const el = document.getElementById("wait-countdown");
      if (el) el.textContent = "Starting in " + data.seconds + "s";
    });

    // Listen for game start
    room.onMessage("gameStart", (data) => {
      console.log("[network] Game started! Mode:", data.mode);
      if (waitingOverlay && waitingOverlay.parentNode) {
        document.body.removeChild(waitingOverlay);
        waitingOverlay = null;
      }
      if (data.mode === "singleplayer") {
        isMultiplayer = false;
        ui.banner("SOLO MODE — ESCORT THE CAR TO THE NEST", 2.5);
      } else if (data.mode === "coop") {
        isCoopMode = true;
        ui.banner("CO-OP MODE — ESCORT THE CAR TO THE NEST", 2.5);
      } else {
        ui.banner("COMMANDER HAS JOINED - GAME ON!", 2.5);
      }
      game.started = true;
      game.startTime = performance.now() / 1000;
      last = performance.now() / 1000;
    });

    // Listen for enemy spawn commands from RTS player
    room.onMessage("enemySpawn", (data) => {
      console.log("[network] Spawning enemy:", data.id, data.bugType || "basic");
      spawnAlienBugAt(data.id, data.x, data.z, data.hp, data.speed, data.bugType);
    });

    // Receive shot tracers from other players
    room.onMessage("playerShot", (data) => {
      const from = new THREE.Vector3(data.fx, data.fy, data.fz);
      const to = new THREE.Vector3(data.tx, data.ty, data.tz);
      spawnTracer(from, to);
    });

    // Acid blind effect — check distance from player
    room.onMessage("acidBlind", (data) => {
      const dx = player.pos.x - data.x;
      const dz = player.pos.z - data.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= RTS.ACID_BLIND_RADIUS) {
        activateBlind();
      }
    });

    // Wall spawned by commander
    room.onMessage("wallSpawn", (data) => {
      console.log("[network] Wall spawned:", data.id);
      spawnWall(data.id, data.z, data.hp);
    });

    // Wall took damage from another player
    room.onMessage("wallDamage", (data) => {
      const w = walls.find((v) => v.id === data.id);
      if (w) w.hp = data.hp;
    });

    // Wall destroyed
    room.onMessage("wallDestroyed", (data) => {
      destroyWall(data.id);
    });

    // Listen for game over
    room.onMessage("gameOver", (data) => {
      console.log("[network] Game over:", data.winner);
      showGameOver(data.winner);
    });

    // If we got assigned as RTS by mistake, redirect
    room.onMessage("roleAssign", (data) => {
      if (data.role === "rts") {
        console.log("[network] Assigned RTS role, redirecting...");
        room.leave();
        window.location.href = "/rts.html";
      }
      // Use spawn point based on colorIndex
      if (data.role === "fps" && data.colorIndex != null) {
        myColorIndex = data.colorIndex;
        const sp = WORLD.SPAWN_POINTS[data.colorIndex] || WORLD.SPAWN_POINTS[0];
        player.pos.set(sp.x, map.gy(sp.x, sp.z) + player.height, sp.z);
        player.yaw = sp.yaw;
      }
    });

    // Sync other FPS player block models + enemy sync
    room.onStateChange((state) => {
      syncOtherPlayers(state, mySessionId);
      updateHostStatus();

      // Build set of local networkIds for comparison
      const localIds = new Set();
      for (const en of enemies) {
        if (en.networkId) localIds.add(en.networkId);
      }

      // Build set of server enemy ids
      const serverEnemyIds = new Set();
      state.enemies.forEach((e, id) => { serverEnemyIds.add(id); });

      // Remove local enemies that server has removed (killed by another player)
      for (let i = enemies.length - 1; i >= 0; i--) {
        const en = enemies[i];
        if (en.networkId && !serverEnemyIds.has(en.networkId)) {
          const bi = targets.indexOf(en.bodyProxy);
          if (bi >= 0) targets.splice(bi, 1);
          const hi = targets.indexOf(en.headProxy);
          if (hi >= 0) targets.splice(hi, 1);
          en.mixer.stopAllAction();
          const gorePos = en.mesh.position.clone();
          gorePos.y += BUG_SCALE * 0.55;
          if (en.bugType === "acid") {
            spawnAcidGore(gorePos);
          } else {
            spawnGore(gorePos);
          }
          map.world.remove(en.mesh);
          enemies.splice(i, 1);
        }
      }

      // Re-create enemies that exist on server but not locally (e.g. after death clear)
      state.enemies.forEach((e, id) => {
        if (!localIds.has(id)) {
          spawnAlienBugAt(id, e.x, e.z, e.hp, e.speed, e.bugType);
        }
      });

      rebuildRayTargets();
      hud();
    });

    // If game already started (we joined second), remove waiting overlay
    if (room.state && room.state.phase === "playing") {
      if (waitingOverlay && waitingOverlay.parentNode) {
        document.body.removeChild(waitingOverlay);
        waitingOverlay = null;
      }
      game.started = true;
      game.startTime = performance.now() / 1000;
      last = performance.now() / 1000;
    }

  } catch (err) {
    console.warn("[network] Connection failed, running singleplayer:", err);
    isMultiplayer = false;
    room = null;
    if (waitingOverlay && waitingOverlay.parentNode) {
      document.body.removeChild(waitingOverlay);
    }
  }

  // If singleplayer (no connection), start immediately
  if (!isMultiplayer) {
    game.started = true;
    ui.banner("ESCORT THE CAR TO THE NEST", 2);
    game.startTime = performance.now() / 1000;
    last = performance.now() / 1000;
  }

  loop();

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}
