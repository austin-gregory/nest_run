import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { ASSETS, WORLD, RTS, FORCE_GUN_ASSETS } from "./constants.js";
import { createUI } from "./ui.js";
import { attachInput } from "./input.js";
import { createWorld } from "./world.js";
import { createWeaponView } from "./weaponView.js";
import { connectToGame, createRoom, joinRoom } from "./network.js";
import { recordGame, getUser, getDisplayName, getCachedCustomization } from "./supabase.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export async function initGame() {
  const ui = createUI();

  const scene = new THREE.Scene();
  const skyTex = new THREE.TextureLoader().load("./assets/sky.png");
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;
  scene.fog = new THREE.Fog(0x2d1f16, 26, 450);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(94, innerWidth / innerHeight, 0.05, 900);
  scene.add(new THREE.HemisphereLight(0xffc98a, 0x2a1b13, 0.62));
  const sun = new THREE.DirectionalLight(0xffb15c, 1.35);
  sun.position.set(120, 180, 30);
  scene.add(sun);

  const map = await createWorld(scene);
  const weaponView = await createWeaponView(scene, ASSETS);
  const forceGunView = await createWeaponView(scene, FORCE_GUN_ASSETS);
  forceGunView.gun.visible = false;

  // ── Force gun checkpoint & weapon switching ─────────────────────────────
  let activeWeapon = "smg";
  let checkpointReached = false;
  const checkpointPos = map.getTrackPoint(0.25);
  const checkpointY = map.gy(checkpointPos.x, checkpointPos.z);
  const checkpointRing = new THREE.Mesh(
    new THREE.RingGeometry(0, 6, 48),
    new THREE.MeshBasicMaterial({ color: 0x00b4ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
  );
  checkpointRing.rotation.x = -Math.PI / 2;
  checkpointRing.position.set(checkpointPos.x, checkpointY + 0.08, checkpointPos.z);
  scene.add(checkpointRing);

  function swapWeapon() {
    if (!checkpointReached || game.resp || game.win || !game.started) return;
    if (activeWeapon === "smg") {
      activeWeapon = "force";
      weaponView.gun.visible = false;
      forceGunView.gun.visible = true;
    } else {
      activeWeapon = "smg";
      weaponView.gun.visible = true;
      forceGunView.gun.visible = false;
    }
  }

  // ── Force push mechanic ─────────────────────────────────────────────────
  const forceWaves = [];
  const forceWeapon = { rate: 1.5, can: 0 };
  const _fpDir = new THREE.Vector3();
  const _fpToEnemy = new THREE.Vector3();

  function shootForcePush() {
    if (!(input.pointer.locked || input.gamepad.connected) || game.win || game.resp || !game.started) return;
    const now = performance.now() / 1000;
    if (now < forceWeapon.can) return;
    forceWeapon.can = now + 1 / forceWeapon.rate;

    forceGunView.kick();

    // Player forward direction (flat)
    _fpDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _fpDir.y = 0;
    _fpDir.normalize();

    // Push enemies in front within range
    for (const en of enemies) {
      _fpToEnemy.copy(en.mesh.position).sub(player.pos);
      _fpToEnemy.y = 0;
      const dist = _fpToEnemy.length();
      if (dist > 54 || dist < 0.1) continue;
      _fpToEnemy.normalize();
      if (_fpDir.dot(_fpToEnemy) < 0) continue;
      // Massive impulse away from player — closer bugs get pushed harder
      const falloff = 1 - (dist / 54) * 0.5; // 1.0 at point blank, 0.5 at max range
      en.vel.addScaledVector(_fpToEnemy, 60 * falloff);
      en.vy = 6;
    }

    // Spawn sonic wave rings
    const muzzlePos = new THREE.Vector3();
    forceGunView.getMuzzleWorld(muzzlePos);
    const waveDir = _fpDir.clone();
    for (let i = 0; i < 3; i++) {
      const delay = i * 0.06;
      const torus = new THREE.Mesh(
        new THREE.TorusGeometry(0.3, 0.04, 8, 32),
        new THREE.MeshBasicMaterial({ color: 0x00b4ff, transparent: true, opacity: 0.8 })
      );
      torus.position.copy(muzzlePos);
      torus.lookAt(muzzlePos.clone().add(waveDir));
      scene.add(torus);
      forceWaves.push({ mesh: torus, dir: waveDir.clone(), age: -delay, maxAge: 0.4 });
    }

    // Blue muzzle flash
    const flashLight = new THREE.PointLight(0x00b4ff, 3, 8);
    flashLight.position.copy(muzzlePos);
    scene.add(flashLight);
    forceWaves.push({ mesh: flashLight, dir: null, age: 0, maxAge: 0.12, isLight: true });
  }

  function updateForceWaves(dt) {
    for (let i = forceWaves.length - 1; i >= 0; i--) {
      const w = forceWaves[i];
      w.age += dt;
      if (w.age < 0) { w.mesh.visible = false; continue; }
      w.mesh.visible = true;
      if (w.age >= w.maxAge) {
        scene.remove(w.mesh);
        if (w.mesh.geometry) w.mesh.geometry.dispose();
        if (w.mesh.material) w.mesh.material.dispose();
        forceWaves.splice(i, 1);
        continue;
      }
      if (w.isLight) {
        w.mesh.intensity = 3 * (1 - w.age / w.maxAge);
      } else {
        const t = w.age / w.maxAge;
        const s = 1 + t * 11;
        w.mesh.scale.setScalar(s);
        w.mesh.material.opacity = 0.8 * (1 - t);
        w.mesh.position.addScaledVector(w.dir, dt * 30);
      }
    }
  }

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

  let smoothCamY = player.pos.y; // smoothed camera Y to avoid terrain jitter
  let smoothGroundY = map.gy(player.pos.x, player.pos.z); // smoothed terrain height

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

  // ── Speed boost state ─────────────────────────────────────────────────
  let speedBoostActive = false;
  let speedBoostEnd = 0;

  // ── Trap pull/hold state ─────────────────────────────────────────────
  let trapActive = false;
  const trapTarget = new THREE.Vector3();
  let trapEnd = 0;
  let trapRopeLine = null; // actually a THREE.Group now
  const ROPE_SEGMENTS = 24;
  const _ropeVec = new THREE.Vector3();
  const _ropeLook = new THREE.Vector3();

  function createTrapRope(color) {
    const group = new THREE.Group();

    // ── Cone hook at the player end ──
    const coneGeo = new THREE.ConeGeometry(0.18, 0.7, 6);
    coneGeo.rotateX(Math.PI / 2); // point along +Z by default
    const coneMat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.6, roughness: 0.5,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    group.add(cone);
    group.userData.cone = cone;

    // ── Rope tube (TubeGeometry rebuilt each frame is expensive, use a thick line via cylinder segments) ──
    // Use a BufferGeometry ribbon with multiple segments for the rope strand
    const ropePositions = new Float32Array((ROPE_SEGMENTS + 1) * 3);
    const ropeGeo = new THREE.BufferGeometry();
    ropeGeo.setAttribute("position", new THREE.Float32BufferAttribute(ropePositions, 3));
    const ropeMat = new THREE.LineBasicMaterial({ color, linewidth: 2 });
    const ropeLine = new THREE.Line(ropeGeo, ropeMat);
    group.add(ropeLine);
    group.userData.ropeLine = ropeLine;

    // ── Secondary thinner strand for organic feel ──
    const strand2Pos = new Float32Array((ROPE_SEGMENTS + 1) * 3);
    const strand2Geo = new THREE.BufferGeometry();
    strand2Geo.setAttribute("position", new THREE.Float32BufferAttribute(strand2Pos, 3));
    const strand2Mat = new THREE.LineBasicMaterial({
      color, linewidth: 1, transparent: true, opacity: 0.5,
    });
    const strand2 = new THREE.Line(strand2Geo, strand2Mat);
    group.add(strand2);
    group.userData.strand2 = strand2;

    // Store initial distance for retraction animation
    group.userData.initialDist = 0;
    group.userData.color = color;

    return group;
  }

  function updateTrapRope(group, ax, ay, az, bx, by, bz, time) {
    const cone = group.userData.cone;
    const ropeLine = group.userData.ropeLine;
    const strand2 = group.userData.strand2;

    const dx = ax - bx, dy = ay - by, dz = az - bz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Track initial distance for retraction ratio
    if (group.userData.initialDist === 0 && dist > 1) {
      group.userData.initialDist = dist;
    }
    const retract = group.userData.initialDist > 0
      ? Math.max(0, 1 - dist / group.userData.initialDist)
      : 0;

    // ── Position cone at the player end, pointing toward egg sac ──
    cone.position.set(bx, by, bz);
    _ropeLook.set(ax, ay, az);
    cone.lookAt(_ropeLook);

    // ── Build rope curve from egg sac (a) to player (b) ──
    // As player gets pulled closer, rope "retracts" — fewer segments visible,
    // remaining segments bunch up near egg sac
    const ropePos = ropeLine.geometry.attributes.position;
    const strand2Pos = strand2.geometry.attributes.position;
    const sag = Math.min(dist * 0.2, 5) * (1 - retract * 0.7);
    const waveAmp = 0.08 + (1 - retract) * 0.12; // organic wiggle reduces as rope retracts

    for (let i = 0; i <= ROPE_SEGMENTS; i++) {
      const t = i / ROPE_SEGMENTS;
      // Ease the rope — bunch segments toward the egg sac end as it retracts
      const eased = t;
      const x = ax + (bx - ax) * eased;
      const z = az + (bz - az) * eased;
      // Parabolic droop
      const droop = -sag * 4 * eased * (1 - eased);
      // Organic wave along rope
      const wave = Math.sin(eased * Math.PI * 3 + time * 4) * waveAmp * (1 - eased);
      const y = ay + (by - ay) * eased + droop;

      // Main rope strand
      ropePos.setXYZ(i, x, y + wave, z);

      // Secondary strand — offset slightly for organic thickness
      const off = Math.sin(eased * Math.PI * 2.5 + time * 3 + 1.5) * waveAmp * 0.7 * (1 - eased);
      // Perpendicular offset (cross the direction with up)
      const perpX = -dz / (dist || 1) * 0.15;
      const perpZ = dx / (dist || 1) * 0.15;
      strand2Pos.setXYZ(i, x + perpX + off * perpX * 3, y + off, z + perpZ + off * perpZ * 3);
    }
    ropePos.needsUpdate = true;
    strand2Pos.needsUpdate = true;
  }

  function removeTrapRopeVisual() {
    if (!trapRopeLine) return;
    scene.remove(trapRopeLine);
    // Dispose geometries
    trapRopeLine.userData.cone.geometry.dispose();
    trapRopeLine.userData.cone.material.dispose();
    trapRopeLine.userData.ropeLine.geometry.dispose();
    trapRopeLine.userData.ropeLine.material.dispose();
    trapRopeLine.userData.strand2.geometry.dispose();
    trapRopeLine.userData.strand2.material.dispose();
    trapRopeLine = null;
  }
  const activeTrapIndices = new Set(); // tracks which egg sac traps are armed (for shooting)

  const input = attachInput({
    element: renderer.domElement,
    onSwapWeapon: () => swapWeapon(),
    onLookDelta: (dx, dy) => {
      player.yaw += dx;
      player.pitch = clamp(player.pitch + dy, -1.45, 1.45);
    },
    onLockChange: (locked) => {
      ui.msg(locked ? "" : "Click game to lock mouse.");
    },
  });

  function hud() {
    // In PvP mode, show countdown from server timeRemaining; otherwise show elapsed
    const useCountdown = isMultiplayer && !isCoopMode && serverTimeRemaining >= 0;
    ui.hud({
      hp: player.hp,
      maxHp: 200,
      enemies: enemies.length,
      kills: game.kills,
      deaths: game.deaths,
      progress: map.cart.p,
      elapsed: useCountdown ? serverTimeRemaining : game.elapsed,
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
    // Gamepad left stick movement
    const gp = input.gamepad;
    if (gp.connected) {
      if (gp.moveY !== 0) out.addScaledVector(fwd, -gp.moveY);
      if (gp.moveX !== 0) out.addScaledVector(right, gp.moveX);
    }
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
    const rawY = map.gy(player.pos.x, player.pos.z);
    // Smooth terrain height to prevent jitter on uneven ground
    smoothGroundY += (rawY - smoothGroundY) * Math.min(1, 25 * lastDt);
    const y = smoothGroundY;
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

  // Acid bug mouth particles — subtle green wisps
  const ACID_PARTICLE_COUNT = 5;
  const acidParticleGeo = new THREE.SphereGeometry(0.02, 4, 4);
  const acidParticleMats = [
    new THREE.MeshBasicMaterial({ color: 0x00dd44, transparent: true, opacity: 0.5 }),
    new THREE.MeshBasicMaterial({ color: 0x33ff55, transparent: true, opacity: 0.4 }),
    new THREE.MeshBasicMaterial({ color: 0x00aa22, transparent: true, opacity: 0.45 }),
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

  function spawnWall(id, progress, hp) {
    const geo = new THREE.BoxGeometry(RTS.WALL_WIDTH, RTS.WALL_HEIGHT, RTS.WALL_DEPTH);
    const mat = new THREE.MeshStandardMaterial({
      map: nestWallTex,
      color: 0xb08a7a,
      roughness: 0.88,
      emissive: 0x2a0e08,
      emissiveIntensity: 0.6,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const pt = map.getTrackPoint(progress);
    const tan = map.getTrackTangent(progress);
    const angle = Math.atan2(tan.x, tan.z);
    const y = map.gy(pt.x, pt.z);
    mesh.position.set(pt.x, y + RTS.WALL_HEIGHT / 2, pt.z);
    mesh.rotation.y = angle;
    mesh.userData.isWall = true;
    mesh.userData.wallId = id;
    map.world.add(mesh);
    targets.push(mesh);
    const w = { id, mesh, mat, hp, maxHp: hp, progress };
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
    // model's head faces +Z in GLB; no rotation needed
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
  function spawnAlienBugAt(networkId, x, z, hp, speed, bugType, dormant) {
    const m = mkAlienBug();
    m.g.position.set(x, map.gy(x, z), z);
    map.world.add(m.g);
    // Create acid mouth particles for acid bugs
    let acidParticles = null;
    if (bugType === "acid") {
      acidParticles = [];
      const headBone = m.model.getObjectByName("Head");
      const anchor = headBone || m.model;
      for (let i = 0; i < ACID_PARTICLE_COUNT; i++) {
        const mat = acidParticleMats[i % acidParticleMats.length].clone();
        const p = new THREE.Mesh(acidParticleGeo, mat);
        // Random phase offset so particles drift independently
        p.userData.phase = Math.random() * Math.PI * 2;
        p.userData.speed = 0.3 + Math.random() * 0.4;
        p.userData.radius = 0.04 + Math.random() * 0.04;
        p.userData.life = Math.random(); // 0-1 normalized lifetime
        anchor.add(p);
        acidParticles.push(p);
      }
    }

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
      acidParticles,
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
      dormant: !!dormant,
    });
    if (dormant) {
      const en = enemies[enemies.length - 1];
      setEnemyAction(en, "idle");
    }
    rebuildRayTargets();
    hud();
  }

  // Original singleplayer spawn (used as fallback)
  function spawnAlienBug() {
    const a = Math.random() * Math.PI * 2;
    const r = 7 + Math.random() * 6;
    const x = WORLD.NEST_X + Math.cos(a) * r;
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
    const spread = (input.pointer.aim || input.gamepad.aim) ? weapon.ads : weapon.hip;
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
  const otherPlayers = new Map(); // sessionId → { group, model, mixer }
  const FPS_COLORS = WORLD.FPS_COLORS;

  // Pre-load human model (gun is now part of HumanBase.glb)
  let humanGLTF = null;
  {
    const [{ GLTFLoader }, su] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js/+esm"),
      import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/utils/SkeletonUtils.js/+esm"),
    ]);
    if (!skeletonClone) skeletonClone = su.clone;
    const loader = new GLTFLoader();
    humanGLTF = await loader.loadAsync("./assets/HumanBase.glb");
  }

  // Zone mapping: joint index -> body zone (based on HumanBase.glb skeleton)
  // 0=hips,1=spine,2=chest -> torso; 3=neck,4=head -> head;
  // 5-27=left arm/hand, 28-50=right arm/hand -> arms;
  // 51-54=left leg, 55-58=right leg -> legs
  const JOINT_ZONE = [];
  for (let i = 0; i <= 58; i++) {
    if (i <= 2) JOINT_ZONE[i] = "torso";
    else if (i <= 4) JOINT_ZONE[i] = "head";
    else if (i <= 50) JOINT_ZONE[i] = "arms";
    else JOINT_ZONE[i] = "legs";
  }

  function applyZoneColors(model, customColors) {
    const base = new THREE.Color(customColors.base);
    const zoneColors = {
      head:  new THREE.Color(customColors.head || customColors.base),
      torso: new THREE.Color(customColors.torso || customColors.base),
      arms:  new THREE.Color(customColors.arms || customColors.base),
      legs:  new THREE.Color(customColors.legs || customColors.base),
    };

    model.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      // Skip gun meshes — only color the player body (basemesh_male)
      if (!obj.name.startsWith("basemesh_male")) return;
      const geo = obj.geometry;
      const joints = geo.getAttribute("skinIndex");
      if (!joints) {
        // No joint data — apply base color
        obj.material = new THREE.MeshStandardMaterial({ color: base, roughness: 0.6 });
        return;
      }

      // Create a vertex color buffer based on zone per vertex
      const count = geo.getAttribute("position").count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        // Get the dominant joint (highest weight, usually the first one)
        const jointIdx = joints.getX(i);
        const zone = JOINT_ZONE[jointIdx] || "torso";
        const c = zoneColors[zone];
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      obj.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
    });
  }

  function createPlayerModel(colorIndex, customColors) {
    const color = FPS_COLORS[colorIndex] || 0x00cc44;
    const group = new THREE.Group();

    // Clone the full scene to preserve bone hierarchy
    const model = skeletonClone(humanGLTF.scene);
    model.scale.setScalar(1.35);
    model.rotation.y = Math.PI; // face forward

    if (customColors && customColors.base) {
      applyZoneColors(model, customColors);
    } else {
      // Default: single color from FPS_COLORS (skip gun meshes)
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
      model.traverse((obj) => {
        if (obj.isMesh && obj.name.startsWith("basemesh_male")) obj.material = mat;
      });
    }

    group.add(model);

    // Apply gun_hold pose if available
    let mixer = null;
    const clips = humanGLTF.animations;
    if (clips && clips.length > 0) {
      const gunHoldClip = THREE.AnimationClip.findByName(clips, "gun_hold");
      if (gunHoldClip) {
        mixer = new THREE.AnimationMixer(model);
        const action = mixer.clipAction(gunHoldClip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        mixer.setTime(0);
      }
    }

    return { group, model, mixer };
  }

  const _otherCustomizations = new Map(); // sessionId -> { base, head, torso, arms, legs }

  function syncOtherPlayers(state, mySessionId) {
    const seen = new Set();
    state.players.forEach((p, sid) => {
      if (sid === mySessionId) return;
      if (p.role !== "fps") return;
      seen.add(sid);

      let op = otherPlayers.get(sid);
      if (!op) {
        const customColors = _otherCustomizations.get(sid) || null;
        op = createPlayerModel(p.colorIndex, customColors);
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

  // Rebuild an existing other player's model with new customization
  function rebuildOtherPlayer(sid, colors) {
    _otherCustomizations.set(sid, colors);
    const op = otherPlayers.get(sid);
    if (!op) return; // they'll get it when spawned
    // Remove old model, create new one with custom colors
    const pos = op.group.position.clone();
    const rot = op.group.rotation.clone();
    scene.remove(op.group);
    const state = room && room.state;
    const p = state && state.players.get(sid);
    const colorIndex = p ? p.colorIndex : 0;
    const newOp = createPlayerModel(colorIndex, colors);
    newOp.group.position.copy(pos);
    newOp.group.rotation.copy(rot);
    newOp._tx = op._tx; newOp._ty = op._ty; newOp._tz = op._tz;
    newOp._tyaw = op._tyaw; newOp._tpitch = op._tpitch;
    scene.add(newOp.group);
    otherPlayers.set(sid, newOp);
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

      // Update animation mixer (keeps GunHold pose applied)
      if (op.mixer) op.mixer.update(dt);
    }
  }
  // ──────────────────────────────────────────────────────────────────────

  // ── Network state ──────────────────────────────────────────────────────
  let room = null;
  let isMultiplayer = false;
  let serverTimeRemaining = -1; // -1 means use local elapsed timer
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
    if (!(input.pointer.locked || input.gamepad.connected) || game.win || game.resp || !game.started) return;
    const now = performance.now() / 1000;
    if (now < weapon.can) return;

    weapon.can = now + 1 / weapon.rate;

    const isAiming = input.pointer.aim || input.gamepad.aim;
    const recoilMul = isAiming ? 0.72 : 1;
    player.pitch = clamp(player.pitch + weapon.rp * recoilMul, -1.45, 1.45);
    player.yaw += (Math.random() * 2 - 1) * weapon.ry * (isAiming ? 0.55 : 1);
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
    let hitTrapIndex = null;
    if (hits.length) {
      camHit = hits[0].point.clone();
      const o = hits[0].object;
      if (o?.userData?.enemyRoot) {
        enemy = o.userData.enemyRoot;
        part = o.userData.hitPart || "body";
      } else if (o?.userData?.isWall) {
        hitWallId = o.userData.wallId;
      } else if (o?.userData?.isEggTrap) {
        hitTrapIndex = o.userData.trapIndex;
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
    let finalTrapIndex = hitTrapIndex;
    if (muzzleHits.length && muzzleHits[0].distance < d - 0.02) {
      finalHit = muzzleHits[0].point.clone();
      const mo = muzzleHits[0].object;
      if (mo?.userData?.isWall) {
        finalWallId = mo.userData.wallId;
        eRoot = null;
        finalTrapIndex = null;
      } else if (mo?.userData?.isEggTrap) {
        finalTrapIndex = mo.userData.trapIndex;
        eRoot = null;
        finalWallId = null;
      } else {
        eRoot = mo?.userData?.enemyRoot || null;
        ePart = mo?.userData?.hitPart || "body";
        finalWallId = null;
        finalTrapIndex = null;
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

    // Egg sac trap hit — shoot to destroy before it catches you
    if (finalTrapIndex != null && activeTrapIndices.has(finalTrapIndex)) {
      if (room && isMultiplayer) {
        // Multiplayer: only teammates (not trapped player) can shoot
        if (!trapActive) room.send("trapHit", { index: finalTrapIndex, dmg: weapon.dmg });
      } else {
        // Singleplayer: handle trap HP locally
        if (!aiCmd.trapHp) aiCmd.trapHp = {};
        if (aiCmd.trapHp[finalTrapIndex] === undefined) aiCmd.trapHp[finalTrapIndex] = RTS.EGG_TRAP_HP;
        aiCmd.trapHp[finalTrapIndex] -= weapon.dmg;
        if (aiCmd.trapHp[finalTrapIndex] <= 0) {
          // Destroy the trap
          activeTrapIndices.delete(finalTrapIndex);
          aiCmd.usedTraps.add(finalTrapIndex);
          aiCmd.activatedTraps.delete(finalTrapIndex);
          // Release if currently caught
          if (trapActive && aiCmd.trapHoldTimers.has(finalTrapIndex)) {
            aiCmd.trapHoldTimers.delete(finalTrapIndex);
            trapActive = false;
            removeTrapRopeVisual();
            if (activeWeapon === "force") forceGunView.gun.visible = true;
            else weaponView.gun.visible = true;
          }
          if (map.eggSacMeshes && map.eggSacMeshes[finalTrapIndex]) {
            map.eggSacMeshes[finalTrapIndex].traverse((child) => {
              if (child.isMesh && child.userData.isEggTrap) {
                const ti = targets.indexOf(child);
                if (ti >= 0) targets.splice(ti, 1);
                child.userData.isEggTrap = false;
              }
            });
            rebuildRayTargets();
          }
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
    const x = WORLD.NEST_X + Math.cos(a) * r;
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

  // ── AI Commander (singleplayer & coop hazards) ────────────────────────
  const aiCmd = {
    nextWallId: 1,
    lastWallProgress: 0,       // track progress where last wall was placed
    wallCooldown: 0,           // seconds until next wall can spawn
    activatedTraps: new Set(), // trap indices already activated
    usedTraps: new Set(),      // traps that have fired and are done
    trapCheckTimer: 0,         // seconds until next trap proximity scan
    trapHoldTimers: new Map(), // trapIndex → { endTime, eggX, eggZ }
  };

  function aiCommanderTick(dt, t) {
    // Only in singleplayer or coop (host only)
    if (isMultiplayer && !isCoopMode) return;
    if (isCoopMode && !isEnemyHost) return;
    if (!game.started || game.win) return;

    const cartP = map.cart.p;

    // ── AI Wall spawning ──
    // Spawn walls ahead of the cart as it progresses
    aiCmd.wallCooldown -= dt;
    if (aiCmd.wallCooldown <= 0 && cartP > 0.1 && cartP < 0.9) {
      // Spawn wall when cart has advanced ~15-20% since last wall
      if (cartP >= aiCmd.lastWallProgress + 0.15) {
        // Place wall just ahead of cart (2-4% ahead on the track)
        const wallProgress = Math.min(0.95, cartP + 0.02 + Math.random() * 0.02);
        const wallId = "aiw" + (aiCmd.nextWallId++);
        spawnWall(wallId, wallProgress, RTS.WALL_HP);
        aiCmd.lastWallProgress = cartP;
        aiCmd.wallCooldown = 20 + Math.random() * 10; // 20-30 seconds between walls
      }
    }

    // ── AI Trap activation ──
    // Periodically check if any egg sacs are near the cart's current position
    aiCmd.trapCheckTimer -= dt;
    if (aiCmd.trapCheckTimer <= 0) {
      aiCmd.trapCheckTimer = 2; // check every 2 seconds
      if (map.eggSacPositions && cartP > 0.05) {
        const cartPt = map.getTrackPoint(cartP);
        for (let i = 0; i < map.eggSacPositions.length; i++) {
          if (aiCmd.activatedTraps.has(i) || aiCmd.usedTraps.has(i)) continue;
          const egg = map.eggSacPositions[i];
          const d = Math.hypot(egg.x - cartPt.x, egg.z - cartPt.z);
          // Activate traps that are near the track ahead of the cart (within trap radius)
          if (d < RTS.EGG_TRAP_RADIUS * 0.8) {
            // Only activate a limited number — scale with progress
            if (aiCmd.activatedTraps.size >= 2 + Math.floor(cartP * 4)) continue;
            aiCmd.activatedTraps.add(i);
            activeTrapIndices.add(i);
            // Mark egg sac meshes as shootable
            if (map.eggSacMeshes && map.eggSacMeshes[i]) {
              map.eggSacMeshes[i].traverse((child) => {
                if (child.isMesh) {
                  child.userData.isEggTrap = true;
                  child.userData.trapIndex = i;
                  if (!targets.includes(child)) targets.push(child);
                }
              });
              rebuildRayTargets();
            }
          }
        }
      }
    }

    // ── AI Trap proximity trigger (pull player) ──
    for (const trapIndex of activeTrapIndices) {
      if (aiCmd.trapHoldTimers.has(trapIndex)) continue; // already triggered
      if (trapActive) continue; // player already caught by another trap
      const egg = map.eggSacPositions[trapIndex];
      if (!egg) continue;
      const dx = player.pos.x - egg.x;
      const dz = player.pos.z - egg.z;
      if (Math.hypot(dx, dz) < RTS.EGG_TRAP_RADIUS) {
        // Trigger the trap
        trapActive = true;
        trapTarget.set(egg.x, 0, egg.z);
        trapEnd = t + RTS.EGG_TRAP_HOLD_DURATION;
        aiCmd.trapHoldTimers.set(trapIndex, {
          endTime: t + RTS.EGG_TRAP_HOLD_DURATION,
          eggX: egg.x, eggZ: egg.z,
        });
        // Create rope visual
        removeTrapRopeVisual();
        trapRopeLine = createTrapRope(0x88ff44);
        const ey = map.gy(egg.x, egg.z) + 2;
        updateTrapRope(trapRopeLine, egg.x, ey, egg.z, player.pos.x, player.pos.y, player.pos.z, t);
        scene.add(trapRopeLine);
      }
    }

    // ── AI Trap damage tick + release ──
    const dmgPerSec = RTS.EGG_TRAP_DAMAGE / RTS.EGG_TRAP_HOLD_DURATION;
    for (const [trapIndex, trap] of aiCmd.trapHoldTimers) {
      if (t < trap.endTime) {
        // Deal damage
        if (!game.resp) {
          player.hp -= dmgPerSec * dt;
          player.hp = Math.max(0, player.hp);
          if (player.hp <= 0) killPlayer();
          hud();
        }
      } else {
        // Release
        aiCmd.trapHoldTimers.delete(trapIndex);
        trapActive = false;
        removeTrapRopeVisual();
        // Restore gun visibility
        if (activeWeapon === "force") forceGunView.gun.visible = true;
        else weaponView.gun.visible = true;
        // Deactivate the trap (one-time use)
        activeTrapIndices.delete(trapIndex);
        aiCmd.usedTraps.add(trapIndex);
        if (map.eggSacMeshes && map.eggSacMeshes[trapIndex]) {
          map.eggSacMeshes[trapIndex].traverse((child) => {
            if (child.isMesh && child.userData.isEggTrap) {
              const ti = targets.indexOf(child);
              if (ti >= 0) targets.splice(ti, 1);
              child.userData.isEggTrap = false;
            }
          });
          rebuildRayTargets();
        }
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  function killPlayer() {
    if (game.resp || game.win) return;
    game.deaths++;
    game.resp = true;
    game.respT = 3;
    player.hp = 0;
    weaponView.gun.visible = false;
    forceGunView.gun.visible = false;
    ui.setStatus("Killed - Respawning...");
    ui.banner("YOU WERE SHREDDED", 1.8);
    drawGunSplatter();
    hud();
  }

  function respawnPlayer() {
    game.resp = false;
    player.hp = 200;
    player.vel.set(0, 0, 0);
    // Clear trap on respawn
    trapActive = false;
    removeTrapRopeVisual();
    player.pos.set(
      WORLD.SPAWN_X,
      map.gy(WORLD.SPAWN_X, WORLD.SPAWN_Z) + player.height,
      WORLD.SPAWN_Z
    );
    player.yaw = WORLD.SPAWN_YAW;
    player.pitch = 0;
    player.height = 1.75;
    game.deathRoll = 0;
    smoothCamY = player.pos.y;
    smoothGroundY = map.gy(player.pos.x, player.pos.z);
    if (activeWeapon === "force") {
      forceGunView.gun.visible = true;
    } else {
      weaponView.gun.visible = true;
    }
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
        map.cart.p += (map.cart.fwd * dt) / map.trackLength;
        ui.setStatus("Escorting car to nest");
      } else if (game.resp && !isMultiplayer) {
        // Only roll back in singleplayer — in multiplayer another player may be pushing
        map.cart.p -= (map.cart.back * dt) / map.trackLength;
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

    // Block cart at wall positions (progress-based)
    for (const w of walls) {
      if (map.cart.p >= w.progress - 0.005) {
        map.cart.p = Math.min(map.cart.p, w.progress - 0.005);
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
      if (en.dormant) {
        setEnemyAction(en, "idle");
      } else {
        setEnemyAction(en, dist > 0.8 ? "run" : "attack");
      }
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
      if (!en.dormant) {
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

      // Dormant bugs stay idle — skip all movement/attack
      if (en.dormant) {
        en.mixer.update(dt);
        setEnemyAction(en, "idle");
        en.flash = Math.max(0, en.flash - dt);
        if (en.flash > 0) {
          en.mat.emissive.setHex(0x250404);
          en.mat.emissiveIntensity = 1;
        } else {
          en.mat.emissive.setHex(0);
          en.mat.emissiveIntensity = 0;
        }
        continue;
      }

      // Find nearest player target (local + other co-op players)
      let trg = map.car.position;
      let bestDist = Infinity;
      const localInSafe = Math.hypot(player.pos.x - WORLD.SPAWN_X, player.pos.z - WORLD.SPAWN_Z) <= WORLD.SPAWN_SAFE_RADIUS;
      if (!game.resp && !localInSafe) {
        const d = Math.hypot(player.pos.x - en.mesh.position.x, player.pos.z - en.mesh.position.z);
        if (d < bestDist) { bestDist = d; trg = player.pos; }
      }
      for (const [, op] of otherPlayers) {
        const opx = op._tx, opz = op._tz;
        const opInSafe = Math.hypot(opx - WORLD.SPAWN_X, opz - WORLD.SPAWN_Z) <= WORLD.SPAWN_SAFE_RADIUS;
        if (opInSafe) continue;
        const d = Math.hypot(opx - en.mesh.position.x, opz - en.mesh.position.z);
        if (d < bestDist) { bestDist = d; trg = { x: opx, z: opz }; }
      }
      const dx = trg.x - en.mesh.position.x;
      const dz = trg.z - en.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      const want = Math.atan2(dx, dz);
      let dy = want - en.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      en.yaw += dy * Math.min(1, en.tr * dt);

      const f = new THREE.Vector3(Math.sin(en.yaw), 0, Math.cos(en.yaw));
      if (!en.air) {
        const m = dist > 0.8 ? 1 : 0;
        const spd = speedBoostActive ? en.s * 2 : en.s;
        const move = f.multiplyScalar(spd * m);
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

      // Animate acid mouth particles — subtle drift upward around mouth
      if (en.acidParticles) {
        const t = performance.now() / 1000;
        for (const p of en.acidParticles) {
          p.userData.life += dt * p.userData.speed;
          if (p.userData.life > 1) p.userData.life -= 1;
          const life = p.userData.life;
          const phase = p.userData.phase;
          const rad = p.userData.radius;
          // Orbit around mouth area, drift upward, fade in/out
          p.position.set(
            Math.sin(t * 1.5 + phase) * rad,
            life * 0.12,
            -0.08 + Math.cos(t * 1.2 + phase) * rad * 0.5
          );
          // Fade: peak in middle, invisible at edges
          const fade = Math.sin(life * Math.PI);
          p.material.opacity = fade * 0.5;
          p.scale.setScalar(0.6 + fade * 0.6);
        }
      }

      en.atk = Math.max(0, en.atk - dt);
      // Damage applies to local player based on distance to local player (not target)
      const localDist = Math.hypot(player.pos.x - en.mesh.position.x, player.pos.z - en.mesh.position.z);
      if (en.atk <= 0 && localDist < 1.5 * BUG_SCALE) {
        en.atk = 0.75;
        if (!game.resp && !localInSafe) {
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

  // ── Gamepad menu navigation helper ──────────────────────────────────
  function gamepadMenuNav(buttons, onSelect) {
    let focusIndex = 0;
    let running = true;
    let lastDpad = 0;
    let lastA = false;
    const REPEAT_DELAY = 200;
    const GLOW = "0 0 12px rgba(0,180,255,.7)";

    function highlight(i) {
      buttons.forEach((b, j) => {
        b.style.boxShadow = j === i ? GLOW : "";
        b.style.borderColor = j === i ? "#00b4ff" : "";
      });
    }
    highlight(focusIndex);

    function loop() {
      if (!running) return;
      const gp = navigator.getGamepads ? navigator.getGamepads()[0] : null;
      if (gp) {
        const now = performance.now();
        const upDown = (gp.buttons[13] && gp.buttons[13].pressed ? 1 : 0)
                     - (gp.buttons[12] && gp.buttons[12].pressed ? 1 : 0);
        const stickY = Math.abs(gp.axes[1]) > 0.5 ? Math.sign(gp.axes[1]) : 0;
        const dir = upDown || stickY;
        if (dir && now - lastDpad > REPEAT_DELAY) {
          focusIndex = (focusIndex + (dir > 0 ? 1 : buttons.length - 1)) % buttons.length;
          highlight(focusIndex);
          lastDpad = now;
        } else if (!dir) {
          lastDpad = 0;
        }
        const aPressed = gp.buttons[0] && gp.buttons[0].pressed;
        if (aPressed && !lastA) {
          if (onSelect) onSelect(focusIndex);
          else buttons[focusIndex].click();
        }
        lastA = aPressed;
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    return {
      stop() {
        running = false;
        buttons.forEach(b => { b.style.boxShadow = ""; b.style.borderColor = ""; });
      },
      setButtons(newBtns) { buttons = newBtns; if (focusIndex >= buttons.length) focusIndex = 0; highlight(focusIndex); }
    };
  }

  async function showWinOverlay() {
    document.exitPointerLock();
    recordGame({ role: "fps", won: true, kills: game.kills, deaths: game.deaths });
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
    gamepadMenuNav([btn]);
  }

  function showGameOver(winner) {
    document.exitPointerLock();
    game.win = true;
    if (winner !== "disconnect") {
      recordGame({ role: "fps", won: winner === "fps", kills: game.kills, deaths: game.deaths });
    }
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
    gamepadMenuNav([btn]);
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
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = 8 + Math.random() * 40;
      const red = 90 + Math.floor(Math.random() * 60);
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.5 + Math.random() * 0.8), Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${red},0,0,${0.6 + Math.random() * 0.4})`;
      ctx.fill();
      // satellite drops
      for (let j = 0; j < 6; j++) {
        const sx = x + (Math.random() - 0.5) * r * 4;
        const sy = y + (Math.random() - 0.5) * r * 4;
        const sr = 2 + Math.random() * 10;
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${red},0,0,${0.45 + Math.random() * 0.5})`;
        ctx.fill();
      }
      // drip
      if (Math.random() > 0.3) {
        const dripLen = 30 + Math.random() * 90;
        ctx.beginPath();
        ctx.moveTo(x, y + r);
        ctx.quadraticCurveTo(x + (Math.random() - 0.5) * 10, y + r + dripLen * 0.5, x + (Math.random() - 0.5) * 8, y + r + dripLen);
        ctx.lineWidth = 2 + Math.random() * 5;
        ctx.strokeStyle = `rgba(${red},0,0,${0.5 + Math.random() * 0.45})`;
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
  let lastDt = 0.016;
  let bob = 0;
  let groundFactor = 1; // smoothed 0..1 ground vs air for bob blending
  function loop() {
    requestAnimationFrame(loop);
    const t = performance.now() / 1000;
    const dt = Math.min(0.033, t - last);
    last = t;
    lastDt = dt;

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

    // Poll gamepad state
    input.pollGamepad(dt);
    const gp = input.gamepad;

    wish(wishMove);
    const sprint = input.keys.has("ShiftLeft") || input.keys.has("ShiftRight") || gp.sprint;
    const speed = player.ground ? (sprint ? player.ss : player.ws) : player.as;

    if (!game.resp && !game.win && game.started && !trapActive) {
      if (player.ground) {
        friction(player.fg, dt);
        accel(wishMove, speed, player.ag, dt);
      } else {
        friction(player.fa, dt);
        accel(wishMove, speed, player.aa, dt);
      }
      player.vel.y -= player.g * dt;
      if (player.ground && (input.keys.has("Space") || gp.jump)) {
        player.vel.y = player.j;
        player.ground = false;
      }
    } else {
      friction(9, dt);
      player.vel.y -= player.g * dt;
    }

    player.pos.addScaledVector(player.vel, dt);
    collidePlayer();

    // ── Trap pull/hold ──
    if (trapActive && !game.resp) {
      // Hide guns while trapped to avoid bob jitter
      weaponView.gun.visible = false;
      forceGunView.gun.visible = false;
      const tdx = trapTarget.x - player.pos.x;
      const tdz = trapTarget.z - player.pos.z;
      const tdist = Math.hypot(tdx, tdz);
      const stopDist = RTS.EGG_TRAP_STOP_DIST;
      if (tdist > stopDist) {
        // Pull toward egg sac, stop just outside the model
        const nx = tdx / tdist;
        const nz = tdz / tdist;
        player.vel.x = nx * RTS.EGG_TRAP_PULL_SPEED;
        player.vel.z = nz * RTS.EGG_TRAP_PULL_SPEED;
      } else {
        // Hold in place at edge of egg sac
        player.vel.x = 0;
        player.vel.z = 0;
      }
      // Kill bob while trapped
      player.vel.y = 0;
      // Update rope visual
      if (trapRopeLine) {
        const ey = map.gy(trapTarget.x, trapTarget.z) + 2;
        updateTrapRope(trapRopeLine, trapTarget.x, ey, trapTarget.z, player.pos.x, player.pos.y, player.pos.z, t);
      }
      // Client-side fallback release
      if (t > trapEnd) {
        trapActive = false;
        removeTrapRopeVisual();
        // Restore gun visibility
        if (activeWeapon === "force") forceGunView.gun.visible = true;
        else weaponView.gun.visible = true;
      }
    }

    // ── Speed boost timer ──
    if (speedBoostActive && t > speedBoostEnd) {
      speedBoostActive = false;
    }

    if (game.resp) {
      game.respT -= dt;
      if (game.respT <= 0) respawnPlayer();
    }

    carTick(dt);

    // Checkpoint pickup detection
    if (!checkpointReached) {
      const cdx = player.pos.x - checkpointRing.position.x;
      const cdz = player.pos.z - checkpointRing.position.z;
      if (Math.hypot(cdx, cdz) < 6) {
        checkpointReached = true;
        scene.remove(checkpointRing);
        ui.banner("FORCE GUN ACQUIRED \u2014 Press Q / Y to switch", 3);
      }
    }

    spawnTick(dt);
    aiCommanderTick(dt, t);
    aiTick(dt, t);
    networkTick(dt);
    lerpOtherPlayers(dt);

    const hs = Math.hypot(player.vel.x, player.vel.z);
    // Smooth ground factor to prevent bob jitter at terrain transitions
    const gfTarget = player.ground ? 1 : 0;
    groundFactor += (gfTarget - groundFactor) * Math.min(1, 12 * dt);
    bob += (hs * (0.2 + 0.8 * groundFactor)) * dt * 2.8;
    const by = Math.sin(bob) * 0.035 * groundFactor;
    const bx = Math.cos(bob * 0.5) * 0.02 * groundFactor;
    // Smooth camera Y to prevent jitter on uneven terrain
    const camYTarget = player.pos.y + by;
    const camLerp = Math.min(1, 20 * dt);
    smoothCamY += (camYTarget - smoothCamY) * camLerp;
    camera.position.set(player.pos.x + bx, smoothCamY, player.pos.z);

    veil.style.opacity = game.resp ? (game.respT / 3) * 0.55 : 0;

    const aiming = input.pointer.aim || gp.aim;
    const fov = aiming ? 30 : sprint ? 100 : 94;
    camera.fov += (fov - camera.fov) * Math.min(1, 12 * dt);
    camera.updateProjectionMatrix();
    ui.setCrosshairAim(aiming, trapActive);

    const sway = aiming ? 0.35 : 1;
    const movingForward = (input.keys.has("KeyW") && !input.keys.has("KeyS")) || gp.moveY < -0.3;
    const swayFreqX = 2.1;
    const swayFreqY = movingForward ? 1.25 : 2;
    const swx = (Math.sin(t * swayFreqX) * 0.014 + bx * 0.8) * sway;
    const swy = (Math.cos(t * swayFreqY) * 0.01 + by * 0.7) * sway;

    hipOffset.set(0.41 + swx, 0.08 + swy, -0.44);
    adsOffset.set(0.24 + swx * 0.4, 0.13 + swy * 0.4, -0.3);
    const activeView = activeWeapon === "force" ? forceGunView : weaponView;
    weaponView.gun.position.copy(camera.position);
    weaponView.gun.quaternion.copy(camera.quaternion);
    weaponView.gun.position.add((aiming ? adsOffset : hipOffset).clone().applyQuaternion(camera.quaternion));
    weaponView.settle(dt);
    const forceHipOffset = hipOffset.clone();
    forceHipOffset.y -= 0.35;
    const forceAdsOffset = adsOffset.clone();
    forceAdsOffset.y -= 0.35;
    forceGunView.gun.position.copy(camera.position);
    forceGunView.gun.quaternion.copy(camera.quaternion);
    forceGunView.gun.position.add((aiming ? forceAdsOffset : forceHipOffset).applyQuaternion(camera.quaternion));
    forceGunView.settle(dt);
    laserLine.visible = activeWeapon === "smg" && !trapActive;
    if (activeWeapon === "smg" && !trapActive) updateLaser();
    updateForceWaves(dt);

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

    if (input.pointer.fire || gp.fire) {
      if (activeWeapon === "force") shootForcePush();
      else shoot();
    }
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
  // Get player name from auth (skip old start screen)
  const user = await getUser();
  playerName = user ? getDisplayName(user) : "Anonymous";
  ui.msg("Click the game to lock mouse.");

  // ── Multiplayer connection ─────────────────────────────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const paramRoomId = urlParams.get("roomId");
  const paramCreate = urlParams.get("create") === "true";
  const paramRoomName = urlParams.get("roomName");
  const paramRole = urlParams.get("role") || "fps";

  let waitingOverlay = null;
  let waitingGpNav = null;
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

    // Show waiting overlay with start buttons
    waitingOverlay = document.createElement("div");
    waitingOverlay.style.cssText = [
      "position:fixed", "inset:0", "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "background:rgba(0,0,0,0.75)", "z-index:999", "gap:18px",
      "font-family:monospace",
    ].join(";");
    const waitPlayerCount = document.createElement("h2");
    waitPlayerCount.id = "wait-player-count";
    waitPlayerCount.textContent = "Shooters: 1/4";
    waitPlayerCount.style.cssText = "color:#00b4ff;font-size:32px;letter-spacing:3px;";
    const btnCoopStart = document.createElement("button");
    btnCoopStart.id = "btn-coop-start";
    btnCoopStart.textContent = "Start Solo";
    btnCoopStart.style.cssText = [
      "padding:16px 48px", "font-size:22px", "font-family:monospace",
      "background:#c0000a", "color:#fff", "border:none", "border-radius:6px",
      "cursor:pointer", "letter-spacing:3px",
    ].join(";");
    btnCoopStart.addEventListener("click", () => {
      if (room) room.send("requestStart", { mode: "coop" });
    });
    const btnPvpStart = document.createElement("button");
    btnPvpStart.id = "btn-pvp-start";
    btnPvpStart.textContent = "Start PvP";
    btnPvpStart.disabled = true;
    btnPvpStart.style.cssText = [
      "padding:16px 48px", "font-size:22px", "font-family:monospace",
      "background:#333", "color:#666", "border:none", "border-radius:6px",
      "cursor:not-allowed", "letter-spacing:3px",
    ].join(";");
    btnPvpStart.addEventListener("click", () => {
      if (room && !btnPvpStart.disabled) room.send("requestStart", { mode: "pvp" });
    });
    const waitSub = document.createElement("p");
    waitSub.textContent = "Waiting for players to join...";
    waitSub.style.cssText = "color:#888;font-size:14px;";
    waitingOverlay.append(waitPlayerCount, btnCoopStart, btnPvpStart, waitSub);
    document.body.appendChild(waitingOverlay);
    waitingGpNav = gamepadMenuNav([btnCoopStart, btnPvpStart]);

    // Listen for player count updates
    room.onMessage("playerCount", (data) => {
      const el = document.getElementById("wait-player-count");
      if (el) el.textContent = "Shooters: " + data.fpsCount + "/4";
      const coopBtn = document.getElementById("btn-coop-start");
      if (coopBtn) coopBtn.textContent = data.fpsCount >= 2 ? "Start Co-op" : "Start Solo";
      const pvpBtn = document.getElementById("btn-pvp-start");
      if (pvpBtn) {
        if (data.hasRts) {
          pvpBtn.disabled = false;
          pvpBtn.style.background = "#c0000a";
          pvpBtn.style.color = "#fff";
          pvpBtn.style.cursor = "pointer";
        } else {
          pvpBtn.disabled = true;
          pvpBtn.style.background = "#333";
          pvpBtn.style.color = "#666";
          pvpBtn.style.cursor = "not-allowed";
        }
      }
    });

    // Listen for game start
    room.onMessage("gameStart", (data) => {
      console.log("[network] Game started! Mode:", data.mode);
      if (waitingOverlay && waitingOverlay.parentNode) {
        document.body.removeChild(waitingOverlay);
        waitingOverlay = null;
      }
      if (waitingGpNav) { waitingGpNav.stop(); waitingGpNav = null; }
      renderer.domElement.requestPointerLock();
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
      console.log("[network] Spawning enemy:", data.id, data.bugType || "basic", data.dormant ? "(dormant)" : "");
      spawnAlienBugAt(data.id, data.x, data.z, data.hp, data.speed, data.bugType, data.dormant);
    });

    // Dormant enemy wakes up
    room.onMessage("enemyWake", (data) => {
      const en = enemies.find((e) => e.networkId === data.id);
      if (en) {
        en.dormant = false;
        setEnemyAction(en, "run");
      }
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

    // Speed boost — all bugs move 2x speed
    room.onMessage("speedBoost", () => {
      speedBoostActive = true;
      speedBoostEnd = performance.now() / 1000 + RTS.SPEED_BOOST_DURATION;
      ui.banner("BUGS ENRAGED — 2X SPEED!", 3);
    });

    // Trap triggered — pull player to egg sac
    room.onMessage("trapTriggered", (data) => {
      if (data.playerSid === mySessionId) {
        trapActive = true;
        trapTarget.set(data.eggX, 0, data.eggZ);
        trapEnd = performance.now() / 1000 + RTS.EGG_TRAP_HOLD_DURATION;
        ui.banner("TRAPPED!", 2);
        // Create rope line visual
        removeTrapRopeVisual();
        trapRopeLine = createTrapRope(0xffcc00);
        const ey = map.gy(data.eggX, data.eggZ) + 2;
        updateTrapRope(trapRopeLine, data.eggX, ey, data.eggZ, player.pos.x, player.pos.y, player.pos.z, performance.now() / 1000);
        scene.add(trapRopeLine);
      }
    });

    // Trap released
    room.onMessage("trapReleased", (data) => {
      if (data.playerSid === mySessionId) {
        trapActive = false;
        removeTrapRopeVisual();
        // Restore gun visibility
        if (activeWeapon === "force") forceGunView.gun.visible = true;
        else weaponView.gun.visible = true;
      }
    });

    // Trap damage tick
    room.onMessage("trapDamage", (data) => {
      if (data.playerSid === mySessionId && !game.resp) {
        player.hp -= data.dmg;
        player.hp = Math.max(0, player.hp);
        hud();
        if (player.hp <= 0) killPlayer();
      }
    });

    // Trap activated — track for shooting
    room.onMessage("trapActivated", (data) => {
      activeTrapIndices.add(data.index);
      // Add egg sac meshes as shoot targets
      if (map.eggSacMeshes && map.eggSacMeshes[data.index]) {
        const group = map.eggSacMeshes[data.index];
        group.traverse((child) => {
          if (child.isMesh) {
            child.userData.isEggTrap = true;
            child.userData.trapIndex = data.index;
            if (!targets.includes(child)) targets.push(child);
          }
        });
        rebuildRayTargets();
      }
    });

    // Trap deactivated — remove from shoot targets
    room.onMessage("trapDeactivated", (data) => {
      activeTrapIndices.delete(data.index);
      if (map.eggSacMeshes && map.eggSacMeshes[data.index]) {
        const group = map.eggSacMeshes[data.index];
        group.traverse((child) => {
          if (child.isMesh && child.userData.isEggTrap) {
            const ti = targets.indexOf(child);
            if (ti >= 0) targets.splice(ti, 1);
            child.userData.isEggTrap = false;
          }
        });
        rebuildRayTargets();
      }
    });

    // Wall spawned by commander
    room.onMessage("wallSpawn", (data) => {
      console.log("[network] Wall spawned:", data.id);
      spawnWall(data.id, data.progress, data.hp);
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
        smoothCamY = player.pos.y;
        smoothGroundY = map.gy(sp.x, sp.z);
        player.yaw = sp.yaw;
      }
    });

    // Send our customization to the room
    const myCustom = getCachedCustomization();
    if (myCustom && myCustom.base_color) {
      room.send("customization", {
        base: myCustom.base_color,
        head: myCustom.head_color || null,
        torso: myCustom.torso_color || null,
        arms: myCustom.arms_color || null,
        legs: myCustom.legs_color || null,
      });
    }

    // Receive other players' customizations
    room.onMessage("playerCustomization", (data) => {
      rebuildOtherPlayer(data.sid, data.colors);
    });
    room.onMessage("allCustomizations", (data) => {
      for (const [sid, colors] of Object.entries(data)) {
        _otherCustomizations.set(sid, colors);
      }
    });

    // Sync other FPS player block models + enemy sync
    room.onStateChange((state) => {
      syncOtherPlayers(state, mySessionId);
      updateHostStatus();
      if (state.timeRemaining !== undefined) serverTimeRemaining = state.timeRemaining;

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
