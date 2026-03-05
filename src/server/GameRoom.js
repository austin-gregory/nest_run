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
  ACID_BLIND_RADIUS: 18,
  WALL_COST: 80,
  WALL_HP: 400,
  WALL_COOLDOWN: 25,
};

const COUNTDOWN_SECONDS = 30;

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
    this._autoStartTimer = null;
    this._countdownRemaining = COUNTDOWN_SECONDS;

    // Room name from options
    const roomName = (options && options.roomName) || "Game Room";

    this.setMetadata({
      roomName,
      fpsCount: 0,
      hasRts: false,
      phase: "waiting",
      countdown: COUNTDOWN_SECONDS,
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
      this.state.enemies.set(id, enemy);

      // Tell FPS client to spawn the bug
      this.broadcast("enemySpawn", {
        id, x, z,
        hp: enemy.hp,
        speed: enemy.speed,
        bugType,
      });
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

    // Clear any pending disconnect timer for a reconnecting slot
    if (this._disconnectTimers[client.sessionId]) {
      clearTimeout(this._disconnectTimers[client.sessionId]);
      delete this._disconnectTimers[client.sessionId];
    }

    // Update metadata
    this._updateMetadata();

    // Check if FPS + RTS present
    let nowFpsCount = 0, nowHasRts = false;
    this.state.players.forEach((p) => {
      if (p.role === "fps") nowFpsCount++;
      if (p.role === "rts") nowHasRts = true;
    });

    if (nowFpsCount >= 1 && nowHasRts && this.state.phase === "waiting") {
      // Both roles present — start immediately, cancel any countdown
      this._cancelCountdown();
      this._startGame("multiplayer");
    } else if (this.state.phase === "waiting" && !this._autoStartTimer) {
      // First joiner — start countdown
      this._startCountdown();
    }
  }

  async onLeave(client, consented) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

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
        // If no players left in waiting, cancel countdown
        if (this.state.players.size === 0) {
          this._cancelCountdown();
        }
        this._updateMetadata();
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
    this._cancelCountdown();
    for (const key of Object.keys(this._disconnectTimers)) {
      clearTimeout(this._disconnectTimers[key]);
    }
  }

  _startCountdown() {
    this._countdownRemaining = COUNTDOWN_SECONDS;
    this._autoStartTimer = setInterval(() => {
      this._countdownRemaining--;
      this.broadcast("countdown", { seconds: this._countdownRemaining });
      this._updateMetadata();

      if (this._countdownRemaining <= 0) {
        this._cancelCountdown();
        this._resolveAutoStart();
      }
    }, 1000);
  }

  _cancelCountdown() {
    if (this._autoStartTimer) {
      clearInterval(this._autoStartTimer);
      this._autoStartTimer = null;
    }
    this._countdownRemaining = COUNTDOWN_SECONDS;
  }

  _resolveAutoStart() {
    let fpsCount = 0, hasRts = false;
    this.state.players.forEach((p) => {
      if (p.role === "fps") fpsCount++;
      if (p.role === "rts") hasRts = true;
    });

    if (fpsCount >= 1 && hasRts) {
      this._startGame("multiplayer");
    } else if (fpsCount >= 2) {
      this._startGame("coop");
    } else if (fpsCount >= 1) {
      this._startGame("singleplayer");
    } else {
      // RTS only — can't start without a shooter
      this.broadcast("cannotStart", { reason: "Need a Shooter to start the game" });
      // Restart countdown
      this._startCountdown();
    }
  }

  _startGame(mode) {
    this._gameMode = mode;
    this.state.phase = "playing";
    this.state.biomass = RTS.BIOMASS_START;
    this.state.timeRemaining = RTS.TIME_LIMIT;
    this.broadcast("gameStart", { mode });
    this._updateMetadata();

    // 10 Hz simulation tick
    this._tickInterval = setInterval(() => {
      if (this.state.phase !== "playing") return;

      // Biomass regen (only relevant when commander is playing)
      if (this._gameMode === "multiplayer") {
        this.state.biomass = Math.min(
          RTS.BIOMASS_MAX,
          this.state.biomass + RTS.BIOMASS_REGEN * 0.1
        );

        // Time countdown — only in vs mode (commander vs shooters)
        this.state.timeRemaining -= 0.1;
        if (this.state.timeRemaining <= 0) {
          this._endGame("rts"); // Time's up — RTS wins
        }
      }
    }, 100);
  }

  _endGame(winner) {
    if (this.state.phase === "ended") return;
    this.state.phase = "ended";
    this.state.winner = winner;
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    this._cancelCountdown();
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
      countdown: this._countdownRemaining,
    });
  }
}

module.exports = { GameRoom };
