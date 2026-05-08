// ── Server-side Bot AI for Arena Mode ────────────────────────────────────────
// Bots are Player entries with fake session IDs ("bot-0", etc.).
// All physics mirror the client constants from arena.js / arenaWorld.js.

const GRAVITY     = 22;
const WALK_SPEED  = 5.0;
const AIR_SPEED   = 4.6;
const GROUND_ACCEL = 45;
const AIR_ACCEL   = 12;
const GROUND_FRIC = 10;
const AIR_FRIC    = 0.35;

const JET_FUEL_MAX   = 150;
const JET_DRAIN      = 40;
const JET_RECHARGE   = 30;
const JET_THRUST     = 32;
const JET_MAX_VEL_Y  = 8;
const PLAYER_HEIGHT  = 1.75;
const FALL_THRESHOLD = -5;

const SMG_DMG   = 36;
const SMG_RATE  = 6;     // shots/sec (well below player's 11.2)
const SMG_RANGE = 280;
const FORCE_RATE = 0.5;
const FORCE_RADIUS = 15;
const FORCE_IMPULSE_H = 30;
const FORCE_IMPULSE_V = 4;
const CHECKPOINT_RADIUS = 6;

// Difficulty tuning
const AIM_LERP_RATE     = 4;     // rad/s toward target (slower tracking)
const HIT_CHANCE_CLOSE  = 0.25;  // at < 10 units
const HIT_CHANCE_FAR    = 0.06;  // at 60+ units
const STRAFE_INTERVAL   = [0.6, 1.8]; // seconds between strafe changes
const JET_BURST_RANGE   = [0.4, 1.2]; // seconds of jetpack bursts
const WEAPON_SWITCH_INTERVAL = [5, 10]; // seconds between weapon re-evaluation
const FORCE_GUN_CHANCE  = 0.2;   // 20% chance to pick force gun on switch

// ── Platform data (mirrors arenaWorld.js) ────────────────────────────────────
const PLAT_W = 44, PLAT_D = 44;
const FLOAT_PLATS = [
  { x:  14, y: 10, z:  14, w: 7, d: 7 },
  { x: -14, y: 10, z: -14, w: 7, d: 7 },
  { x:   0, y: 16, z:   0, w: 6, d: 6 },  // center — force gun pickup
  { x: -14, y: 12, z:  14, w: 5, d: 5 },
  { x:  14, y: 12, z: -14, w: 5, d: 5 },
];

const SPAWN_POINTS = [
  { x:  0,  z:  16, yaw: 0 },
  { x:  0,  z: -16, yaw: Math.PI },
  { x:  16, z:   0, yaw: Math.PI / 2 },
  { x: -16, z:   0, yaw: -Math.PI / 2 },
];

// All navigable targets (platforms + ground positions)
const NAV_TARGETS = [
  { x:  0,  y: 0,  z:  0  },  // center ground
  { x:  14, y: 10, z:  14 },
  { x: -14, y: 10, z: -14 },
  { x:   0, y: 16, z:   0 },  // center platform (force gun)
  { x: -14, y: 12, z:  14 },
  { x:  14, y: 12, z: -14 },
];

// ── Ground height (mirrors arenaWorld.js gy) ─────────────────────────────────
function gy(x, z, playerY) {
  let best = -9999;
  if (Math.abs(x) < PLAT_W / 2 && Math.abs(z) < PLAT_D / 2) best = 0;
  for (const fp of FLOAT_PLATS) {
    if (Math.abs(x - fp.x) < fp.w / 2 && Math.abs(z - fp.z) < fp.d / 2) {
      if (fp.y > best && (playerY === undefined || playerY >= fp.y)) best = fp.y;
    }
  }
  return best;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function randRange(a, b) { return a + Math.random() * (b - a); }
function dist3(a, b) { return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2); }
function distXZ(a, b) { return Math.sqrt((a.x-b.x)**2 + (a.z-b.z)**2); }

// ── Create a new bot ─────────────────────────────────────────────────────────
function createBot(sid, colorIndex) {
  const sp = SPAWN_POINTS[colorIndex] || SPAWN_POINTS[0];
  return {
    sid,
    colorIndex,
    x: sp.x, y: PLAYER_HEIGHT, z: sp.z,
    vx: 0, vy: 0, vz: 0,
    yaw: sp.yaw, pitch: 0,
    hp: 500,
    jetFuel: JET_FUEL_MAX,
    ground: true,
    jetting: false,
    dead: false,
    respawnTimer: 0,

    // Weapons
    weapon: "smg",          // "smg" | "force"
    hasForceGun: false,
    shootCooldown: 0,
    weaponSwitchTimer: randRange(...WEAPON_SWITCH_INTERVAL),

    // AI
    aiState: "idle",        // "idle" | "navigate" | "fight" | "dead"
    targetSid: null,
    navTarget: null,        // {x, y, z}
    stateTimer: 0,
    strafeDir: 1,           // 1 or -1
    strafeTimer: randRange(...STRAFE_INTERVAL),
    jetBurstTimer: 0,
    wantJet: false,
  };
}

// ── Pick nearest living target ───────────────────────────────────────────────
function pickTarget(bot, players) {
  let best = null, bestDist = Infinity;
  players.forEach((p, sid) => {
    if (sid === bot.sid) return;
    if (p.hp <= 0) return;
    const d = dist3(bot, { x: p.x, y: p.y, z: p.z });
    if (d < bestDist) { bestDist = d; best = sid; }
  });
  return best;
}

// ── Main tick for one bot ────────────────────────────────────────────────────
function tick(bot, dt, players, room) {
  if (bot.dead) {
    bot.respawnTimer -= dt;
    if (bot.respawnTimer <= 0) {
      respawn(bot);
    }
    return;
  }

  // Decrement timers
  bot.shootCooldown = Math.max(0, bot.shootCooldown - dt);
  bot.stateTimer -= dt;
  bot.strafeTimer -= dt;
  bot.weaponSwitchTimer -= dt;

  // Strafe direction change
  if (bot.strafeTimer <= 0) {
    bot.strafeDir = Math.random() < 0.5 ? 1 : -1;
    bot.strafeTimer = randRange(...STRAFE_INTERVAL);
  }

  // Weapon switch evaluation
  if (bot.hasForceGun && bot.weaponSwitchTimer <= 0) {
    bot.weapon = Math.random() < FORCE_GUN_CHANCE ? "force" : "smg";
    bot.weaponSwitchTimer = randRange(...WEAPON_SWITCH_INTERVAL);
  }

  // Jetpack burst timer
  if (bot.jetBurstTimer > 0) {
    bot.jetBurstTimer -= dt;
    bot.wantJet = true;
  } else {
    bot.wantJet = false;
  }

  // ── AI state machine ────────────────────────────────────────────────────
  const target = bot.targetSid ? players.get(bot.targetSid) : null;
  const targetAlive = target && target.hp > 0;

  if (!targetAlive || bot.stateTimer <= 0) {
    bot.targetSid = pickTarget(bot, players);
  }

  const curTarget = bot.targetSid ? players.get(bot.targetSid) : null;
  const tAlive = curTarget && curTarget.hp > 0;
  const tDist = tAlive ? dist3(bot, { x: curTarget.x, y: curTarget.y, z: curTarget.z }) : Infinity;

  switch (bot.aiState) {
    case "idle":
      if (tAlive && tDist < 45) {
        bot.aiState = "fight";
        bot.stateTimer = 4 + Math.random() * 3;
      } else if (tAlive) {
        // Navigate toward a platform near the target
        bot.navTarget = pickNavTarget(bot, curTarget);
        bot.aiState = "navigate";
        bot.stateTimer = 6;
      } else {
        // No target — roam to random platform
        bot.navTarget = NAV_TARGETS[Math.floor(Math.random() * NAV_TARGETS.length)];
        bot.aiState = "navigate";
        bot.stateTimer = 6;
      }
      break;

    case "navigate": {
      if (tAlive && tDist < 30) {
        bot.aiState = "fight";
        bot.stateTimer = 4 + Math.random() * 3;
        break;
      }
      if (!bot.navTarget || bot.stateTimer <= 0) {
        bot.aiState = "idle";
        break;
      }
      const nd = distXZ(bot, bot.navTarget);
      if (nd < 3) {
        bot.aiState = "idle";
        break;
      }
      break;
    }

    case "fight":
      if (!tAlive) {
        bot.aiState = "idle";
        break;
      }
      if (bot.stateTimer <= 0) {
        // Re-evaluate: maybe navigate to a platform for better position
        if (Math.random() < 0.3 && !bot.hasForceGun) {
          // Go get force gun
          bot.navTarget = { x: 0, y: 16, z: 0 };
          bot.aiState = "navigate";
          bot.stateTimer = 6;
        } else {
          bot.stateTimer = 3 + Math.random() * 3;
        }
      }
      break;
  }

  // ── Movement computation ────────────────────────────────────────────────
  let wishX = 0, wishZ = 0;

  if (bot.aiState === "navigate" && bot.navTarget) {
    const dx = bot.navTarget.x - bot.x;
    const dz = bot.navTarget.z - bot.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len > 0.5) {
      wishX = dx / len;
      wishZ = dz / len;
    }
    // Need to go up? Jetpack
    if (bot.navTarget.y > bot.y + 2 && bot.jetFuel > 10) {
      bot.wantJet = true;
    }
  } else if (bot.aiState === "fight" && tAlive) {
    // Move toward target but strafe
    const dx = curTarget.x - bot.x;
    const dz = curTarget.z - bot.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len > 0.1) {
      const fwdX = dx / len, fwdZ = dz / len;
      // Strafe perpendicular
      const strafeX = -fwdZ * bot.strafeDir;
      const strafeZ = fwdX * bot.strafeDir;
      // Approach if far, back up if too close
      let approach = 0;
      if (tDist > 20) approach = 0.6;
      else if (tDist < 8) approach = -0.4;
      wishX = fwdX * approach + strafeX * 0.8;
      wishZ = fwdZ * approach + strafeZ * 0.8;
      const wLen = Math.sqrt(wishX * wishX + wishZ * wishZ);
      if (wLen > 0) { wishX /= wLen; wishZ /= wLen; }
    }
    // Random jet bursts during combat
    if (bot.jetBurstTimer <= 0 && Math.random() < 0.02) {
      bot.jetBurstTimer = randRange(...JET_BURST_RANGE);
    }
  }

  // ── Aiming ──────────────────────────────────────────────────────────────
  if (tAlive) {
    const dx = curTarget.x - bot.x;
    const dy = (curTarget.y) - (bot.y);
    const dz = curTarget.z - bot.z;
    const hDist = Math.sqrt(dx * dx + dz * dz);
    const desiredYaw = Math.atan2(-dx, -dz);
    const desiredPitch = Math.atan2(dy, hDist);

    // Lerp toward target (not instant snap)
    let yawDiff = desiredYaw - bot.yaw;
    // Normalize to [-PI, PI]
    while (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
    while (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
    bot.yaw += yawDiff * Math.min(1, AIM_LERP_RATE * dt);
    bot.pitch += (desiredPitch - bot.pitch) * Math.min(1, AIM_LERP_RATE * dt);
    bot.pitch = clamp(bot.pitch, -1.45, 1.45);
  }

  // ── Physics ─────────────────────────────────────────────────────────────
  const speed = bot.ground ? WALK_SPEED : AIR_SPEED;
  const accelRate = bot.ground ? GROUND_ACCEL : AIR_ACCEL;
  const fricRate = bot.ground ? GROUND_FRIC : AIR_FRIC;

  // Friction
  const hSpeed = Math.sqrt(bot.vx * bot.vx + bot.vz * bot.vz);
  if (hSpeed > 0) {
    const drop = Math.max(hSpeed, 1) * fricRate * dt;
    const factor = Math.max(0, hSpeed - drop) / hSpeed;
    bot.vx *= factor;
    bot.vz *= factor;
  }

  // Acceleration toward wish direction
  if (wishX !== 0 || wishZ !== 0) {
    const currentSpeed = bot.vx * wishX + bot.vz * wishZ;
    const addSpeed = speed - currentSpeed;
    if (addSpeed > 0) {
      const accelAmount = Math.min(addSpeed, accelRate * dt * speed);
      bot.vx += wishX * accelAmount;
      bot.vz += wishZ * accelAmount;
    }
  }

  // Jetpack / gravity
  if (bot.wantJet && bot.jetFuel > 0) {
    if (bot.ground) {
      bot.vy = 4;
      bot.ground = false;
    }
    bot.vy -= GRAVITY * 0.55 * dt;
    bot.vy += JET_THRUST * dt;
    if (bot.vy > JET_MAX_VEL_Y) bot.vy = JET_MAX_VEL_Y;
    bot.jetFuel = Math.max(0, bot.jetFuel - JET_DRAIN * dt);
    bot.jetting = true;
  } else {
    const gScale = (!bot.ground && bot.jetFuel > 0) ? 0.6 : 1;
    bot.vy -= GRAVITY * gScale * dt;
    bot.jetting = false;
    if (!bot.wantJet) {
      bot.jetFuel = Math.min(JET_FUEL_MAX, bot.jetFuel + JET_RECHARGE * dt);
    }
  }

  // Integrate position
  bot.x += bot.vx * dt;
  bot.y += bot.vy * dt;
  bot.z += bot.vz * dt;

  // Ground collision
  const groundY = gy(bot.x, bot.z, bot.y);
  const feetY = groundY + PLAYER_HEIGHT;
  if (bot.y <= feetY && groundY > -9000) {
    bot.y = feetY;
    if (bot.vy < 0) bot.vy = 0;
    bot.ground = true;
  } else if (groundY <= -9000) {
    bot.ground = false;
  } else {
    bot.ground = false;
  }

  // Fall death
  if (bot.y < FALL_THRESHOLD) {
    killBot(bot);
    return;
  }

  // ── Force gun pickup check ──────────────────────────────────────────────
  if (!bot.hasForceGun) {
    const cpDist = dist3(bot, { x: 0, y: 16, z: 0 });
    if (cpDist < CHECKPOINT_RADIUS) {
      bot.hasForceGun = true;
    }
  }

  // ── Shooting ────────────────────────────────────────────────────────────
  if (bot.aiState === "fight" && tAlive && bot.shootCooldown <= 0) {
    if (bot.weapon === "smg") {
      shootSMG(bot, curTarget, bot.targetSid, room);
    } else if (bot.weapon === "force" && bot.hasForceGun) {
      shootForceGun(bot, players, room);
    }
  }
}

// ── SMG shooting ─────────────────────────────────────────────────────────────
function shootSMG(bot, target, targetSid, room) {
  bot.shootCooldown = 1 / SMG_RATE;

  const dx = target.x - bot.x;
  const dy = target.y - bot.y;
  const dz = target.z - bot.z;
  const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if (d > SMG_RANGE || d < 0.1) return;

  // Hit probability scales with distance
  const t = clamp((d - 10) / 50, 0, 1);
  const hitChance = HIT_CHANCE_CLOSE + (HIT_CHANCE_FAR - HIT_CHANCE_CLOSE) * t;
  const hit = Math.random() < hitChance;

  // Tracer end point (always broadcast for visuals)
  const dirX = dx/d, dirY = dy/d, dirZ = dz/d;
  const tracerDist = hit ? d : d + 5;
  const tx = bot.x + dirX * tracerDist;
  const ty = bot.y + dirY * tracerDist;
  const tz = bot.z + dirZ * tracerDist;

  room._botBroadcastShot({
    fx: bot.x, fy: bot.y, fz: bot.z,
    tx, ty, tz,
  });

  if (hit) {
    room._botDamagePlayer(bot.sid, targetSid, SMG_DMG);
  }
}

// ── Force gun shooting ───────────────────────────────────────────────────────
function shootForceGun(bot, players, room) {
  bot.shootCooldown = 1 / FORCE_RATE;

  // Facing direction (horizontal) — matches camera forward (-sin, -cos)
  const fdx = -Math.sin(bot.yaw);
  const fdz = -Math.cos(bot.yaw);

  players.forEach((p, sid) => {
    if (sid === bot.sid || p.hp <= 0) return;
    const dx = p.x - bot.x;
    const dz = p.z - bot.z;
    const hDist = Math.sqrt(dx*dx + dz*dz);
    if (hDist > FORCE_RADIUS || hDist < 0.1) return;

    // Check facing (dot product)
    const nx = dx/hDist, nz = dz/hDist;
    const dot = fdx * nx + fdz * nz;
    if (dot < 0.3) return; // must be roughly in front

    const falloff = 1 - (hDist / FORCE_RADIUS) * 0.5;
    const pushX = nx * FORCE_IMPULSE_H * falloff;
    const pushZ = nz * FORCE_IMPULSE_H * falloff;
    const pushY = FORCE_IMPULSE_V;

    room._botPushPlayer(bot.sid, sid, pushX, pushY, pushZ);
  });

  // Broadcast a tracer-like shot for visual feedback
  room._botBroadcastShot({
    fx: bot.x, fy: bot.y, fz: bot.z,
    tx: bot.x + fdx * FORCE_RADIUS,
    ty: bot.y,
    tz: bot.z + fdz * FORCE_RADIUS,
  });
}

// ── Navigation helper ────────────────────────────────────────────────────────
function pickNavTarget(bot, target) {
  if (!target) return NAV_TARGETS[Math.floor(Math.random() * NAV_TARGETS.length)];

  // Pick platform closest to target
  let best = null, bestDist = Infinity;
  for (const nav of NAV_TARGETS) {
    const d = dist3({ x: target.x, y: target.y, z: target.z }, nav);
    // Add some randomness so bots don't all go to the same spot
    const score = d + Math.random() * 15;
    if (score < bestDist) { bestDist = score; best = nav; }
  }
  return best || NAV_TARGETS[0];
}

// ── Respawn / kill ───────────────────────────────────────────────────────────
function respawn(bot) {
  const sp = SPAWN_POINTS[bot.colorIndex] || SPAWN_POINTS[0];
  bot.x = sp.x; bot.y = PLAYER_HEIGHT; bot.z = sp.z;
  bot.vx = 0; bot.vy = 0; bot.vz = 0;
  bot.yaw = sp.yaw; bot.pitch = 0;
  bot.hp = 500;
  bot.jetFuel = JET_FUEL_MAX;
  bot.ground = true;
  bot.jetting = false;
  bot.dead = false;
  bot.aiState = "idle";
  bot.targetSid = null;
  bot.shootCooldown = 0.5; // brief delay before shooting after respawn
  bot.weapon = "smg";
}

function killBot(bot) {
  bot.hp = 0;
  bot.dead = true;
  bot.respawnTimer = 3;
  bot.vx = 0; bot.vy = 0; bot.vz = 0;
  bot.jetting = false;
}

module.exports = { createBot, tick, killBot };
