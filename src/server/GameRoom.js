const { Room } = require("colyseus");
const { GameState, Player, Enemy } = require("./GameState");

// RTS constants (mirrored from client constants.js)
const RTS = {
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
  WALL_COST: 80,
  WALL_HP: 1200,
  WALL_COOLDOWN: 25,
  SPEED_BOOST_DURATION: 20,
  SPEED_BOOST_MAX_USES: 2,
  EGG_TRAP_RADIUS: 40,
  EGG_TRAP_HOLD_DURATION: 5,
  EGG_TRAP_PULL_SPEED: 25,
  EGG_TRAP_COST: 40,
  EGG_TRAP_DAMAGE: 100,
  EGG_TRAP_HP: 200,
  DORMANT_WAKE_RADIUS: 15,
};

// Track waypoints (mirrored from client constants.js)
const TRACK_WAYPOINTS = [
  { x: -120, z: 170 }, { x: -120, z: 105 }, { x: 120, z: 85 },
  { x: 120, z: 25 }, { x: -120, z: 5 }, { x: -120, z: -60 },
  { x: 120, z: -80 }, { x: 120, z: -140 }, { x: -120, z: -160 },
];

// Simplified distance-to-track check (matches client's distToTrackSq)
function buildTrackSamples() {
  // Approximate CatmullRom with linear segments between waypoints
  const samples = [];
  const SAMPLES = 200;
  const pts = TRACK_WAYPOINTS;
  // Build cumulative lengths for parameterization
  const segs = [];
  let totalLen = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i+1].x - pts[i].x;
    const dz = pts[i+1].z - pts[i].z;
    const len = Math.sqrt(dx*dx + dz*dz);
    segs.push({ len, cumLen: totalLen });
    totalLen += len;
  }
  for (let i = 0; i <= SAMPLES; i++) {
    const d = (i / SAMPLES) * totalLen;
    let segIdx = 0;
    for (let j = 0; j < segs.length - 1; j++) {
      if (d >= segs[j+1].cumLen) segIdx = j+1;
    }
    const local = d - segs[segIdx].cumLen;
    const t = Math.min(1, local / segs[segIdx].len);
    const x = pts[segIdx].x + (pts[segIdx+1].x - pts[segIdx].x) * t;
    const z = pts[segIdx].z + (pts[segIdx+1].z - pts[segIdx].z) * t;
    samples.push({ x, z });
  }
  return samples;
}

const trackSamples = buildTrackSamples();

function distToTrackSq(x, z) {
  let best = Infinity;
  for (const s of trackSamples) {
    const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (d < best) best = d;
  }
  return best;
}

// Seeded PRNG (mulberry32) — same as client
function mulberry32(seed) {
  let s = seed | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateEggSacPositions() {
  const rand = mulberry32(42069);
  const NEST_X = -120, NEST_Z = -180;
  const nestClearRadius = 42;

  // ── Replicate rand() consumption from world.js exactly ──
  // Perimeter ring (lines 130-148)
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    const radius = 240 + Math.sin(i * 0.9) * 6 + (rand() - 0.5) * 8; // 1 rand
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius * 0.96;
    if (Math.hypot(x - NEST_X, z - NEST_Z) < nestClearRadius) continue;
    const h = 7 + rand() * 9; // 1 rand
    const sx = 5 + rand() * 4; // 1 rand
    const sz = 5 + rand() * 4; // 1 rand
    // addRock internals: 2 rand() for rotation
    rand(); rand();
    // Extra rock check
    if (rand() < 0.28) { // 1 rand
      rand(); rand(); // x,z offsets
      rand(); // sx
      rand(); // sy (h + 5 + rand() * 8)
      rand(); // sz
      // addRock internals: 2 rand() for rotation
      rand(); rand();
    }
  }

  // Cliff chunks (lines 151-165)
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2 + rand() * 0.2; // 1 rand
    const radius = 230 + rand() * 10; // 1 rand
    const sx = 12 + rand() * 10; // 1 rand
    const sy = 14 + rand() * 18; // 1 rand
    const sz = 8 + rand() * 9; // 1 rand
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius * 0.94;
    if (Math.hypot(x - NEST_X, z - NEST_Z) < nestClearRadius + 10) continue;
    rand(); // rotation.y random
  }

  // Egg sac positions (lines 168-174)
  const positions = [];
  for (let i = 0; i < 48; i++) {
    const ex = (rand() * 2 - 1) * 200;
    const ez = (rand() * 2 - 1) * 190;
    if (distToTrackSq(ex, ez) < 16 * 16) continue;
    rand(); // rotY — consumed to stay in sync, not needed server-side
    positions.push({ x: ex, z: ez });
  }
  return positions;
}

class GameRoom extends Room {
  onCreate(options) {
    this.maxClients = 5;
    this.setState(new GameState());

    this._nextEnemyId = 1;
    this._nextWallId = 1;
    this._lastSpawnTime = {};      // sessionId -> timestamp
    this._lastAcidSpawnTime = {};  // sessionId -> timestamp
    this._lastWallSpawnTime = {};  // sessionId -> timestamp
    this._walls = {};              // wallId -> { id, z, hp }
    this._disconnectTimers = {};   // sessionId -> timeout handle
    this._tickInterval = null;
    this._speedBoostUses = 0;
    this._activeTraps = new Set();
    this._usedTraps = new Set();    // traps that have triggered — can't be reactivated
    this._trapActivationCount = 0;  // total traps activated this match (max 3)
    this._trapHp = {};              // trapIndex → remaining HP
    this._trappedPlayers = new Map(); // playerSid → { trapIndex, endTime }
    this._eggSacPositions = generateEggSacPositions();
    this._customizations = new Map(); // sessionId -> { base, head, torso, arms, legs }

    // Room name from options
    const roomName = (options && options.roomName) || "Game Room";

    this.setMetadata({
      roomName,
      fpsCount: 0,
      hasRts: false,
      phase: "waiting",
    });

    // ── Message handlers ──────────────────────────────────────────────────

    // RTS player requests enemy spawn
    this.onMessage("spawnEnemy", (client, data) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "rts") return;

      const bugType = data.bugType || "basic";
      const cost = data.cost || (bugType === "acid" ? RTS.ACID_BUG_COST : RTS.BASIC_BUG_COST);
      if (this.state.biomass < cost) return;

      // Cooldown check (basic spawn cooldown)
      const now = Date.now();
      const lastSpawn = this._lastSpawnTime[client.sessionId] || 0;
      if (now - lastSpawn < RTS.SPAWN_COOLDOWN * 1000) return;
      this._lastSpawnTime[client.sessionId] = now;

      // Acid-specific cooldown
      if (bugType === "acid") {
        const lastAcid = this._lastAcidSpawnTime[client.sessionId] || 0;
        if (now - lastAcid < RTS.ACID_BUG_COOLDOWN * 1000) return;
        this._lastAcidSpawnTime[client.sessionId] = now;
      }

      // Validate position bounds
      const x = Number(data.x) || 0;
      const z = Number(data.z) || 0;
      if (Math.abs(x) > 150 || Math.abs(z) > 150) return;

      this.state.biomass -= cost;

      const id = "e" + (this._nextEnemyId++);
      const enemy = new Enemy();
      enemy.id = id;
      enemy.x = x;
      enemy.z = z;
      enemy.hp = data.hp || (bugType === "acid" ? RTS.ACID_BUG_HP : RTS.BASIC_BUG_HP);
      enemy.speed = data.speed || (bugType === "acid" ? RTS.ACID_BUG_SPEED : RTS.BASIC_BUG_SPEED);
      enemy.alive = true;
      enemy.bugType = bugType;
      enemy.dormant = !!data.dormant;
      this.state.enemies.set(id, enemy);

      // Tell FPS client to spawn the bug
      this.broadcast("enemySpawn", {
        id, x, z,
        hp: enemy.hp,
        speed: enemy.speed,
        bugType,
        dormant: enemy.dormant,
      });
    });

    // RTS player manually wakes a dormant enemy
    this.onMessage("wakeEnemy", (client, data) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "rts") return;
      const id = data.id;
      if (!id || typeof id !== "string") return;
      const enemy = this.state.enemies.get(id);
      if (!enemy || !enemy.dormant) return;
      enemy.dormant = false;
      this.broadcast("enemyWake", { id });
    });

    // FPS host spawns enemy in coop mode (no commander)
    this.onMessage("coopSpawnEnemy", (client, data) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "fps") return;

      const x = Number(data.x) || 0;
      const z = Number(data.z) || 0;
      const hp = Number(data.hp) || RTS.BASIC_BUG_HP;
      const speed = Number(data.speed) || RTS.BASIC_BUG_SPEED;

      const bugType = data.bugType || "basic";

      const id = "e" + (this._nextEnemyId++);
      const enemy = new Enemy();
      enemy.id = id;
      enemy.x = x;
      enemy.z = z;
      enemy.hp = hp;
      enemy.speed = speed;
      enemy.alive = true;
      enemy.bugType = bugType;
      this.state.enemies.set(id, enemy);

      this.broadcast("enemySpawn", { id, x, z, hp, speed, bugType });
    });

    // FPS client reports an enemy was killed
    this.onMessage("enemyKilled", (client, data) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "fps") return;

      const id = data.id;
      const enemy = this.state.enemies.get(id);
      if (enemy) {
        // If acid bug, broadcast blind effect to all FPS clients
        if (enemy.bugType === "acid") {
          this.broadcast("acidBlind", { x: enemy.x, z: enemy.z });
        }
        enemy.alive = false;
        this.state.enemies.delete(id);
      }
      this.state.killCount++;
    });

    // FPS client sends position/hp/cartProgress updates
    this.onMessage("playerUpdate", (client, data) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      if (data.x !== undefined) player.x = data.x;
      if (data.y !== undefined) player.y = data.y;
      if (data.z !== undefined) player.z = data.z;
      if (data.yaw !== undefined) player.yaw = data.yaw;
      if (data.pitch !== undefined) player.pitch = data.pitch;
      if (data.hp !== undefined) player.hp = data.hp;
      if (data.cartProgress !== undefined) {
        this.state.cartProgress = Math.max(this.state.cartProgress, data.cartProgress);
      }
    });

    // FPS client sends batch enemy positions for RTS view
    this.onMessage("enemyPositions", (client, data) => {
      if (this.state.phase !== "playing") return;
      if (!Array.isArray(data)) return;
      for (const ep of data) {
        const enemy = this.state.enemies.get(ep.id);
        if (enemy) {
          const x = Number(ep.x);
          const y = Number(ep.y);
          const z = Number(ep.z);
          const yaw = Number(ep.yaw);
          if (!isNaN(x) && !isNaN(z)) {
            enemy.x = x;
            enemy.z = z;
            if (!isNaN(y)) enemy.y = y;
            if (!isNaN(yaw)) enemy.yaw = yaw;
          }
        }
      }
    });

    // FPS client fires a shot — broadcast tracer to other clients
    this.onMessage("playerShot", (client, data) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "fps") return;
      this.broadcast("playerShot", {
        sid: client.sessionId,
        fx: data.fx, fy: data.fy, fz: data.fz,
        tx: data.tx, ty: data.ty, tz: data.tz,
      }, { except: client });
    });

    // FPS client reports win (cart reached nest)
    this.onMessage("win", (client, data) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "fps") return;
      this._endGame("fps");
    });

    // RTS player requests wall spawn on the track (progress-based)
    this.onMessage("spawnWall", (client, data) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "rts") return;

      if (this.state.biomass < RTS.WALL_COST) return;

      const now = Date.now();
      const lastWall = this._lastWallSpawnTime[client.sessionId] || 0;
      if (now - lastWall < RTS.WALL_COOLDOWN * 1000) return;

      const progress = Number(data.progress);
      if (isNaN(progress) || progress < 0.02 || progress > 0.98) return;

      this._lastWallSpawnTime[client.sessionId] = now;
      this.state.biomass -= RTS.WALL_COST;

      const id = "w" + (this._nextWallId++);
      this._walls[id] = { id, progress, hp: RTS.WALL_HP };
      this.broadcast("wallSpawn", { id, progress, hp: RTS.WALL_HP });
    });

    // FPS client reports wall damage
    this.onMessage("wallHit", (client, data) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "fps") return;

      const wall = this._walls[data.id];
      if (!wall) return;
      const dmg = Number(data.dmg) || 0;
      if (dmg <= 0 || dmg > 100) return;
      wall.hp -= dmg;
      this.broadcast("wallDamage", { id: wall.id, hp: wall.hp });

      if (wall.hp <= 0) {
        this.broadcast("wallDestroyed", { id: wall.id });
        delete this._walls[wall.id];
      }
    });

    // Speed boost — commander activates 2x speed for all bugs
    this.onMessage("speedBoost", (client) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "rts") return;
      if (this._speedBoostUses >= RTS.SPEED_BOOST_MAX_USES) return;
      this._speedBoostUses++;
      this.broadcast("speedBoost");
    });

    // Activate egg sac trap (max 3 per match)
    this.onMessage("activateTrap", (client, data) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "rts") return;
      const index = Number(data.index);
      if (isNaN(index) || index < 0 || index >= this._eggSacPositions.length) return;
      if (this._activeTraps.has(index)) return;
      if (this._usedTraps.has(index)) return;
      if (this._trapActivationCount >= 3) return; // max 3 traps per match
      if (this.state.biomass < RTS.EGG_TRAP_COST) return;
      this.state.biomass -= RTS.EGG_TRAP_COST;
      this._trapActivationCount++;
      this._activeTraps.add(index);
      this._trapHp[index] = RTS.EGG_TRAP_HP;
      this.broadcast("trapActivated", { index, remaining: 3 - this._trapActivationCount });
    });

    // FPS player shoots an active trap egg sac
    this.onMessage("trapHit", (client, data) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "fps") return;
      const index = Number(data.index);
      if (isNaN(index) || !this._activeTraps.has(index)) return;
      const dmg = Number(data.dmg) || 0;
      if (dmg <= 0 || dmg > 100) return;
      this._trapHp[index] = (this._trapHp[index] || 0) - dmg;
      if (this._trapHp[index] <= 0) {
        this._deactivateTrap(index);
      }
    });

    // Player sends their character customization
    this.onMessage("customization", (client, data) => {
      const colors = {
        base: data.base || null,
        head: data.head || null,
        torso: data.torso || null,
        arms: data.arms || null,
        legs: data.legs || null,
      };
      this._customizations.set(client.sessionId, colors);
      // Broadcast to all other clients
      this.broadcast("playerCustomization", { sid: client.sessionId, colors }, { except: client });
    });

    // FPS player requests game start
    this.onMessage("requestStart", (client, data) => {
      if (this.state.phase !== "waiting") return;
      const p = this.state.players.get(client.sessionId);
      if (!p || p.role !== "fps") return;

      let fc = 0, hr = false;
      this.state.players.forEach((pl) => {
        if (pl.role === "fps") fc++;
        if (pl.role === "rts") hr = true;
      });

      if (data.mode === "pvp") {
        if (!hr) return;
        this._startGame("multiplayer");
      } else {
        this._startGame(fc >= 2 ? "coop" : "singleplayer");
      }
    });
  }

  onJoin(client, options) {
    const player = new Player();

    // Determine role from options or auto-assign
    const requestedRole = options && options.role;

    let fpsCount = 0, hasRts = false;
    const usedColors = new Set();
    this.state.players.forEach((p) => {
      if (p.role === "fps") { fpsCount++; usedColors.add(p.colorIndex); }
      if (p.role === "rts") hasRts = true;
    });

    if (requestedRole === "fps" && fpsCount >= 4) {
      throw new Error("FPS slots full (4/4)");
    }
    if (requestedRole === "rts" && hasRts) {
      throw new Error("RTS slot already taken");
    }

    if (requestedRole === "fps" || requestedRole === "rts") {
      player.role = requestedRole;
    } else {
      // Legacy: auto-assign
      player.role = fpsCount >= 4 ? "rts" : "fps";
    }

    // Assign color index for FPS players
    if (player.role === "fps") {
      for (let i = 0; i < 4; i++) {
        if (!usedColors.has(i)) { player.colorIndex = i; break; }
      }
    }

    this.state.players.set(client.sessionId, player);

    // Notify client of their role and color
    client.send("roleAssign", { role: player.role, colorIndex: player.colorIndex });

    // Send existing player customizations to the new joiner
    const allCustomizations = {};
    this._customizations.forEach((colors, sid) => { allCustomizations[sid] = colors; });
    if (Object.keys(allCustomizations).length > 0) {
      client.send("allCustomizations", allCustomizations);
    }

    // Clear any pending disconnect timer for a reconnecting slot
    if (this._disconnectTimers[client.sessionId]) {
      clearTimeout(this._disconnectTimers[client.sessionId]);
      delete this._disconnectTimers[client.sessionId];
    }

    // Update metadata and broadcast player count
    this._updateMetadata();
    this._broadcastPlayerCount();
  }

  async onLeave(client, consented) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    this._customizations.delete(client.sessionId);

    const leavingRole = player.role;

    if (this.state.phase === "playing" && !consented) {
      // Allow 15 seconds for reconnection
      try {
        this._disconnectTimers[client.sessionId] = setTimeout(() => {
          this.state.players.delete(client.sessionId);
          this._checkFpsRemaining();
        }, 15000);

        await this.allowReconnection(client, 15);

        // Reconnected — clear timer
        if (this._disconnectTimers[client.sessionId]) {
          clearTimeout(this._disconnectTimers[client.sessionId]);
          delete this._disconnectTimers[client.sessionId];
        }
      } catch {
        // Reconnection timed out
        this.state.players.delete(client.sessionId);
        this._checkFpsRemaining();
      }
    } else {
      this.state.players.delete(client.sessionId);

      if (this.state.phase === "playing") {
        this._checkFpsRemaining();
      } else if (this.state.phase === "waiting") {
        this._updateMetadata();
        this._broadcastPlayerCount();
      }
    }
  }

  _checkFpsRemaining() {
    let fpsCount = 0;
    this.state.players.forEach((p) => {
      if (p.role === "fps") fpsCount++;
    });
    this._updateMetadata();
    if (fpsCount === 0) {
      this._endGame("disconnect");
    }
  }

  onDispose() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
    }
    for (const key of Object.keys(this._disconnectTimers)) {
      clearTimeout(this._disconnectTimers[key]);
    }
  }

  _broadcastPlayerCount() {
    let fpsCount = 0, hasRts = false;
    this.state.players.forEach((p) => {
      if (p.role === "fps") fpsCount++;
      if (p.role === "rts") hasRts = true;
    });
    this.broadcast("playerCount", { fpsCount, hasRts });
  }

  _startGame(mode) {
    this._gameMode = mode;
    this.state.phase = "playing";

    // Scale biomass by number of FPS players for fairness
    let fpsCount = 0;
    this.state.players.forEach((p) => { if (p.role === "fps") fpsCount++; });
    this._fpsMultiplier = Math.max(1, fpsCount);
    this._biomassMax = RTS.BIOMASS_MAX * this._fpsMultiplier;
    this.state.biomass = RTS.BIOMASS_START * this._fpsMultiplier;
    this._checkpointBonusGiven = false;

    this.state.timeRemaining = RTS.TIME_LIMIT;
    this.broadcast("gameStart", { mode });
    this._updateMetadata();

    // 10 Hz simulation tick
    this._tickInterval = setInterval(() => {
      if (this.state.phase !== "playing") return;

      // Biomass regen (only relevant when commander is playing)
      if (this._gameMode === "multiplayer") {
        this.state.biomass = Math.min(
          this._biomassMax,
          this.state.biomass + RTS.BIOMASS_REGEN * this._fpsMultiplier * 0.1
        );

        // Checkpoint biomass bonus — when cart reaches 25% (force gun checkpoint)
        if (!this._checkpointBonusGiven && this.state.cartProgress >= 0.25) {
          this._checkpointBonusGiven = true;
          const bonus = 100 * this._fpsMultiplier;
          this.state.biomass = Math.min(this._biomassMax, this.state.biomass + bonus);
          this.broadcast("checkpointBonus", { bonus });
        }

        // Time countdown — only in vs mode (commander vs shooters)
        this.state.timeRemaining -= 0.1;
        if (this.state.timeRemaining <= 0) {
          this._endGame("rts"); // Time's up — RTS wins
        }

        // Auto-wake dormant enemies when a shooter is nearby
        this.state.enemies.forEach((enemy, eid) => {
          if (!enemy.dormant) return;
          let wake = false;
          this.state.players.forEach((p) => {
            if (p.role !== "fps") return;
            const dx = p.x - enemy.x;
            const dz = p.z - enemy.z;
            if (dx * dx + dz * dz < RTS.DORMANT_WAKE_RADIUS * RTS.DORMANT_WAKE_RADIUS) {
              wake = true;
            }
          });
          if (wake) {
            enemy.dormant = false;
            this.broadcast("enemyWake", { id: eid });
          }
        });

        // Trap proximity detection — trap catches first player then holds
        const now = Date.now();
        for (const trapIndex of this._activeTraps) {
          const eggPos = this._eggSacPositions[trapIndex];
          if (!eggPos) continue;
          // Skip traps that already caught someone (one catch per activation)
          let alreadyCaught = false;
          for (const [, trap] of this._trappedPlayers) {
            if (trap.trapIndex === trapIndex) { alreadyCaught = true; break; }
          }
          if (alreadyCaught) continue;
          this.state.players.forEach((p, sid) => {
            if (p.role !== "fps") return;
            if (this._trappedPlayers.has(sid)) return;
            const dx = p.x - eggPos.x;
            const dz = p.z - eggPos.z;
            if (Math.hypot(dx, dz) < RTS.EGG_TRAP_RADIUS) {
              this._trappedPlayers.set(sid, { trapIndex, endTime: now + RTS.EGG_TRAP_HOLD_DURATION * 1000 });
              this.broadcast("trapTriggered", { playerSid: sid, trapIndex, eggX: eggPos.x, eggZ: eggPos.z });
            }
          });
        }
        // Damage trapped players (100 over 5s = 20/s = 2 per tick at 10Hz)
        const dmgPerTick = RTS.EGG_TRAP_DAMAGE / (RTS.EGG_TRAP_HOLD_DURATION * 10);
        // Release trapped players whose timer expired, deactivate their trap
        for (const [sid, trap] of this._trappedPlayers) {
          // Apply damage tick
          this.broadcast("trapDamage", { playerSid: sid, dmg: dmgPerTick });
          if (now >= trap.endTime) {
            this._trappedPlayers.delete(sid);
            this.broadcast("trapReleased", { playerSid: sid });
            this._deactivateTrap(trap.trapIndex);
          }
        }
      }
    }, 100);
  }

  _deactivateTrap(trapIndex) {
    this._activeTraps.delete(trapIndex);
    this._usedTraps.add(trapIndex); // permanently used — can't reactivate
    delete this._trapHp[trapIndex];
    // Release any players caught by this trap
    for (const [sid, trap] of this._trappedPlayers) {
      if (trap.trapIndex === trapIndex) {
        this._trappedPlayers.delete(sid);
        this.broadcast("trapReleased", { playerSid: sid });
      }
    }
    this.broadcast("trapDeactivated", { index: trapIndex });
  }

  _endGame(winner) {
    if (this.state.phase === "ended") return;
    this.state.phase = "ended";
    this.state.winner = winner;
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    this.broadcast("gameOver", { winner });
    this._updateMetadata();

    // Disconnect all after a short delay
    setTimeout(() => {
      this.disconnect();
    }, 5000);
  }

  _updateMetadata() {
    let fpsCount = 0, hasRts = false;
    this.state.players.forEach((p) => {
      if (p.role === "fps") fpsCount++;
      if (p.role === "rts") hasRts = true;
    });

    this.setMetadata({
      roomName: (this.metadata && this.metadata.roomName) || "Game Room",
      fpsCount,
      hasRts,
      phase: this.state.phase,
    });
  }
}

module.exports = { GameRoom };
