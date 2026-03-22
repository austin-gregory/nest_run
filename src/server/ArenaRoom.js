const { Room } = require("colyseus");
const { GameState, Player } = require("./GameState");

class ArenaRoom extends Room {
  onCreate(options) {
    this.maxClients = 4;
    this.setState(new GameState());
    this._disconnectTimers = {};
    this._customizations = new Map();

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
    });

    // PvP damage: relay damage to target player
    this.onMessage("pvpHit", (client, data) => {
      if (!data.targetSid || typeof data.dmg !== "number") return;
      const targetClient = this.clients.find(c => c.sessionId === data.targetSid);
      if (targetClient) {
        this.send(targetClient, "pvpDamage", {
          dmg: data.dmg,
          attackerSid: client.sessionId,
        });
      }
    });

    // Force push: relay velocity impulse to target
    this.onMessage("pvpPush", (client, data) => {
      if (!data.targetSid) return;
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
      this.setMetadata({ roomName: this.metadata.roomName, fpsCount: this.metadata.fpsCount, phase: "playing", isArena: true });
      this.broadcast("gameStart", { mode: "arena" });
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
    p.hp = 200;
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
    this.setMetadata({
      roomName: this.metadata.roomName,
      fpsCount: this.state.players.size,
      phase: this.state.phase,
      isArena: true,
    });
    this.broadcast("playerCount", { fpsCount: this.state.players.size });
    if (this.state.players.size === 0) setTimeout(() => this.disconnect(), 3000);
  }

  onDispose() {
    for (const t of Object.values(this._disconnectTimers)) clearTimeout(t);
  }
}

module.exports = { ArenaRoom };
