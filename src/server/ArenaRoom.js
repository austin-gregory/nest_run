const { Room } = require("colyseus");
const { GameState, Player } = require("./GameState");
const BotAI = require("./BotAI");

class ArenaRoom extends Room {
  onCreate(options) {
    this.maxClients = 4;
    this.setState(new GameState());
    this._disconnectTimers = {};
    this._customizations = new Map();
    this._addBots = !!(options && options.addBots);
    this._bots = [];
    this._botTickInterval = null;

    const roomName = (options && options.roomName) || "Arena Room";
    this.setMetadata({ roomName, fpsCount: 0, phase: "waiting", isArena: true });

    // Player position sync
    this.onMessage("playerUpdate", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (data.x != null) p.x = data.x;
      if (data.y != null) p.y = data.y;
      if (data.z != null) p.z = data.z;
      if (data.yaw != null) p.yaw = data.yaw;
      if (data.pitch != null) p.pitch = data.pitch;
      if (data.hp != null) p.hp = data.hp;
      if (data.jetting != null) p.jetting = data.jetting;
    });

    // PvP damage: relay damage to target player (or bot)
    this.onMessage("pvpHit", (client, data) => {
      if (!data.targetSid || typeof data.dmg !== "number") return;
      if (data.targetSid.startsWith("bot-")) {
        const bot = this._bots.find(b => b.sid === data.targetSid);
        if (bot && !bot.dead) {
          bot.hp -= data.dmg;
          if (bot.hp <= 0) {
            BotAI.killBot(bot);
          }
          const p = this.state.players.get(bot.sid);
          if (p) p.hp = bot.hp;
        }
        return;
      }
      const targetClient = this.clients.find(c => c.sessionId === data.targetSid);
      if (targetClient) {
        this.send(targetClient, "pvpDamage", {
          dmg: data.dmg,
          attackerSid: client.sessionId,
        });
      }
    });

    // Force push: relay velocity impulse to target (or bot)
    this.onMessage("pvpPush", (client, data) => {
      if (!data.targetSid) return;
      if (data.targetSid.startsWith("bot-")) {
        const bot = this._bots.find(b => b.sid === data.targetSid);
        if (bot && !bot.dead) {
          bot.vx += (data.vx || 0);
          bot.vy += (data.vy || 0);
          bot.vz += (data.vz || 0);
          bot.ground = false;
        }
        return;
      }
      const targetClient = this.clients.find(c => c.sessionId === data.targetSid);
      if (targetClient) {
        this.send(targetClient, "pvpPush", {
          vx: data.vx, vy: data.vy, vz: data.vz,
        });
      }
    });

    // Shot tracer broadcast
    this.onMessage("playerShot", (client, data) => {
      this.broadcast("playerShot", data, { except: client });
    });

    // Request game start
    this.onMessage("requestStart", (client) => {
      if (this.state.phase !== "waiting") return;
      this.state.phase = "playing";
      if (this._addBots) this._spawnBots();
      this.setMetadata({ roomName: this.metadata.roomName, fpsCount: this.state.players.size, phase: "playing", isArena: true });
      this.broadcast("gameStart", { mode: "arena" });
      this.broadcast("playerCount", { fpsCount: this.state.players.size });
      if (this._bots.length > 0) this._startBotTick();
    });

    // Customization sync
    this.onMessage("customization", (client, data) => {
      this._customizations.set(client.sessionId, data);
      this.broadcast("playerCustomization", { sid: client.sessionId, colors: data }, { except: client });
    });
  }

  onJoin(client, options) {
    const count = this.state.players.size;
    if (count >= 4) { client.leave(); return; }

    const p = new Player();
    p.role = "fps";
    p.colorIndex = count;
    p.hp = 500;
    this.state.players.set(client.sessionId, p);

    this.setMetadata({
      roomName: this.metadata.roomName,
      fpsCount: this.state.players.size,
      phase: this.state.phase,
      isArena: true,
    });

    this.send(client, "roleAssign", { role: "fps", colorIndex: count });

    // Send existing customizations to new joiner
    const allCustom = {};
    for (const [sid, colors] of this._customizations) allCustom[sid] = colors;
    if (Object.keys(allCustom).length > 0) this.send(client, "allCustomizations", allCustom);

    this.broadcast("playerCount", { fpsCount: this.state.players.size });

    if (this.state.phase === "playing") {
      this.send(client, "gameStart", { mode: "arena" });
    }
  }

  onLeave(client, consented) {
    if (!consented) {
      this._disconnectTimers[client.sessionId] = setTimeout(() => {
        this._removePlayer(client.sessionId);
      }, 10000);
      return;
    }
    this._removePlayer(client.sessionId);
  }

  _removePlayer(sid) {
    clearTimeout(this._disconnectTimers[sid]);
    delete this._disconnectTimers[sid];
    this.state.players.delete(sid);
    this._customizations.delete(sid);

    // Check if only bots remain — if so, clean up
    const realPlayers = [...this.state.players.keys()].filter(s => !s.startsWith("bot-"));
    if (realPlayers.length === 0) {
      if (this._botTickInterval) { clearInterval(this._botTickInterval); this._botTickInterval = null; }
      this._bots = [];
      for (const s of [...this.state.players.keys()]) {
        if (s.startsWith("bot-")) this.state.players.delete(s);
      }
      setTimeout(() => this.disconnect(), 3000);
      return;
    }

    const fpsCount = this.state.players.size;
    this.setMetadata({ roomName: this.metadata.roomName, fpsCount, phase: this.state.phase, isArena: true });
    this.broadcast("playerCount", { fpsCount });
  }

  _spawnBots() {
    const currentCount = this.state.players.size;
    const botsNeeded = 4 - currentCount;
    for (let i = 0; i < botsNeeded; i++) {
      const colorIndex = currentCount + i;
      const sid = `bot-${i}`;
      const bot = BotAI.createBot(sid, colorIndex);
      this._bots.push(bot);

      const p = new Player();
      p.role = "fps";
      p.colorIndex = colorIndex;
      p.hp = 500;
      p.x = bot.x; p.y = bot.y; p.z = bot.z;
      p.yaw = bot.yaw;
      this.state.players.set(sid, p);
    }
  }

  _startBotTick() {
    this._botTickInterval = setInterval(() => {
      const dt = 0.1;
      for (const bot of this._bots) {
        BotAI.tick(bot, dt, this.state.players, this);
        const p = this.state.players.get(bot.sid);
        if (p) {
          p.x = bot.x; p.y = bot.y; p.z = bot.z;
          p.yaw = bot.yaw; p.pitch = bot.pitch;
          p.hp = bot.hp; p.jetting = bot.jetting;
        }
      }
    }, 100);
  }

  _botDamagePlayer(attackerSid, targetSid, dmg) {
    if (targetSid.startsWith("bot-")) {
      const bot = this._bots.find(b => b.sid === targetSid);
      if (bot && !bot.dead) {
        bot.hp -= dmg;
        if (bot.hp <= 0) BotAI.killBot(bot);
        const p = this.state.players.get(bot.sid);
        if (p) p.hp = bot.hp;
      }
    } else {
      const targetClient = this.clients.find(c => c.sessionId === targetSid);
      if (targetClient) {
        this.send(targetClient, "pvpDamage", { dmg, attackerSid });
      }
    }
  }

  _botPushPlayer(attackerSid, targetSid, vx, vy, vz) {
    if (targetSid.startsWith("bot-")) {
      const bot = this._bots.find(b => b.sid === targetSid);
      if (bot && !bot.dead) {
        bot.vx += vx; bot.vy += vy; bot.vz += vz;
        bot.ground = false;
      }
    } else {
      const targetClient = this.clients.find(c => c.sessionId === targetSid);
      if (targetClient) {
        this.send(targetClient, "pvpPush", { vx, vy, vz });
      }
    }
  }

  _botBroadcastShot(data) {
    this.broadcast("playerShot", data);
  }

  onDispose() {
    if (this._botTickInterval) clearInterval(this._botTickInterval);
    for (const t of Object.values(this._disconnectTimers)) clearTimeout(t);
  }
}

module.exports = { ArenaRoom };
