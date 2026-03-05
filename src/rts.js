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

  const map = createWorld(scene);

  // ── Camera controls ────────────────────────────────────────────────────
  let camX = 0, camZ = 0;
  let zoom = 1;
  const PAN_SPEED = 120;
  const ZOOM_MIN = 0.4, ZOOM_MAX = 2.5;
  const keys = new Set();

  addEventListener("keydown", (e) => keys.add(e.code));
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
    const cartZ = THREE.MathUtils.lerp(WORLD.TRACK_START, WORLD.TRACK_END, state.cartProgress);
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
      spawnPreview.position.set(intersectPoint.x, 1, intersectPoint.z);
      spawnPreview.visible = room && room.state && room.state.phase === "playing";
    }
  });

  renderer.domElement.addEventListener("click", (e) => {
    if (!room || room.state.phase !== "playing") return;

    const now = Date.now();
    if (now - lastSpawnTime < RTS.SPAWN_COOLDOWN * 1000) {
      rtsMsg("Cooldown...", 0.5);
      return;
    }

    if (room.state.biomass < RTS.BASIC_BUG_COST) {
      rtsMsg("Not enough biomass!", 1);
      return;
    }

    mouse.x = (e.clientX / innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    if (raycaster.ray.intersectPlane(groundPlane, intersectPoint)) {
      const x = intersectPoint.x;
      const z = intersectPoint.z;

      // Validate bounds
      if (Math.abs(x) > 140 || Math.abs(z) > 140) {
        rtsMsg("Out of bounds!", 1);
        return;
      }

      lastSpawnTime = now;
      room.send("spawnEnemy", {
        x, z,
        hp: RTS.BASIC_BUG_HP,
        speed: RTS.BASIC_BUG_SPEED,
        cost: RTS.BASIC_BUG_COST,
      });
    }
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
        }
        marker.position.set(p.x, 10, p.z);
        marker.rotation.y = -p.yaw;
      });
      // Remove markers for FPS players no longer in state
      for (const [sid, marker] of fpsMarkers) {
        if (!seenFps.has(sid)) {
          scene.remove(marker);
          fpsMarkers.delete(sid);
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
    if (keys.has("KeyW") || keys.has("ArrowUp")) pz -= 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) pz += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) px -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) px += 1;
    if (px || pz) {
      const len = Math.hypot(px, pz);
      camX += (px / len) * PAN_SPEED * dt / zoom;
      camZ += (pz / len) * PAN_SPEED * dt / zoom;
      // Clamp to map bounds
      camX = Math.max(-160, Math.min(160, camX));
      camZ = Math.max(-160, Math.min(160, camZ));
      updateCamera();
    }

    // Pulse player markers
    const pulse = 1 + Math.sin(t * 4) * 0.15;
    for (const [, marker] of fpsMarkers) {
      marker.scale.setScalar(pulse);
    }

    // Pulse enemy markers
    for (const [, mesh] of enemyMarkers) {
      mesh.scale.setScalar(0.8 + Math.sin(t * 3 + mesh.position.x) * 0.15);
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
