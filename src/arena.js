import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { ASSETS, FORCE_GUN_ASSETS, WORLD } from "./constants.js";
import { createUI } from "./ui.js";
import { attachInput } from "./input.js";
import { isMobile } from "./touch.js";
import { createArenaWorld, ARENA_SPAWN_POINTS, FALL_THRESHOLD } from "./arenaWorld.js";
import { createWeaponView } from "./weaponView.js";
import { createArenaRoom, joinArenaRoom } from "./network.js";
import { getUser, getDisplayName, getCachedCustomization } from "./supabase.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function setLoading(pct, label) {
  const bar = document.getElementById('loading-bar');
  const lbl = document.getElementById('loading-label');
  const screen = document.getElementById('loading-screen');
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = pct + '% — ' + label;
  if (pct >= 100 && screen) {
    screen.style.opacity = '0';
    setTimeout(() => screen.remove(), 400);
  }
}

export async function initArena() {
  const ui = createUI();

  const scene = new THREE.Scene();
  const skyTex = new THREE.TextureLoader().load("./assets/sky.png");
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;
  scene.fog = new THREE.Fog(0x2d1f16, 30, 220);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(94, innerWidth / innerHeight, 0.05, 600);
  scene.add(new THREE.HemisphereLight(0xffc98a, 0x2a1b13, 0.62));
  const sun = new THREE.DirectionalLight(0xffb15c, 1.35);
  sun.position.set(120, 180, 30);
  scene.add(sun);

  setLoading(5, 'Building arena...');
  const map = createArenaWorld(scene);
  setLoading(20, 'Loading weapons...');
  const weaponView = await createWeaponView(scene, ASSETS);
  setLoading(35, 'Loading force gun...');
  const forceGunView = await createWeaponView(scene, FORCE_GUN_ASSETS);
  forceGunView.gun.visible = false;

  // ── Local player jetpack flame (visible from below) — two thrusters ──
  const localFlame = new THREE.Group();
  localFlame.visible = false;
  scene.add(localFlame);
  const LOCAL_SPREAD = 0.18;
  const localFlameCoreL = new THREE.Mesh(
    new THREE.ConeGeometry(0.12, 0.8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.9 })
  );
  localFlameCoreL.rotation.x = Math.PI;
  localFlameCoreL.position.set(-LOCAL_SPREAD, -0.4, 0);
  localFlame.add(localFlameCoreL);
  const localFlameCoreR = new THREE.Mesh(
    new THREE.ConeGeometry(0.12, 0.8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.9 })
  );
  localFlameCoreR.rotation.x = Math.PI;
  localFlameCoreR.position.set(LOCAL_SPREAD, -0.4, 0);
  localFlame.add(localFlameCoreR);
  const localFlameOuterL = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 1.1, 8),
    new THREE.MeshBasicMaterial({ color: 0xff2200, transparent: true, opacity: 0.45 })
  );
  localFlameOuterL.rotation.x = Math.PI;
  localFlameOuterL.position.set(-LOCAL_SPREAD, -0.5, 0);
  localFlame.add(localFlameOuterL);
  const localFlameOuterR = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 1.1, 8),
    new THREE.MeshBasicMaterial({ color: 0xff2200, transparent: true, opacity: 0.45 })
  );
  localFlameOuterR.rotation.x = Math.PI;
  localFlameOuterR.position.set(LOCAL_SPREAD, -0.5, 0);
  localFlame.add(localFlameOuterR);
  const localFlameLight = new THREE.PointLight(0xff6600, 2, 6);
  localFlameLight.position.y = -0.3;
  localFlame.add(localFlameLight);

  // ── Force gun checkpoint (center of platform) ─────────────────────────
  let activeWeapon = "smg";
  let checkpointReached = false;
  const checkpointRing = new THREE.Mesh(
    new THREE.RingGeometry(0, 6, 48),
    new THREE.MeshBasicMaterial({ color: 0x00b4ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
  );
  checkpointRing.rotation.x = -Math.PI / 2;
  checkpointRing.position.set(0, 0.08, 0);
  map.world.add(checkpointRing);

  // Floating force gun display model above checkpoint
  let floatingGun = null;
  {
    const { gltfLoader } = await import("./gltfLoader.js");
    const gltf = await gltfLoader.loadAsync(FORCE_GUN_ASSETS.gunModelUrl);
    setLoading(50, 'Loading players...');
    floatingGun = gltf.scene;
    floatingGun.scale.setScalar(1.5);
    floatingGun.position.set(0, 1.2, 0);
    map.world.add(floatingGun);
  }

  function swapWeapon() {
    if (!checkpointReached || game.resp || !game.started) return;
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

  // ── Force push ────────────────────────────────────────────────────────
  const forceWaves = [];
  const _fpDir = new THREE.Vector3();
  const _fpToPlayer = new THREE.Vector3();
  const forceWeapon = { rate: 0.5, can: 0 };

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
        const tNorm = w.age / w.maxAge;
        w.mesh.scale.setScalar(1 + tNorm * 11);
        w.mesh.material.opacity = 0.8 * (1 - tNorm);
        w.mesh.position.addScaledVector(w.dir, dt * 30);
      }
    }
  }

  function shootForcePush() {
    if (!(input.pointer.locked || input.gamepad.connected || input.touch.active) || game.resp || !game.started) return;
    const now = performance.now() / 1000;
    if (now < forceWeapon.can) return;
    forceWeapon.can = now + 1 / forceWeapon.rate;

    forceGunSound.currentTime = 0;
    forceGunSound.play().catch(() => {});
    forceGunView.kick();

    _fpDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _fpDir.y = 0;
    _fpDir.normalize();

    // Push other players within range
    for (const [sid, op] of otherPlayers) {
      _fpToPlayer.set(op._tx - player.pos.x, 0, op._tz - player.pos.z);
      const dist = _fpToPlayer.length();
      if (dist > 15 || dist < 0.1) continue;
      _fpToPlayer.normalize();
      if (_fpDir.dot(_fpToPlayer) < 0) continue;
      const falloff = 1 - (dist / 15) * 0.5;
      if (room) {
        room.send("pvpPush", {
          targetSid: sid,
          vx: _fpToPlayer.x * 30 * falloff,
          vy: 4,
          vz: _fpToPlayer.z * 30 * falloff,
        });
      }
    }

    // Sonic wave rings visual
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
    const flashLight = new THREE.PointLight(0x00b4ff, 3, 8);
    flashLight.position.copy(muzzlePos);
    scene.add(flashLight);
    forceWaves.push({ mesh: flashLight, dir: null, age: 0, maxAge: 0.12, isLight: true });
  }

  // ── Player state ────────────────────────────────────────────────────────
  const player = {
    pos: new THREE.Vector3(0, 1.75, 16),
    vel: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    ground: false,
    hp: 500,
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
    // Jetpack
    jetFuel: 150,
    jetFuelMax: 150,
    jetRechargeRate: 30,   // fuel per second when not boosting
    jetDrainRate: 40,      // fuel per second while boosting
    jetThrust: 32,         // upward acceleration while boosting (must exceed gravity of 22)
    jetMaxVelY: 8,         // max upward speed from jetpack
  };

  let smoothCamY = player.pos.y;
  let smoothGroundY = 0;

  const game = {
    win: false, started: false, deaths: 0, kills: 0,
    resp: false, respT: 0, deathRoll: 0, elapsed: 0, startTime: 0,
  };

  const weapon = {
    rate: 11.2, hip: 0.011, ads: 0.0032,
    dmg: 36, range: 280, rp: 0.028, ry: 0.008, can: 0,
  };

  // ── Input ───────────────────────────────────────────────────────────────
  // ── Quit / pause menu ────────────────────────────────────────────────
  const quitOverlay = document.getElementById("quit-overlay");
  const resumeBtn = document.getElementById("resume-btn");
  const quitBtn = document.getElementById("quit-btn");
  const menuBtnEl = document.getElementById("menu-btn");
  let menuOpen = false;
  let quitMenuGpNav = null;

  function toggleMenu() {
    if (game.win) return;
    menuOpen = !menuOpen;
    if (menuOpen) {
      document.exitPointerLock();
      quitOverlay.classList.add("open");
      quitMenuGpNav = gamepadMenuNav([resumeBtn, quitBtn]);
      input?.setTouchVisible?.(false);
    } else {
      quitOverlay.classList.remove("open");
      if (quitMenuGpNav) { quitMenuGpNav.stop(); quitMenuGpNav = null; }
      input?.setTouchVisible?.(true);
      if (!isMobile) renderer.domElement.requestPointerLock();
    }
  }

  if (resumeBtn) resumeBtn.onclick = () => toggleMenu();
  if (quitBtn) quitBtn.onclick = () => { window.location.href = "/"; };
  if (menuBtnEl) menuBtnEl.onclick = () => toggleMenu();

  const input = attachInput({
    element: renderer.domElement,
    onSwapWeapon: () => swapWeapon(),
    onLookDelta: (dx, dy) => {
      if (menuOpen) return;
      player.yaw += dx;
      player.pitch = clamp(player.pitch + dy, -1.45, 1.45);
    },
    onLockChange: (locked) => {
      if (!menuOpen && !isMobile) ui.msg(locked ? "" : "Click game to lock mouse.");
    },
    onMenu: () => toggleMenu(),
  });

  // ── HUD ─────────────────────────────────────────────────────────────────
  function hud() {
    ui.hud({
      hp: player.hp,
      maxHp: 500,
      enemies: otherPlayers.size + 1,
      kills: game.kills,
      deaths: game.deaths,
      progress: 0,
      elapsed: game.elapsed,
      jetFuel: player.jetFuel,
      jetFuelMax: player.jetFuelMax,
    });
  }

  // ── Movement helpers ────────────────────────────────────────────────────
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
    const gp = input.gamepad;
    if (gp.connected) {
      if (gp.moveY !== 0) out.addScaledVector(fwd, -gp.moveY);
      if (gp.moveX !== 0) out.addScaledVector(right, gp.moveX);
    }
    const tc = input.touch;
    if (tc.active) {
      if (tc.moveY !== 0) out.addScaledVector(fwd, -tc.moveY);
      if (tc.moveX !== 0) out.addScaledVector(right, tc.moveX);
    }
    if (out.lengthSq() > 0) out.normalize();
    return out;
  }

  function accel(dir, spd, a, dt) {
    const current = player.vel.dot(dir);
    const add = spd - current;
    if (add <= 0) return;
    player.vel.addScaledVector(dir, Math.min(add, a * dt * spd));
  }

  function friction(v, dt) {
    const speed = Math.hypot(player.vel.x, player.vel.z);
    if (speed < 1e-4) return;
    const k = Math.max(0, speed - speed * v * dt) / speed;
    player.vel.x *= k;
    player.vel.z *= k;
  }

  let lastDt = 0.016;

  function collidePlayer() {
    const feetY = player.pos.y - player.height + 0.5; // tolerance so fast falls don't clip through
    const rawY = map.gy(player.pos.x, player.pos.z, feetY);
    // Snap up instantly (landing on platform), smooth down (walking off edge)
    if (rawY > smoothGroundY) smoothGroundY = rawY;
    else smoothGroundY += (rawY - smoothGroundY) * Math.min(1, 25 * lastDt);
    const y = smoothGroundY;
    if (player.pos.y < y + player.height) {
      player.pos.y = y + player.height;
      if (player.vel.y < 0) player.vel.y = 0;
      player.ground = true;
    } else {
      player.ground = false;
    }
    // Fall detection
    if (player.pos.y < FALL_THRESHOLD && !game.resp && !game.win && game.started) {
      killPlayer();
    }
  }

  // ── Gore ────────────────────────────────────────────────────────────────
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
    for (let i = 0; i < 33; i++) {
      const isChunk = i < 7;
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
      scene.add(mesh);
      const speed = isChunk ? 2.5 + Math.random() * 4 : 1.5 + Math.random() * 6;
      const angle = Math.random() * Math.PI * 2;
      gore.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(angle) * speed, speed * (0.4 + Math.random() * 0.9), Math.sin(angle) * speed),
        life: 0.7 + Math.random() * 1.1,
        bounces: 0,
      });
    }
    while (gore.length > 300) { scene.remove(gore.shift().mesh); }
  }

  // ── Tracers ──────────────────────────────────────────────────────────────
  const tracers = [];
  function spawnTracer(from, to) {
    const pts = [from, to];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0xffee88, transparent: true, opacity: 0.85 });
    const line = new THREE.Line(geo, mat);
    scene.add(line);
    tracers.push({ line, life: 0.06 });
  }

  // ── Blood splatter ───────────────────────────────────────────────────────
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
      for (let j = 0; j < 6; j++) {
        ctx.beginPath();
        ctx.arc(x + (Math.random() - 0.5) * r * 4, y + (Math.random() - 0.5) * r * 4, 2 + Math.random() * 10, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${red},0,0,${0.45 + Math.random() * 0.5})`;
        ctx.fill();
      }
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

  // ── Shell casings ─────────────────────────────────────────────────────
  const shellGeo = new THREE.SphereGeometry(0.03, 8, 8);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xb98a52, roughness: 0.45, metalness: 0.7 });
  const shells = [];
  const shellSpawnPos = new THREE.Vector3();
  const shellSpawnVel = new THREE.Vector3();

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
      spin: new THREE.Vector3((Math.random() - 0.5) * 15, (Math.random() - 0.5) * 15, (Math.random() - 0.5) * 15),
      life: 2.3, bounces: 0,
    });
  }

  // ── Muzzle flash ──────────────────────────────────────────────────────
  const muzzleFlashMat = new THREE.MeshBasicMaterial({ color: 0xffd07a, transparent: true, opacity: 0 });
  const muzzleFlash = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), muzzleFlashMat);
  scene.add(muzzleFlash);
  const muzzleFlashLight = new THREE.PointLight(0xffc36a, 0, 5, 2);
  scene.add(muzzleFlashLight);
  let muzzleFlashLife = 0;

  // ── Laser sight ───────────────────────────────────────────────────────
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

  // rayTargets: combined list for raycasting
  let rayTargets = [];
  function rebuildRayTargets() {
    rayTargets.length = 0;
    for (const c of map.colliders) rayTargets.push(c);
    // Add other player hitboxes
    for (const [, op] of otherPlayers) {
      if (op.hitBox) rayTargets.push(op.hitBox);
    }
  }

  function aimDir(out) {
    out.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const spread = (input.pointer.aim || input.gamepad.aim || input.touch.aim) ? weapon.ads : weapon.hip;
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
    if (hits.length) laserAimHit.copy(hits[0].point);
    else laserAimHit.copy(laserAimFrom).addScaledVector(laserDir, weapon.range);
    laserPoints[0].copy(muzzle);
    laserPoints[1].copy(laserAimHit);
    laserLine.geometry.setFromPoints(laserPoints);
  }

  // ── Shooting ──────────────────────────────────────────────────────────
  const gunSound = new Audio("./assets/smg.wav");
  gunSound.volume = 0.5;
  const forceGunSound = new Audio("./assets/forc_gun.flac");
  forceGunSound.volume = 0.5;
  const launchSound = new Audio("./assets/launch.wav");
  launchSound.volume = 0.5;
  launchSound.loop = true;

  function shoot() {
    if (!(input.pointer.locked || input.gamepad.connected || input.touch.active) || game.resp || !game.started) return;
    const now = performance.now() / 1000;
    if (now < weapon.can) return;
    weapon.can = now + 1 / weapon.rate;

    gunSound.currentTime = 0;
    gunSound.play().catch(() => {});

    const isAiming = input.pointer.aim || input.gamepad.aim || input.touch.aim;
    player.pitch = clamp(player.pitch + weapon.rp * (isAiming ? 0.72 : 1), -1.45, 1.45);
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
    let hitPlayerSid = null;
    if (hits.length) {
      camHit = hits[0].point.clone();
      const o = hits[0].object;
      if (o?.userData?.isOtherPlayer) hitPlayerSid = o.userData.targetSid;
    }

    weaponView.getMuzzleWorld(muzzle);
    muzzleDir.copy(camHit).sub(muzzle);
    const d = muzzleDir.length();
    muzzleDir.normalize();
    rayc.set(muzzle, muzzleDir);
    rayc.far = Math.max(0.1, d);
    const muzzleHits = rayc.intersectObjects(rayTargets, true);

    let finalHit = camHit.clone();
    let finalPlayerSid = hitPlayerSid;
    if (muzzleHits.length && muzzleHits[0].distance < d - 0.02) {
      finalHit = muzzleHits[0].point.clone();
      const mo = muzzleHits[0].object;
      finalPlayerSid = mo?.userData?.isOtherPlayer ? mo.userData.targetSid : null;
    }

    spawnTracer(muzzle.clone(), finalHit.clone());

    // Broadcast tracer to other players
    if (room) {
      room.send("playerShot", {
        fx: muzzle.x, fy: muzzle.y, fz: muzzle.z,
        tx: finalHit.x, ty: finalHit.y, tz: finalHit.z,
      });
    }

    if (finalPlayerSid) {
      // Hit another player
      const op = otherPlayers.get(finalPlayerSid);
      if (op && op.hitBox) {
        // Flash the hit box briefly
        op.hitBox.material.visible = true;
        op.hitBox.material.color.setHex(0xff2200);
        op.hitBox.material.opacity = 0.35;
        setTimeout(() => {
          op.hitBox.material.visible = false;
          op.hitBox.material.opacity = 0;
        }, 90);
      }
      if (room) {
        room.send("pvpHit", { targetSid: finalPlayerSid, dmg: weapon.dmg });
      }
    }
  }

  // ── Other FPS players ─────────────────────────────────────────────────
  const otherPlayers = new Map();
  const FPS_COLORS = WORLD.FPS_COLORS;

  let humanGLTF = null;
  let skeletonClone = null;
  {
    const [{ gltfLoader }, su] = await Promise.all([
      import("./gltfLoader.js"),
      import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/utils/SkeletonUtils.js/+esm"),
    ]);
    skeletonClone = su.clone;
    humanGLTF = await gltfLoader.loadAsync("./assets/new_shooter.glb");
    setLoading(85, 'Connecting...');
  }

  const JOINT_ZONE = [];
  for (let i = 0; i <= 58; i++) {
    if (i <= 2) JOINT_ZONE[i] = "torso";
    else if (i <= 4) JOINT_ZONE[i] = "head";
    else if (i <= 50) JOINT_ZONE[i] = "arms";
    else JOINT_ZONE[i] = "legs";
  }

  function applyZoneColors(model, customColors) {
    const zoneColors = {
      head:  new THREE.Color(customColors.head  || customColors.base),
      torso: new THREE.Color(customColors.torso || customColors.base),
      arms:  new THREE.Color(customColors.arms  || customColors.base),
      legs:  new THREE.Color(customColors.legs  || customColors.base),
    };
    model.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry || !obj.name.startsWith("basemesh_male")) return;
      const geo = obj.geometry;
      const joints = geo.getAttribute("skinIndex");
      if (!joints) {
        obj.material = new THREE.MeshStandardMaterial({ color: new THREE.Color(customColors.base), roughness: 0.6 });
        return;
      }
      const count = geo.getAttribute("position").count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const c = zoneColors[JOINT_ZONE[joints.getX(i)] || "torso"];
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      obj.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
    });
  }

  function createPlayerModel(colorIndex, customColors) {
    const color = FPS_COLORS[colorIndex] || 0x00cc44;
    const group = new THREE.Group();

    const model = skeletonClone(humanGLTF.scene);
    model.scale.setScalar(1.35);
    model.rotation.y = Math.PI;

    if (customColors && customColors.base) {
      applyZoneColors(model, customColors);
    } else {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
      model.traverse((obj) => { if (obj.isMesh && obj.name.startsWith("basemesh_male")) obj.material = mat; });
    }
    group.add(model);

    let mixer = null;
    let actions = { runForward: null, dead: null };
    const clips = humanGLTF.animations;
    if (clips && clips.length > 0) {
      mixer = new THREE.AnimationMixer(model);
      const fwdClip = THREE.AnimationClip.findByName(clips, "run_forward");
      if (fwdClip) {
        actions.runForward = mixer.clipAction(fwdClip);
        actions.runForward.setLoop(THREE.LoopRepeat, Infinity);
        actions.runForward.timeScale = 0; // start frozen at rest pose (frame 0)
        actions.runForward.play();
      }
      const deadClip = THREE.AnimationClip.findByName(clips, "dead");
      if (deadClip) {
        actions.dead = mixer.clipAction(deadClip);
        actions.dead.setLoop(THREE.LoopOnce, 1);
        actions.dead.clampWhenFinished = true;
      }
      mixer.setTime(0);
    }

    // Invisible hit box — centered on player body (group y = feet, so center at +0.875)
    const hitBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.78, 1.75, 0.78),
      new THREE.MeshBasicMaterial({ visible: false, transparent: true, opacity: 0 })
    );
    hitBox.position.set(0, 0.875, 0);
    group.add(hitBox);

    // Jetpack flame effect — two thrusters side by side
    const flameGroup = new THREE.Group();
    flameGroup.position.set(0, 0.6, 0.3);
    flameGroup.visible = false;
    group.add(flameGroup);

    const THRUSTER_SPREAD = 0.18; // half-distance between thrusters

    const flameCoreL = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.9 })
    );
    flameCoreL.rotation.x = Math.PI;
    flameCoreL.position.set(-THRUSTER_SPREAD, -0.4, 0);
    flameGroup.add(flameCoreL);

    const flameCoreR = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.9 })
    );
    flameCoreR.rotation.x = Math.PI;
    flameCoreR.position.set(THRUSTER_SPREAD, -0.4, 0);
    flameGroup.add(flameCoreR);

    const flameOuterL = new THREE.Mesh(
      new THREE.ConeGeometry(0.2, 1.1, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2200, transparent: true, opacity: 0.45 })
    );
    flameOuterL.rotation.x = Math.PI;
    flameOuterL.position.set(-THRUSTER_SPREAD, -0.5, 0);
    flameGroup.add(flameOuterL);

    const flameOuterR = new THREE.Mesh(
      new THREE.ConeGeometry(0.2, 1.1, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2200, transparent: true, opacity: 0.45 })
    );
    flameOuterR.rotation.x = Math.PI;
    flameOuterR.position.set(THRUSTER_SPREAD, -0.5, 0);
    flameGroup.add(flameOuterR);

    const flameGlow = new THREE.PointLight(0xff6600, 2, 6);
    flameGlow.position.y = -0.3;
    flameGroup.add(flameGlow);

    return { group, model, mixer, actions, curAction: "idle", hitBox, flameGroup, flameCoreL, flameCoreR, flameOuterL, flameOuterR };
  }

  const _otherCustomizations = new Map();

  function syncOtherPlayers(state, mySessionId) {
    const seen = new Set();
    state.players.forEach((p, sid) => {
      if (sid === mySessionId || p.role !== "fps") return;
      seen.add(sid);
      let op = otherPlayers.get(sid);
      if (!op) {
        const customColors = _otherCustomizations.get(sid) || null;
        op = createPlayerModel(p.colorIndex, customColors);
        op.hitBox.userData.isOtherPlayer = true;
        op.hitBox.userData.targetSid = sid;
        op._tx = p.x; op._ty = p.y; op._tz = p.z;
        op._tyaw = p.yaw; op._tpitch = p.pitch;
        scene.add(op.group);
        otherPlayers.set(sid, op);
        rebuildRayTargets();
      }
      op._tx = p.x; op._ty = p.y; op._tz = p.z;
      op._tyaw = p.yaw; op._tpitch = p.pitch;
      op._jetting = p.jetting || false;
      op._hp = p.hp;
    });

    for (const [sid, op] of otherPlayers) {
      if (!seen.has(sid)) {
        scene.remove(op.group);
        otherPlayers.delete(sid);
        rebuildRayTargets();
      }
    }
  }

  function lerpOtherPlayers(dt) {
    const rate = Math.min(1, 12 * dt);
    for (const [, op] of otherPlayers) {
      const g = op.group;
      g.position.x += (op._tx - g.position.x) * rate;
      g.position.y += ((op._ty - 1.75) - g.position.y) * rate;
      g.position.z += (op._tz - g.position.z) * rate;
      let dyaw = op._tyaw - g.rotation.y;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      g.rotation.y += dyaw * rate;

      if (op.mixer && op.actions) {
        const dead = op._hp !== undefined && op._hp <= 0;
        let wanted;
        if (dead) {
          wanted = "dead";
        } else {
          const dx = op._tx - g.position.x;
          const dz = op._tz - g.position.z;
          const moving = (dx * dx + dz * dz) > 0.001;
          wanted = moving ? "run" : "idle";
        }
        if (wanted !== op.curAction) {
          if (wanted === "dead" && op.actions.dead) {
            if (op.actions.runForward) op.actions.runForward.fadeOut(0.2);
            op._deathY = g.position.y;
            op.actions.dead.reset().fadeIn(0.2).play();
          } else if (op.curAction === "dead" && op.actions.runForward) {
            if (op.actions.dead) op.actions.dead.fadeOut(0.2);
            op._deathY = undefined;
            op.actions.runForward.reset().fadeIn(0.2).play();
            op.actions.runForward.timeScale = wanted === "run" ? 1 : 0;
          } else if (op.actions.runForward) {
            op.actions.runForward.timeScale = wanted === "run" ? 1 : 0;
          }
          op.curAction = wanted;
        }
        if (dead && op._deathY !== undefined) {
          g.position.y = op._deathY;
        }
        op.mixer.update(dt);
      }
      // Jetpack flame animation
      if (op.flameGroup) {
        op.flameGroup.visible = !!op._jetting;
        if (op._jetting) {
          const fL = 0.85 + Math.random() * 0.3;
          const fR = 0.85 + Math.random() * 0.3;
          op.flameCoreL.scale.set(fL, 0.7 + Math.random() * 0.5, fL);
          op.flameCoreR.scale.set(fR, 0.7 + Math.random() * 0.5, fR);
          op.flameOuterL.scale.set(fL, 0.7 + Math.random() * 0.4, fL);
          op.flameOuterR.scale.set(fR, 0.7 + Math.random() * 0.4, fR);
        }
      }
    }
  }

  // ── Network state ────────────────────────────────────────────────────
  let room = null;
  let mySessionId = null;
  let myColorIndex = 0;
  let networkSendTimer = 0;

  function networkTick(dt) {
    if (!room) return;
    networkSendTimer += dt;
    if (networkSendTimer < 0.1) return;
    networkSendTimer = 0;
    room.send("playerUpdate", {
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      yaw: player.yaw, pitch: player.pitch, hp: player.hp,
      jetting: player._jetting || false,
    });
  }

  // ── Death / Respawn ───────────────────────────────────────────────────
  const veil = document.getElementById("veil");

  function killPlayer() {
    if (game.resp || game.win) return;
    game.deaths++;
    game.resp = true;
    game.respT = 3;
    player.hp = 0;
    weaponView.gun.visible = false;
    forceGunView.gun.visible = false;
    ui.setStatus("Eliminated — Respawning...");
    ui.banner("YOU WERE ELIMINATED", 1.8);
    drawGunSplatter();
    hud();
  }

  function respawnPlayer() {
    game.resp = false;
    player.hp = 500;
    player.jetFuel = player.jetFuelMax;
    player.vel.set(0, 0, 0);
    const sp = ARENA_SPAWN_POINTS[myColorIndex] || ARENA_SPAWN_POINTS[0];
    player.pos.set(sp.x, player.height, sp.z);
    player.yaw = sp.yaw;
    player.pitch = 0;
    player.height = 1.75;
    game.deathRoll = 0;
    smoothCamY = player.pos.y;
    smoothGroundY = 0;
    if (activeWeapon === "force") forceGunView.gun.visible = true;
    else weaponView.gun.visible = true;
    ui.setStatus("Back in the fight");
    ui.banner("BACK IN", 1);
    clearGunSplatter();
    hud();
  }

  // ── Overlay helpers ───────────────────────────────────────────────────
  let playerName = "Anonymous";

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

  function gamepadMenuNav(buttons) {
    let focusIndex = 0;
    let running = true;
    let lastDpad = 0;
    let lastA = false;
    function highlight(i) {
      buttons.forEach((b, j) => {
        b.style.boxShadow = j === i ? "0 0 12px rgba(0,180,255,.7)" : "";
        b.style.borderColor = j === i ? "#00b4ff" : "";
      });
    }
    highlight(focusIndex);
    function loop() {
      if (!running) return;
      const gp = navigator.getGamepads ? navigator.getGamepads()[0] : null;
      if (gp) {
        const now = performance.now();
        const dir = (gp.buttons[13]?.pressed ? 1 : 0) - (gp.buttons[12]?.pressed ? 1 : 0)
                  || (Math.abs(gp.axes[1]) > 0.5 ? Math.sign(gp.axes[1]) : 0);
        if (dir && now - lastDpad > 200) {
          focusIndex = (focusIndex + (dir > 0 ? 1 : buttons.length - 1)) % buttons.length;
          highlight(focusIndex);
          lastDpad = now;
        } else if (!dir) lastDpad = 0;
        const aPressed = gp.buttons[0]?.pressed;
        if (aPressed && !lastA) buttons[focusIndex].click();
        lastA = aPressed;
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    return { stop() { running = false; buttons.forEach(b => { b.style.boxShadow = ""; b.style.borderColor = ""; }); } };
  }

  // ── Main render loop ──────────────────────────────────────────────────
  const hipOffset = new THREE.Vector3();
  const adsOffset = new THREE.Vector3();
  let last = performance.now() / 1000;
  let bob = 0;
  let groundFactor = 1;

  function loop() {
    requestAnimationFrame(loop);
    const t = performance.now() / 1000;
    const dt = Math.min(0.033, t - last);
    last = t;
    lastDt = dt;

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

    input.pollGamepad(dt);
    const gp = input.gamepad;

    if (!menuOpen) {

    wish(wishMove);
    const sprint = input.keys.has("ShiftLeft") || input.keys.has("ShiftRight") || gp.sprint || input.touch.sprint;
    const speed = player.ground ? (sprint ? player.ss : player.ws) : player.as;

    if (!game.resp && !game.win && game.started) {
      if (player.ground) {
        friction(player.fg, dt);
        accel(wishMove, speed, player.ag, dt);
      } else {
        friction(player.fa, dt);
        accel(wishMove, speed, player.aa, dt);
      }
      // Jetpack boost
      const jetInput = input.keys.has("Space") || gp.jumpHeld || input.touch.jump;
      if (jetInput && player.jetFuel > 0) {
        if (player.ground) {
          player.vel.y = 4;  // initial kick off ground
          player.ground = false;
        }
        player.vel.y -= player.g * 0.55 * dt; // reduced gravity while thrusting
        player.vel.y += player.jetThrust * dt;
        if (player.vel.y > player.jetMaxVelY) player.vel.y = player.jetMaxVelY;
        player.jetFuel = Math.max(0, player.jetFuel - player.jetDrainRate * dt);
        player._jetting = true;
        if (launchSound.paused) launchSound.play().catch(() => {});
      } else {
        // Soft gravity when airborne with fuel left — lets you feather thrust to hover
        const gScale = (!player.ground && player.jetFuel > 0) ? 0.6 : 1;
        player.vel.y -= player.g * gScale * dt;
        player._jetting = false;
        if (!launchSound.paused) { launchSound.pause(); launchSound.currentTime = 0; }
        if (!jetInput) {
          player.jetFuel = Math.min(player.jetFuelMax, player.jetFuel + player.jetRechargeRate * dt);
        }
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

    // Checkpoint pickup
    if (!checkpointReached && game.started && !game.resp) {
      if (floatingGun) {
        floatingGun.rotation.y += dt * 1.5;
        floatingGun.position.y = 1.2 + Math.sin(t * 2) * 0.3;
      }
      const cdx = player.pos.x - 0;
      const cdz = player.pos.z - 0;
      if (Math.hypot(cdx, cdz) < 6) {
        checkpointReached = true;
        map.world.remove(checkpointRing);
        if (floatingGun) { map.world.remove(floatingGun); floatingGun = null; }
        ui.banner("FORCE GUN ACQUIRED \u2014 Press Q / Y to switch", 3);
      }
    }

    networkTick(dt);
    lerpOtherPlayers(dt);

    const hs = Math.hypot(player.vel.x, player.vel.z);
    const gfTarget = player.ground ? 1 : 0;
    groundFactor += (gfTarget - groundFactor) * Math.min(1, 12 * dt);
    bob += (hs * (0.2 + 0.8 * groundFactor)) * dt * 2.8;
    const by = Math.sin(bob) * 0.035 * groundFactor;
    const bx = Math.cos(bob * 0.5) * 0.02 * groundFactor;
    const camYTarget = player.pos.y + by;
    smoothCamY += (camYTarget - smoothCamY) * Math.min(1, 20 * dt);
    camera.position.set(player.pos.x + bx, smoothCamY, player.pos.z);

    // Local jetpack flame
    localFlame.visible = !!player._jetting;
    if (player._jetting) {
      localFlame.position.set(player.pos.x, player.pos.y - player.height, player.pos.z);
      const fL = 0.85 + Math.random() * 0.3;
      const fR = 0.85 + Math.random() * 0.3;
      localFlameCoreL.scale.set(fL, 0.7 + Math.random() * 0.5, fL);
      localFlameCoreR.scale.set(fR, 0.7 + Math.random() * 0.5, fR);
      localFlameOuterL.scale.set(fL, 0.7 + Math.random() * 0.4, fL);
      localFlameOuterR.scale.set(fR, 0.7 + Math.random() * 0.4, fR);
    }

    veil.style.opacity = game.resp ? (game.respT / 3) * 0.55 : 0;

    const aiming = input.pointer.aim || gp.aim || input.touch.aim;
    const fov = aiming ? 30 : sprint ? 100 : 94;
    camera.fov += (fov - camera.fov) * Math.min(1, 12 * dt);
    camera.updateProjectionMatrix();
    ui.setCrosshairAim(aiming, false);

    const sway = aiming ? 0.35 : 1;
    const movingForward = (input.keys.has("KeyW") && !input.keys.has("KeyS")) || gp.moveY < -0.3 || input.touch.moveY < -0.3;
    const swx = (Math.sin(t * 2.1) * 0.014 + bx * 0.8) * sway;
    const swy = (Math.cos(t * (movingForward ? 1.25 : 2)) * 0.01 + by * 0.7) * sway;
    hipOffset.set(0.41 + swx, 0.08 + swy, -0.44);
    adsOffset.set(0.24 + swx * 0.4, 0.13 + swy * 0.4, -0.3);
    weaponView.gun.position.copy(camera.position);
    weaponView.gun.quaternion.copy(camera.quaternion);
    weaponView.gun.position.add((aiming ? adsOffset : hipOffset).clone().applyQuaternion(camera.quaternion));
    weaponView.settle(dt);

    const forceHipOffset = hipOffset.clone(); forceHipOffset.y -= 0.35;
    const forceAdsOffset = adsOffset.clone(); forceAdsOffset.y -= 0.35;
    forceGunView.gun.position.copy(camera.position);
    forceGunView.gun.quaternion.copy(camera.quaternion);
    forceGunView.gun.position.add((aiming ? forceAdsOffset : forceHipOffset).applyQuaternion(camera.quaternion));
    forceGunView.settle(dt);

    laserLine.visible = activeWeapon === "smg";
    if (activeWeapon === "smg") updateLaser();
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

    if (input.pointer.fire || gp.fire || input.touch.fire) {
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
      const floorY = map.gy(s.mesh.position.x, s.mesh.position.z);
      if (floorY > -100 && s.mesh.position.y < floorY + 0.03) {
        s.mesh.position.y = floorY + 0.03;
        if (s.vel.y < 0) { s.vel.y *= -0.35; s.vel.x *= 0.65; s.vel.z *= 0.65; s.bounces++; }
      }
      if (s.life <= 0 || s.bounces > 3) { scene.remove(s.mesh); shells.splice(i, 1); }
    }

    for (let i = tracers.length - 1; i >= 0; i--) {
      tracers[i].life -= dt;
      tracers[i].line.material.opacity = Math.max(0, tracers[i].life / 0.06);
      if (tracers[i].life <= 0) { scene.remove(tracers[i].line); tracers.splice(i, 1); }
    }

    for (let i = gore.length - 1; i >= 0; i--) {
      const g = gore[i];
      g.life -= dt;
      if (g.life <= 0) { scene.remove(g.mesh); gore.splice(i, 1); continue; }
      g.vel.y -= 16 * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      const floorY = map.gy(g.mesh.position.x, g.mesh.position.z);
      if (floorY > -100 && g.mesh.position.y < floorY) {
        g.mesh.position.y = floorY;
        if (g.vel.y < 0) { g.vel.y *= -0.25; g.vel.x *= 0.55; g.vel.z *= 0.55; }
      }
    }

    } // end if (!menuOpen)

    hud();
    renderer.render(scene, camera);
  }

  renderer.render(scene, camera);
  const user = await getUser();
  playerName = user ? getDisplayName(user) : "Anonymous";
  ui.msg("Click the game to lock mouse.");

  // ── Multiplayer connection ────────────────────────────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const paramRoomId = urlParams.get("roomId");
  const paramCreate = urlParams.get("create") === "true";
  const paramRoomName = urlParams.get("roomName");
  const paramAddBots = urlParams.get("addBots") === "true";

  let waitingOverlay = null;
  let waitingGpNav = null;

  try {
    if (paramCreate) {
      room = await createArenaRoom(paramRoomName || "Arena Room", paramAddBots);
    } else if (paramRoomId) {
      room = await joinArenaRoom(paramRoomId);
    } else {
      room = await createArenaRoom("Arena Room");
    }
    mySessionId = room.sessionId;
    setLoading(100, 'Ready!');

    // Waiting overlay
    waitingOverlay = document.createElement("div");
    waitingOverlay.style.cssText = [
      "position:fixed", "inset:0", "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "background:rgba(0,0,0,0.75)", "z-index:999", "gap:18px",
      "font-family:monospace",
    ].join(";");
    const waitTitle = document.createElement("h1");
    waitTitle.textContent = "ARENA MODE";
    waitTitle.style.cssText = "color:#c0000a;font-size:48px;letter-spacing:6px;margin:0;";
    const waitPlayerCount = document.createElement("h2");
    waitPlayerCount.id = "wait-player-count";
    waitPlayerCount.textContent = "Fighters: 1/4";
    waitPlayerCount.style.cssText = "color:#00b4ff;font-size:28px;letter-spacing:3px;margin:0;";
    const btnStart = document.createElement("button");
    btnStart.textContent = "START MATCH";
    btnStart.style.cssText = [
      "padding:16px 48px", "font-size:22px", "font-family:monospace",
      "background:#c0000a", "color:#fff", "border:none", "border-radius:6px",
      "cursor:pointer", "letter-spacing:3px",
    ].join(";");
    btnStart.addEventListener("click", () => {
      if (room) room.send("requestStart", {});
    });
    const waitSub = document.createElement("p");
    waitSub.textContent = "Waiting for fighters to join...";
    waitSub.style.cssText = "color:#888;font-size:14px;margin:0;";
    const backBtn = document.createElement("button");
    backBtn.textContent = "BACK TO MENU";
    backBtn.style.cssText = [
      "padding:10px 28px", "font-size:14px", "font-family:monospace",
      "background:#222", "color:#aaa", "border:1px solid #444", "border-radius:6px",
      "cursor:pointer", "letter-spacing:2px",
    ].join(";");
    backBtn.addEventListener("click", () => { window.location.href = "/"; });
    waitingOverlay.append(waitTitle, waitPlayerCount, btnStart, waitSub, backBtn);
    document.body.appendChild(waitingOverlay);
    waitingGpNav = gamepadMenuNav([btnStart, backBtn]);

    room.onMessage("playerCount", (data) => {
      const el = document.getElementById("wait-player-count");
      if (el) el.textContent = "Fighters: " + data.fpsCount + "/4";
    });

    room.onMessage("gameStart", () => {
      if (waitingOverlay && waitingOverlay.parentNode) {
        document.body.removeChild(waitingOverlay);
        waitingOverlay = null;
      }
      if (waitingGpNav) { waitingGpNav.stop(); waitingGpNav = null; }
      renderer.domElement.requestPointerLock();
      game.started = true;
      game.startTime = performance.now() / 1000;
      last = performance.now() / 1000;
      ui.banner("FIGHT!", 2);
    });

    // Incoming force push
    room.onMessage("pvpPush", (data) => {
      if (game.resp) return;
      player.vel.x += data.vx;
      player.vel.y += data.vy;
      player.vel.z += data.vz;
      player.ground = false;
    });

    // Incoming PvP damage
    room.onMessage("pvpDamage", (data) => {
      if (game.resp || game.win) return;
      player.hp -= data.dmg;
      player.hp = Math.max(0, player.hp);
      hud();
      if (player.hp <= 0) {
        killPlayer();
        spawnGore(player.pos.clone().add(new THREE.Vector3(0, 0.9, 0)));
      }
    });

    // Shot tracers from other players
    room.onMessage("playerShot", (data) => {
      spawnTracer(new THREE.Vector3(data.fx, data.fy, data.fz), new THREE.Vector3(data.tx, data.ty, data.tz));
    });

    room.onMessage("roleAssign", (data) => {
      if (data.colorIndex != null) {
        myColorIndex = data.colorIndex;
        const sp = ARENA_SPAWN_POINTS[myColorIndex] || ARENA_SPAWN_POINTS[0];
        player.pos.set(sp.x, player.height, sp.z);
        smoothCamY = player.pos.y;
        smoothGroundY = 0;
        player.yaw = sp.yaw;
      }
    });

    // Receive other players' customizations
    room.onMessage("playerCustomization", (data) => {
      _otherCustomizations.set(data.sid, data.colors);
      const op = otherPlayers.get(data.sid);
      if (!op) return;
      const pos = op.group.position.clone();
      scene.remove(op.group);
      const st = room.state && room.state.players.get(data.sid);
      const newOp = createPlayerModel(st ? st.colorIndex : 0, data.colors);
      newOp.hitBox.userData.isOtherPlayer = true;
      newOp.hitBox.userData.targetSid = data.sid;
      newOp.group.position.copy(pos);
      newOp._tx = op._tx; newOp._ty = op._ty; newOp._tz = op._tz;
      newOp._tyaw = op._tyaw; newOp._tpitch = op._tpitch;
      scene.add(newOp.group);
      otherPlayers.set(data.sid, newOp);
      rebuildRayTargets();
    });
    room.onMessage("allCustomizations", (data) => {
      for (const [sid, colors] of Object.entries(data)) _otherCustomizations.set(sid, colors);
    });

    room.onStateChange((state) => {
      syncOtherPlayers(state, mySessionId);
      hud();
    });

    // Send our customization
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
    console.warn("[arena] Connection failed, running solo:", err);
    if (waitingOverlay && waitingOverlay.parentNode) document.body.removeChild(waitingOverlay);
    room = null;
    game.started = true;
    game.startTime = performance.now() / 1000;
    last = performance.now() / 1000;
    ui.banner("ARENA — SOLO MODE", 2.5);
  }

  rebuildRayTargets();
  hud();
  loop();

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}
