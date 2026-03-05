import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { WORLD, RTS } from "./constants.js";
import { createWorld } from "./world.js";
import { connectToGame, createRoom, joinRoom } from "./network.js";

export async function initRTS() {
  const overlay = document.getElementById("rts-overlay");
  const overlayStatus = document.getElementById("overlay-status");

  // ── Three.js setup ─────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  const skyTex = new THREE.TextureLoader().load("./assets/sky.png");
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;
  scene.fog = new THREE.Fog(0x2d1f16, 400, 600);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  // Orthographic camera for top-down view
  const frustumSize = 200;
  const aspect = innerWidth / innerHeight;
  const camera = new THREE.OrthographicCamera(
    -frustumSize * aspect / 2, frustumSize * aspect / 2,
    frustumSize / 2, -frustumSize / 2,
    0.1, 500
  );
  camera.position.set(0, 250, 0);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xffc98a, 0x2a1b13, 0.62));
  const sun = new THREE.DirectionalLight(0xffb15c, 1.35);
  sun.position.set(120, 180, 30);
  scene.add(sun);

  const map = await createWorld(scene);

  // ── Camera controls ────────────────────────────────────────────────────
  let camX = 0, camZ = 0;
  let zoom = 1;
  const PAN_SPEED = 120;
  const ZOOM_MIN = 0.4, ZOOM_MAX = 2.5;
  const keys = new Set();

  // ── Bug type selection ──────────────────────────────────────────────────
  let selectedAbility = "basic"; // "basic" | "acid" | "wall"
  let lastAcidSpawnTime = 0;
  let lastWallSpawnTime = 0;

  const abilityBasicBtn = document.getElementById("ability-basic");
  const abilityAcidBtn = document.getElementById("ability-acid");
  const abilityWallBtn = document.getElementById("ability-wall");
  const acidCooldownOverlay = document.getElementById("acid-cooldown-overlay");
  const wallCooldownOverlay = document.getElementById("wall-cooldown-overlay");
  const spawnHintEl = document.getElementById("spawn-hint");

  function selectAbility(type) {
    selectedAbility = type;
    if (abilityBasicBtn) abilityBasicBtn.classList.toggle("active", type === "basic");
    if (abilityAcidBtn) abilityAcidBtn.classList.toggle("active", type === "acid");
    if (abilityWallBtn) abilityWallBtn.classList.toggle("active", type === "wall");
    const colors = { basic: 0xff4400, acid: 0x00dd44, wall: 0xb08a7a };
    spawnPreviewMat.color.setHex(colors[type] || 0xff4400);
    const hints = {
      basic: "Click on the map to spawn bugs (cost: 20 biomass)",
      acid: "Click to spawn ACID BUG (cost: 60 biomass)",
      wall: "Click on the TRACK to spawn a WALL (cost: 80 biomass)",
    };
    if (spawnHintEl) spawnHintEl.textContent = hints[type] || hints.basic;
  }

  if (abilityBasicBtn) abilityBasicBtn.addEventListener("click", () => selectAbility("basic"));
  if (abilityAcidBtn) abilityAcidBtn.addEventListener("click", () => selectAbility("acid"));
  if (abilityWallBtn) abilityWallBtn.addEventListener("click", () => selectAbility("wall"));
  // ──────────────────────────────────────────────────────────────────────

  addEventListener("keydown", (e) => {
    keys.add(e.code);
    if (e.code === "Digit1") selectAbility("basic");
    if (e.code === "Digit2") selectAbility("acid");
    if (e.code === "Digit3") selectAbility("wall");
  });
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("wheel", (e) => {
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + e.deltaY * 0.001));
    updateCamera();
  });

  function updateCamera() {
    const sz = frustumSize / zoom;
    camera.left = -sz * aspect / 2;
    camera.right = sz * aspect / 2;
    camera.top = sz / 2;
    camera.bottom = -sz / 2;
    camera.position.set(camX, 250, camZ);
    camera.lookAt(camX, 0, camZ);
    camera.updateProjectionMatrix();
  }

  // ── FPS Player Markers ─────────────────────────────────────────────────
  const FPS_COLORS = WORLD.FPS_COLORS;
  const fpsMarkers = new Map(); // sessionId → mesh
  const playerMarkerGeo = new THREE.ConeGeometry(1.5, 4, 8);
  const dirGeoTemplate = new THREE.ConeGeometry(0.6, 3, 4);
  dirGeoTemplate.rotateX(Math.PI / 2);
  dirGeoTemplate.translate(0, 0, -3);

  // ── Blind label sprite helper ──────────────────────────────────────────
  function makeBlindLabel() {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 32;
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(16, 4, 1);
    sprite.position.set(0, 8, 0);
    sprite.visible = false;
    return { sprite, canvas, tex };
  }

  function updateBlindLabel(label, seconds) {
    const ctx = label.canvas.getContext("2d");
    ctx.clearRect(0, 0, 128, 32);
    if (seconds > 0) {
      ctx.font = "bold 22px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#00ff44";
      ctx.fillText("BLIND " + Math.ceil(seconds) + "s", 64, 16);
      label.tex.needsUpdate = true;
      label.sprite.visible = true;
    } else {
      label.sprite.visible = false;
    }
  }

  const fpsBlindTimers = new Map(); // sessionId → { endTime }
  const fpsBlindLabels = new Map(); // sessionId → { sprite, canvas, tex }
  // ──────────────────────────────────────────────────────────────────────

  function createFpsMarker(colorIndex) {
    const color = FPS_COLORS[colorIndex] || 0x00cc44;
    const mat = new THREE.MeshBasicMaterial({ color });
    const marker = new THREE.Mesh(playerMarkerGeo, mat);
    marker.position.set(WORLD.SPAWN_X, 10, WORLD.SPAWN_Z);
    const dirMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 });
    const dirIndicator = new THREE.Mesh(dirGeoTemplate, dirMat);
    marker.add(dirIndicator);
    scene.add(marker);
    return marker;
  }

  // Enemy markers map: networkId -> mesh
  const enemyMarkers = new Map();
  const enemyMarkerGeo = new THREE.SphereGeometry(1.2, 8, 8);
  const enemyMarkerMat = new THREE.MeshBasicMaterial({ color: 0xff2200 });

  function addEnemyMarker(id, x, z) {
    const mesh = new THREE.Mesh(enemyMarkerGeo, enemyMarkerMat.clone());
    mesh.position.set(x, 5, z);
    scene.add(mesh);
    enemyMarkers.set(id, mesh);
  }

  function removeEnemyMarker(id) {
    const mesh = enemyMarkers.get(id);
    if (mesh) {
      scene.remove(mesh);
      enemyMarkers.delete(id);
    }
  }

  // Wall markers on RTS map
  const wallMarkers = new Map(); // wallId -> mesh
  const wallMarkerGeo = new THREE.BoxGeometry(RTS.WALL_WIDTH, 3, RTS.WALL_DEPTH);
  const wallMarkerMat = new THREE.MeshBasicMaterial({ color: 0xb08a7a, transparent: true, opacity: 0.8 });

  function addWallMarker(id, progress) {
    const mesh = new THREE.Mesh(wallMarkerGeo, wallMarkerMat.clone());
    const pt = map.getTrackPoint(progress);
    const tan = map.getTrackTangent(progress);
    const angle = Math.atan2(tan.x, tan.z);
    mesh.position.set(pt.x, 5, pt.z);
    mesh.rotation.y = angle;
    scene.add(mesh);
    wallMarkers.set(id, mesh);
  }

  function removeWallMarker(id) {
    const mesh = wallMarkers.get(id);
    if (mesh) {
      scene.remove(mesh);
      wallMarkers.delete(id);
    }
  }

  // Spawn preview indicator
  const spawnPreviewGeo = new THREE.RingGeometry(1.5, 2, 16);
  spawnPreviewGeo.rotateX(-Math.PI / 2);
  const spawnPreviewMat = new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.5 });
  const spawnPreview = new THREE.Mesh(spawnPreviewGeo, spawnPreviewMat);
  spawnPreview.visible = false;
  spawnPreview.position.y = 1;
  scene.add(spawnPreview);

  // ── HUD refs ───────────────────────────────────────────────────────────
  const bioVal = document.getElementById("bio-val");
  const enemyCount = document.getElementById("enemy-count");
  const killCount = document.getElementById("kill-count");
  const cartPct = document.getElementById("cart-pct");
  const timeVal = document.getElementById("time-val");
  const bioFill = document.getElementById("bio-fill");
  const bioBarVal = document.getElementById("bio-bar-val");
  const cartFill = document.getElementById("cart-fill");
  const cartBarVal = document.getElementById("cart-bar-val");
  const rtsMsgEl = document.getElementById("rts-msg");

  function updateHUD(state) {
    const bio = Math.floor(state.biomass);
    bioVal.textContent = bio;
    bioBarVal.textContent = bio;
    bioFill.style.width = (state.biomass / RTS.BIOMASS_MAX * 100).toFixed(1) + "%";

    enemyCount.textContent = enemyMarkers.size;
    killCount.textContent = state.killCount;

    const cp = Math.floor(state.cartProgress * 100);
    cartPct.textContent = cp + "%";
    cartBarVal.textContent = cp + "%";
    cartFill.style.width = cp + "%";

    const t = Math.max(0, Math.floor(state.timeRemaining));
    const m = Math.floor(t / 60);
    const s = t % 60;
    timeVal.textContent = m + ":" + String(s).padStart(2, "0");

    // Update cart position on map
    map.cart.p = state.cartProgress;
    map.setCar();
  }

  function rtsMsg(text, seconds = 2) {
    rtsMsgEl.textContent = text;
    rtsMsgEl.style.opacity = "1";
    clearTimeout(rtsMsg._t);
    rtsMsg._t = setTimeout(() => { rtsMsgEl.style.opacity = "0"; }, seconds * 1000);
  }

  // ── Click-to-spawn ─────────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let lastSpawnTime = 0;

  // We need a flat plane for raycasting clicks to world coords
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const intersectPoint = new THREE.Vector3();

  renderer.domElement.addEventListener("mousemove", (e) => {
    mouse.x = (e.clientX / innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / innerHeight) * 2 + 1;

    // Update spawn preview position
    raycaster.setFromCamera(mouse, camera);
    if (raycaster.ray.intersectPlane(groundPlane, intersectPoint)) {
      if (selectedAbility === "wall") {
        const snap = map.nearestTrackProgress(intersectPoint.x, intersectPoint.z);
        const pt = map.getTrackPoint(snap.t);
        spawnPreview.position.set(pt.x, 1, pt.z);
      } else {
        spawnPreview.position.set(intersectPoint.x, 1, intersectPoint.z);
      }
      spawnPreview.visible = room && room.state && room.state.phase === "playing";
    }
  });

  renderer.domElement.addEventListener("click", (e) => {
    if (!room || room.state.phase !== "playing") return;

    const now = Date.now();

    mouse.x = (e.clientX / innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, intersectPoint)) return;

    const x = intersectPoint.x;
    const z = intersectPoint.z;
    if (Math.abs(x) > 250 || Math.abs(z) > 250) {
      rtsMsg("Out of bounds!", 1);
      return;
    }

    // ── Wall ability ──
    if (selectedAbility === "wall") {
      if (room.state.biomass < RTS.WALL_COST) {
        rtsMsg("Not enough biomass!", 1);
        return;
      }
      if (now - lastWallSpawnTime < RTS.WALL_COOLDOWN * 1000) {
        const remaining = Math.ceil((RTS.WALL_COOLDOWN * 1000 - (now - lastWallSpawnTime)) / 1000);
        rtsMsg("Wall cooldown: " + remaining + "s", 0.8);
        return;
      }
      // Snap to track — must be close to the track
      const snap = map.nearestTrackProgress(x, z);
      if (snap.dist > 20) {
        rtsMsg("Place wall on the track!", 1);
        return;
      }
      lastWallSpawnTime = now;
      room.send("spawnWall", { progress: snap.t });
      return;
    }

    // ── Bug abilities ──
    if (now - lastSpawnTime < RTS.SPAWN_COOLDOWN * 1000) {
      rtsMsg("Cooldown...", 0.5);
      return;
    }

    const isAcid = selectedAbility === "acid";
    const cost = isAcid ? RTS.ACID_BUG_COST : RTS.BASIC_BUG_COST;
    const hp = isAcid ? RTS.ACID_BUG_HP : RTS.BASIC_BUG_HP;
    const speed = isAcid ? RTS.ACID_BUG_SPEED : RTS.BASIC_BUG_SPEED;

    if (room.state.biomass < cost) {
      rtsMsg("Not enough biomass!", 1);
      return;
    }

    if (isAcid) {
      if (now - lastAcidSpawnTime < RTS.ACID_BUG_COOLDOWN * 1000) {
        const remaining = Math.ceil((RTS.ACID_BUG_COOLDOWN * 1000 - (now - lastAcidSpawnTime)) / 1000);
        rtsMsg("Acid cooldown: " + remaining + "s", 0.8);
        return;
      }
    }

    lastSpawnTime = now;
    if (isAcid) lastAcidSpawnTime = now;
    room.send("spawnEnemy", {
      x, z, hp, speed, cost,
      bugType: selectedAbility,
    });
  });

  // ── Network connection ─────────────────────────────────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const paramRoomId = urlParams.get("roomId");
  const paramCreate = urlParams.get("create") === "true";
  const paramRoomName = urlParams.get("roomName");
  const paramRole = urlParams.get("role") || "rts";

  let room = null;
  overlayStatus.textContent = "Connecting to server...";

  try {
    // Connect based on URL params
    if (paramCreate) {
      room = await createRoom(paramRole, paramRoomName || "Game Room");
    } else if (paramRoomId) {
      room = await joinRoom(paramRoomId, paramRole);
    } else {
      // Legacy: no params, joinOrCreate
      room = await connectToGame("rts");
    }
    console.log("[rts] Connected as Commander");
    overlayStatus.textContent = "Waiting for Shooter...";

    room.onMessage("roleAssign", (data) => {
      if (data.role === "fps") {
        console.log("[rts] Assigned FPS role, redirecting...");
        room.leave();
        window.location.href = "/shooter_v2.html";
        return;
      }
    });

    // Countdown display
    room.onMessage("countdown", (data) => {
      overlayStatus.textContent = "Starting in " + data.seconds + "s";
    });

    // Cannot start (RTS only, no shooter)
    room.onMessage("cannotStart", (data) => {
      overlayStatus.textContent = data.reason || "Need a Shooter to start";
      rtsMsg("NEED A SHOOTER!", 3);
    });

    room.onMessage("gameStart", (data) => {
      console.log("[rts] Game started! Mode:", data.mode);
      if (overlay && overlay.parentNode) overlay.style.display = "none";
      rtsMsg("GAME ON — SPAWN BUGS TO STOP THE PLAYER!", 3);
    });

    // Track enemy spawns/kills via schema state changes
    room.onMessage("enemySpawn", (data) => {
      addEnemyMarker(data.id, data.x, data.z);
    });

    // Wall spawned
    room.onMessage("wallSpawn", (data) => {
      addWallMarker(data.id, data.progress);
    });

    // Wall destroyed
    room.onMessage("wallDestroyed", (data) => {
      removeWallMarker(data.id);
    });

    // Track acid blind on FPS players
    room.onMessage("acidBlind", (data) => {
      // Check each FPS player's distance from the acid explosion
      if (!room || !room.state) return;
      room.state.players.forEach((p, sid) => {
        if (p.role !== "fps") return;
        const dx = p.x - data.x;
        const dz = p.z - data.z;
        if (Math.hypot(dx, dz) <= RTS.ACID_BLIND_RADIUS) {
          fpsBlindTimers.set(sid, { endTime: performance.now() / 1000 + RTS.ACID_BLIND_DURATION });
        }
      });
    });

    room.onMessage("gameOver", (data) => {
      showGameOverRTS(data.winner);
    });

    // Watch state for updates
    room.onStateChange((state) => {
      updateHUD(state);

      // Sync FPS player markers
      const seenFps = new Set();
      state.players.forEach((p, sid) => {
        if (p.role !== "fps") return;
        seenFps.add(sid);
        let marker = fpsMarkers.get(sid);
        if (!marker) {
          marker = createFpsMarker(p.colorIndex);
          fpsMarkers.set(sid, marker);
          // Attach blind label
          const label = makeBlindLabel();
          marker.add(label.sprite);
          fpsBlindLabels.set(sid, label);
        }
        marker.position.set(p.x, 10, p.z);
        marker.rotation.y = -p.yaw;
      });
      // Remove markers for FPS players no longer in state
      for (const [sid, marker] of fpsMarkers) {
        if (!seenFps.has(sid)) {
          scene.remove(marker);
          fpsMarkers.delete(sid);
          fpsBlindLabels.delete(sid);
          fpsBlindTimers.delete(sid);
        }
      }

      // Sync enemy markers - remove dead ones
      const aliveIds = new Set();
      state.enemies.forEach((e, id) => {
        aliveIds.add(id);
        const marker = enemyMarkers.get(id);
        if (marker) {
          marker.position.set(e.x, 5, e.z);
        } else {
          addEnemyMarker(id, e.x, e.z);
        }
      });
      // Remove markers for enemies no longer in state
      for (const [id] of enemyMarkers) {
        if (!aliveIds.has(id)) {
          removeEnemyMarker(id);
        }
      }
    });

    // If game already in progress
    if (room.state && room.state.phase === "playing") {
      if (overlay) overlay.style.display = "none";
    }

  } catch (err) {
    console.error("[rts] Connection failed:", err);
    overlayStatus.textContent = "Failed to connect. Is the server running?";
    return;
  }

  // ── Game over screen ───────────────────────────────────────────────────
  function showGameOverRTS(winner) {
    const ov = document.createElement("div");
    ov.style.cssText = [
      "position:fixed", "inset:0", "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "background:rgba(0,0,0,0.82)", "z-index:999", "gap:12px",
      "font-family:monospace",
    ].join(";");

    const title = document.createElement("h1");
    if (winner === "rts") {
      title.textContent = "COMMANDER WINS!";
      title.style.cssText = "color:#00e87a;font-size:52px;margin:0;letter-spacing:4px;";
    } else if (winner === "fps") {
      title.textContent = "FPS PLAYER WINS";
      title.style.cssText = "color:#e84000;font-size:52px;margin:0;letter-spacing:4px;";
    } else {
      title.textContent = "OPPONENT DISCONNECTED";
      title.style.cssText = "color:#888;font-size:42px;margin:0;letter-spacing:4px;";
    }

    const btn = document.createElement("button");
    btn.textContent = "PLAY AGAIN";
    btn.style.cssText = [
      "margin-top:16px", "padding:16px 52px", "font-size:26px",
      "font-family:monospace", "background:#c0000a", "color:#fff",
      "border:none", "border-radius:6px", "cursor:pointer", "letter-spacing:4px",
    ].join(";");
    btn.onclick = () => window.location.href = "/";

    ov.append(title, btn);
    document.body.appendChild(ov);
  }

  // ── Render loop ────────────────────────────────────────────────────────
  let last = performance.now() / 1000;
  function loop() {
    requestAnimationFrame(loop);
    const t = performance.now() / 1000;
    const dt = Math.min(0.033, t - last);
    last = t;

    // Camera panning
    let px = 0, pz = 0;
    if (keys.has("KeyW")) pz -= 1;
    if (keys.has("KeyS")) pz += 1;
    if (keys.has("KeyA")) px -= 1;
    if (keys.has("KeyD")) px += 1;

    // Arrow up/down for zoom
    const ZOOM_KEY_SPEED = 1.5;
    if (keys.has("ArrowUp")) {
      zoom = Math.min(ZOOM_MAX, zoom + ZOOM_KEY_SPEED * dt);
      updateCamera();
    }
    if (keys.has("ArrowDown")) {
      zoom = Math.max(ZOOM_MIN, zoom - ZOOM_KEY_SPEED * dt);
      updateCamera();
    }
    if (px || pz) {
      const len = Math.hypot(px, pz);
      camX += (px / len) * PAN_SPEED * dt / zoom;
      camZ += (pz / len) * PAN_SPEED * dt / zoom;
      // Clamp to map bounds
      camX = Math.max(-270, Math.min(270, camX));
      camZ = Math.max(-270, Math.min(270, camZ));
      updateCamera();
    }

    // Pulse player markers + update blind labels
    const pulse = 1 + Math.sin(t * 4) * 0.15;
    for (const [sid, marker] of fpsMarkers) {
      marker.scale.setScalar(pulse);
      const label = fpsBlindLabels.get(sid);
      if (label) {
        const bt = fpsBlindTimers.get(sid);
        const remaining = bt ? bt.endTime - t : 0;
        updateBlindLabel(label, remaining > 0 ? remaining : 0);
        // Counter-rotate sprite so it always faces camera (undo marker rotation)
        label.sprite.material.rotation = marker.rotation.y;
      }
    }

    // Pulse enemy markers
    for (const [, mesh] of enemyMarkers) {
      mesh.scale.setScalar(0.8 + Math.sin(t * 3 + mesh.position.x) * 0.15);
    }

    // Update cooldown overlays
    const now = Date.now();
    if (acidCooldownOverlay) {
      const elapsed = now - lastAcidSpawnTime;
      const cdMs = RTS.ACID_BUG_COOLDOWN * 1000;
      if (lastAcidSpawnTime > 0 && elapsed < cdMs) {
        const pct = 1 - elapsed / cdMs;
        acidCooldownOverlay.style.height = (pct * 100).toFixed(1) + "%";
        acidCooldownOverlay.style.display = "block";
        acidCooldownOverlay.textContent = Math.ceil((cdMs - elapsed) / 1000) + "s";
      } else {
        acidCooldownOverlay.style.display = "none";
      }
    }
    if (wallCooldownOverlay) {
      const elapsed = now - lastWallSpawnTime;
      const cdMs = RTS.WALL_COOLDOWN * 1000;
      if (lastWallSpawnTime > 0 && elapsed < cdMs) {
        const pct = 1 - elapsed / cdMs;
        wallCooldownOverlay.style.height = (pct * 100).toFixed(1) + "%";
        wallCooldownOverlay.style.display = "block";
        wallCooldownOverlay.textContent = Math.ceil((cdMs - elapsed) / 1000) + "s";
      } else {
        wallCooldownOverlay.style.display = "none";
      }
    }

    renderer.render(scene, camera);
  }

  updateCamera();
  loop();

  addEventListener("resize", () => {
    const w = innerWidth;
    const h = innerHeight;
    const a = w / h;
    const sz = frustumSize / zoom;
    camera.left = -sz * a / 2;
    camera.right = sz * a / 2;
    camera.top = sz / 2;
    camera.bottom = -sz / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
}
