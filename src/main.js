import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { ASSETS, WORLD } from "./constants.js";
import { createUI } from "./ui.js";
import { attachInput } from "./input.js";
import { createWorld } from "./world.js";
import { createWeaponView } from "./weaponView.js";

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

  const game = { win: false, deaths: 0, kills: 0, resp: false, respT: 0, spawnT: 0, deathRoll: 0, elapsed: 0, startTime: 0 };
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

  function spawnAlienBug() {
    const m = mkAlienBug();
    const a = Math.random() * Math.PI * 2;
    const r = 7 + Math.random() * 6;
    const x = Math.cos(a) * r;
    const z = WORLD.NEST_Z + Math.sin(a) * r;
    m.g.position.set(x, map.gy(x, z), z);
    map.world.add(m.g);
    const hp = 58 + game.deaths * 12 + Math.random() * 20;
    const s = 5.4 + game.deaths * 0.25 + Math.random();
    enemies.push({
      mesh: m.g,
      mixer: m.mixer,
      actions: m.actions,
      mat: m.mat,
      bodyProxy: m.bodyProxy,
      headProxy: m.headProxy,
      curAction: m.curAction,
      hp,
      vel: new THREE.Vector3(),
      yaw: Math.random() * Math.PI * 2,
      s,
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

  function shoot() {
    if (!input.pointer.locked || game.win || game.resp) return;
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
    if (hits.length) {
      camHit = hits[0].point.clone();
      const o = hits[0].object;
      if (o?.userData?.enemyRoot) {
        enemy = o.userData.enemyRoot;
        part = o.userData.hitPart || "body";
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
    if (muzzleHits.length && muzzleHits[0].distance < d - 0.02) {
      finalHit = muzzleHits[0].point.clone();
      eRoot = muzzleHits[0].object?.userData?.enemyRoot || null;
      ePart = muzzleHits[0].object?.userData?.hitPart || "body";
    }

    spawnTracer(muzzle.clone(), finalHit.clone());
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
    spawnGore(gorePos);
    map.world.remove(en.mesh);
    enemies.splice(enemies.indexOf(en), 1);
    rebuildRayTargets();
    hud();
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

  const spawnInterval = () => Math.max(0.34, 2.2 - game.deaths * 0.3 - map.cart.p * 1.1);
  const maxEnemies = () => 12 + game.deaths * 4 + Math.floor(map.cart.p * 8);

  function spawnTick(dt) {
    if (game.win) return;
    game.spawnT -= dt;
    if (game.spawnT > 0) return;
    game.spawnT = spawnInterval();
    if (enemies.length >= maxEnemies()) return;
    for (let i = 0; i < Math.min(1 + (game.deaths >= 2 ? 1 : 0), 3); i++) spawnAlienBug();
  }

  function killPlayer() {
    if (game.resp || game.win) return;
    game.deaths++;
    game.resp = true;
    game.respT = 3;
    player.hp = 0;
    ui.setStatus("Killed - Respawning...");
    ui.banner("YOU WERE SHREDDED", 1.8);
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
      } else if (game.resp) {
        map.cart.p -= (map.cart.back * dt) / (WORLD.TRACK_START - WORLD.TRACK_END);
        ui.setStatus("Car rolling back - spawn rate rising");
      } else {
        ui.setStatus("Get close to the rail car");
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
      setTimeout(showWinOverlay, 3500);
    }
  }

  function aiTick(dt, t) {
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
    btn.onclick = () => location.reload();

    ov.append(winTitle, stats, lb, btn);
    document.body.appendChild(ov);
  }
  // ──────────────────────────────────────────────────────────────────────

  const veil = document.getElementById("veil");

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

    if (!game.resp && !game.win) {
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

    hipOffset.set(0.23 + swx, -0.28 + swy, -0.44);
    adsOffset.set(0.06 + swx * 0.4, -0.23 + swy * 0.4, -0.3);
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
  ui.banner("ESCORT THE CAR TO THE NEST", 2);
  game.startTime = performance.now() / 1000;
  last = performance.now() / 1000;
  loop();

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}
