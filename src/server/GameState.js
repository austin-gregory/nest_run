const { Schema, MapSchema, type } = require("@colyseus/schema");

class Player extends Schema {
  constructor() {
    super();
    this.role = "";
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.hp = 200;
    this.colorIndex = 0;
  }
}
type("string")(Player.prototype, "role");
type("float32")(Player.prototype, "x");
type("float32")(Player.prototype, "y");
type("float32")(Player.prototype, "z");
type("float32")(Player.prototype, "yaw");
type("float32")(Player.prototype, "pitch");
type("float32")(Player.prototype, "hp");
type("int8")(Player.prototype, "colorIndex");

class Enemy extends Schema {
  constructor() {
    super();
    this.id = "";
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.yaw = 0;
    this.hp = 70;
    this.speed = 6;
    this.alive = true;
  }
}
type("string")(Enemy.prototype, "id");
type("float32")(Enemy.prototype, "x");
type("float32")(Enemy.prototype, "y");
type("float32")(Enemy.prototype, "z");
type("float32")(Enemy.prototype, "yaw");
type("float32")(Enemy.prototype, "hp");
type("float32")(Enemy.prototype, "speed");
type("boolean")(Enemy.prototype, "alive");

class GameState extends Schema {
  constructor() {
    super();
    this.phase = "waiting";
    this.winner = "";
    this.cartProgress = 0;
    this.biomass = 100;
    this.killCount = 0;
    this.timeRemaining = 600;
    this.players = new MapSchema();
    this.enemies = new MapSchema();
  }
}
type("string")(GameState.prototype, "phase");
type("string")(GameState.prototype, "winner");
type("float32")(GameState.prototype, "cartProgress");
type("float32")(GameState.prototype, "biomass");
type("int32")(GameState.prototype, "killCount");
type("float32")(GameState.prototype, "timeRemaining");
type({ map: Player })(GameState.prototype, "players");
type({ map: Enemy })(GameState.prototype, "enemies");

module.exports = { GameState, Player, Enemy };
