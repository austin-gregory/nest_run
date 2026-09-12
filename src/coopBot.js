// ── Co-op shooter bots for the main (nest run) mode ──────────────────────────
// Headless: no THREE objects, no scene access. The host client ticks these and
// publishes the resulting positions, so the same module runs whether the host
// is an FPS player (main.js) or the commander with no shooters (rts.js).
//
// Arena's BotAI.js is a server-side deathmatch AI with hardcoded platforms;
// this is the co-op counterpart — bots escort the cart and fight bugs, and read
// terrain from the live world object instead of a mirrored copy.

import { WORLD } from "./constants.js";

const GRAVITY      = 22;
// Below the player's 6.8 / 9.6, but sprint must clear the cart's 7.5/s or a
// bot respawning at the track start can never catch a cart others are pushing.
const WALK_SPEED   = 6.0;
const SPRINT_SPEED = 9.0;
const SPRINT_DIST  = 14;  // sprint when this far off station
const ACCEL        = 40;
const FRICTION     = 10;
const PLAYER_HEIGHT = 1.75;
const MAX_HP       = 200;
const RESPAWN_TIME = 4;

// ── Difficulty ───────────────────────────────────────────────────────────────
// Deliberately mediocre shots: they contribute, but a human carries the team.
const SHOT_RATE        = 5;     // shots/sec (player fires 11.2)
const SHOT_DMG         = 36;    // same per-bullet damage as the player SMG
const SHOT_RANGE       = 110;   // well under the player's 280
const HIT_CHANCE_CLOSE = 0.22;  // within CLOSE_DIST
const HIT_CHANCE_FAR   = 0.05;  // at FAR_DIST and beyond
const CLOSE_DIST       = 12;
const FAR_DIST         = 60;
const AIM_LERP_RATE    = 5;     // rad/s — visibly slower than a human flick
const REACTION_TIME    = [0.18, 0.45]; // delay before opening fire on a new target

// A wall is a big static target, so bots connect far more often than against a
// scurrying bug — but still well short of a player, who barely misses one.
// At 1200 wall HP and 36 damage a lone bot needs ~14s; a human needs ~3s.
const WALL_HIT_CHANCE  = 0.7;

// ── Positioning ──────────────────────────────────────────────────────────────
// Bots must stand INSIDE the cart's push radius to actually move it, so the
// escort ring is a fraction of that radius rather than a fixed distance.
const ESCORT_FRACTION  = 0.55; // how far into the push radius bots hold station
const DEFAULT_CART_RAD = 8.2;  // map.cart.rad
const ENGAGE_RANGE     = 55;   // start shooting at bugs within this
const KEEP_AWAY        = 7;    // sidestep a bug that closes inside this
const LEASH            = 16;   // never end up further than this from the cart
const SEPARATION       = 4.5;  // personal space between bots/allies
const STRAFE_INTERVAL  = [0.7, 2.0];

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function randRange(a, b) { return a + Math.random() * (b - a); }

// ── Create ───────────────────────────────────────────────────────────────────
export function createCoopBot(index, name) {
  const sp = WORLD.SPAWN_POINTS[index % WORLD.SPAWN_POINTS.length];
  return {
    sid: `bot-${index}`,
    index,
    name: name || `Bot ${index + 1}`,
    colorIndex: index % WORLD.FPS_COLORS.length,

    x: sp.x, y: PLAYER_HEIGHT, z: sp.z,
    vx: 0, vy: 0, vz: 0,
    yaw: sp.yaw, pitch: 0,
    ground: true,
    hp: MAX_HP,
    dead: false,
    respawnTimer: 0,

    targetId: null,
    pushingCart: false,
    shootCooldown: 0,
    reactionTimer: 0,
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    strafeTimer: randRange(...STRAFE_INTERVAL),
    kills: 0,
  };
}

// ── Respawn / death ──────────────────────────────────────────────────────────
export function killCoopBot(bot) {
  if (bot.dead) return;
  bot.hp = 0;
  bot.dead = true;
  bot.respawnTimer = RESPAWN_TIME;
  bot.vx = bot.vy = bot.vz = 0;
  bot.targetId = null;
}

function respawn(bot, map) {
  const sp = WORLD.SPAWN_POINTS[bot.index % WORLD.SPAWN_POINTS.length];
  bot.x = sp.x; bot.z = sp.z;
  bot.y = (map ? map.gy(sp.x, sp.z) : 0) + PLAYER_HEIGHT;
  bot.vx = bot.vy = bot.vz = 0;
  bot.yaw = sp.yaw; bot.pitch = 0;
  bot.hp = MAX_HP;
  bot.dead = false;
  bot.ground = true;
  bot.targetId = null;
  bot.shootCooldown = 1;
}

// ── Target selection ─────────────────────────────────────────────────────────
function pickTarget(bot, enemies) {
  let best = null, bestDist = Infinity;
  for (const en of enemies) {
    if (!en.alive || en.hp <= 0 || en.dormant) continue;
    const d = Math.hypot(en.x - bot.x, en.z - bot.z);
    if (d > ENGAGE_RANGE) continue;
    if (d < bestDist) { bestDist = d; best = en; }
  }
  return best;
}

// ── Tick one bot ─────────────────────────────────────────────────────────────
// ctx: { map, enemies, allies, onShoot(bot, enemy, hit), onKill(bot, enemy) }
//   enemies: [{ id, x, y, z, hp, alive, dormant }]
//   allies:  [{ x, z }]   — other bots and real players, for spacing
export function tickCoopBot(bot, dt, ctx) {
  const { map, enemies = [], allies = [] } = ctx;

  if (bot.dead) {
    bot.respawnTimer -= dt;
    if (bot.respawnTimer <= 0) respawn(bot, map);
    return;
  }

  bot.shootCooldown = Math.max(0, bot.shootCooldown - dt);
  bot.strafeTimer -= dt;
  if (bot.strafeTimer <= 0) {
    bot.strafeDir = Math.random() < 0.5 ? 1 : -1;
    bot.strafeTimer = randRange(...STRAFE_INTERVAL);
  }

  // ── Target ────────────────────────────────────────────────────────────────
  const prevId = bot.targetId;
  const target = pickTarget(bot, enemies);
  bot.targetId = target ? target.id : null;
  if (bot.targetId && bot.targetId !== prevId) {
    bot.reactionTimer = randRange(...REACTION_TIME);
  }
  if (bot.reactionTimer > 0) bot.reactionTimer -= dt;

  const tDist = target ? Math.hypot(target.x - bot.x, target.z - bot.z) : Infinity;

  // ── Where to stand ────────────────────────────────────────────────────────
  // Holding the cart IS the job — it only moves while someone stands inside its
  // push radius. Bots reach 55 units, so they never need to close on a bug;
  // chasing one just walks them off the cart and stalls the escort.
  const cart = ctx.cartPos || (map && map.car ? map.car.position : null);
  const cartRad = ctx.cartRadius || (map && map.cart ? map.cart.rad : DEFAULT_CART_RAD);
  let goalX, goalZ;

  if (cart) {
    // Spread around the cart but stay within its push radius so they drive it.
    const ang = (bot.index / Math.max(1, WORLD.SPAWN_POINTS.length)) * Math.PI * 2;
    const ring = cartRad * ESCORT_FRACTION;
    goalX = cart.x + Math.cos(ang) * ring;
    goalZ = cart.z + Math.sin(ang) * ring;
  } else {
    goalX = bot.x; goalZ = bot.z;
  }

  // A bug in their face nudges them off station, but only far enough to make
  // room — the leash below pulls them straight back onto the cart.
  if (target && tDist < KEEP_AWAY) {
    const nx = (bot.x - target.x) / Math.max(0.001, tDist);
    const nz = (bot.z - target.z) / Math.max(0.001, tDist);
    const away = KEEP_AWAY - tDist;
    goalX += nx * away;
    goalZ += nz * away;
  }

  // Bugs keep coming, so without a leash the sidestep above compounds and the
  // bot drifts off the cart it's meant to be pushing.
  if (cart) {
    const gdx = goalX - cart.x, gdz = goalZ - cart.z;
    const gd = Math.hypot(gdx, gdz);
    if (gd > LEASH) {
      goalX = cart.x + (gdx / gd) * LEASH;
      goalZ = cart.z + (gdz / gd) * LEASH;
    }
  }

  let wishX = goalX - bot.x;
  let wishZ = goalZ - bot.z;
  const goalDist = Math.hypot(wishX, wishZ);
  if (goalDist > 0.6) { wishX /= goalDist; wishZ /= goalDist; }
  else { wishX = 0; wishZ = 0; }

  // Strafe while fighting so they aren't stationary targets.
  if (target && tDist < ENGAGE_RANGE && goalDist < 3) {
    const fx = wishX, fz = wishZ;
    wishX += -fz * bot.strafeDir * 0.6;
    wishZ += fx * bot.strafeDir * 0.6;
  }

  // Separation from allies.
  for (const a of allies) {
    const dx = bot.x - a.x, dz = bot.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.001 && d < SEPARATION) {
      const push = (SEPARATION - d) / SEPARATION;
      wishX += (dx / d) * push * 1.2;
      wishZ += (dz / d) * push * 1.2;
    }
  }

  const wLen = Math.hypot(wishX, wishZ);
  if (wLen > 0.001) { wishX /= wLen; wishZ /= wLen; }

  // ── Firing target ─────────────────────────────────────────────────────────
  // A wall blocking the cart stops the run dead, so it outranks bugs — except
  // when one is already biting, which has to be dealt with first.
  const wall = ctx.blockingWall || null;
  const bugUrgent = !!target && tDist < KEEP_AWAY;
  const shootWall = !!wall && !bugUrgent;
  const aimAt = shootWall
    ? { x: wall.x, y: wall.y != null ? wall.y : bot.y, z: wall.z }
    : target;

  // ── Aim ───────────────────────────────────────────────────────────────────
  if (aimAt) {
    const dx = aimAt.x - bot.x;
    const dz = aimAt.z - bot.z;
    const dy = (aimAt.y + 0.8) - bot.y;
    const hDist = Math.hypot(dx, dz);
    const desiredYaw = Math.atan2(-dx, -dz);
    const desiredPitch = Math.atan2(dy, Math.max(0.001, hDist));

    let yawDiff = desiredYaw - bot.yaw;
    while (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
    while (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
    const k = Math.min(1, AIM_LERP_RATE * dt);
    bot.yaw += yawDiff * k;
    bot.pitch = clamp(bot.pitch + (desiredPitch - bot.pitch) * k, -1.45, 1.45);
  } else if (wLen > 0.001) {
    // Face where they're walking.
    let yawDiff = Math.atan2(-wishX, -wishZ) - bot.yaw;
    while (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
    while (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
    bot.yaw += yawDiff * Math.min(1, 3 * dt);
    bot.pitch += (0 - bot.pitch) * Math.min(1, 3 * dt);
  }

  // ── Movement ──────────────────────────────────────────────────────────────
  // Sprint on distance alone. Gating this on "no target" meant any bug within
  // the 55-unit engage range pinned them to walking speed, which is slower than
  // the cart — so a bot that fell behind never rejoined it.
  const speed = goalDist > SPRINT_DIST ? SPRINT_SPEED : WALK_SPEED;

  const hSpeed = Math.hypot(bot.vx, bot.vz);
  if (hSpeed > 1e-4) {
    const drop = hSpeed * FRICTION * dt;
    const k = Math.max(0, hSpeed - drop) / hSpeed;
    bot.vx *= k; bot.vz *= k;
  }
  if (wishX !== 0 || wishZ !== 0) {
    const current = bot.vx * wishX + bot.vz * wishZ;
    const add = speed - current;
    if (add > 0) {
      const a = Math.min(add, ACCEL * dt * speed);
      bot.vx += wishX * a;
      bot.vz += wishZ * a;
    }
  }

  bot.vy -= GRAVITY * dt;
  bot.x += bot.vx * dt;
  bot.y += bot.vy * dt;
  bot.z += bot.vz * dt;

  // Terrain follow.
  const groundY = map ? map.gy(bot.x, bot.z) : 0;
  if (bot.y < groundY + PLAYER_HEIGHT) {
    bot.y = groundY + PLAYER_HEIGHT;
    if (bot.vy < 0) bot.vy = 0;
    bot.ground = true;
  } else {
    bot.ground = false;
  }

  // Static world collision — same AABB list the player pushes out of.
  if (map && map.aabbs) {
    for (const b of map.aabbs) {
      const feet = bot.y - PLAYER_HEIGHT;
      const head = bot.y + 0.15;
      if (head < b.min.y || feet > b.max.y) continue;
      const cx = clamp(bot.x, b.min.x, b.max.x);
      const cz = clamp(bot.z, b.min.z, b.max.z);
      const dx = bot.x - cx, dz = bot.z - cz;
      const d = Math.hypot(dx, dz);
      if (d > 0.45 || d < 1e-5) continue;
      const p = 0.45 - d;
      bot.x += (dx / d) * p;
      bot.z += (dz / d) * p;
      const vn = bot.vx * (dx / d) + bot.vz * (dz / d);
      if (vn < 0) {
        bot.vx -= vn * (dx / d);
        bot.vz -= vn * (dz / d);
      }
    }
  }

  // Hosts read this to decide whether the cart should advance.
  bot.pushingCart = !!cart && Math.hypot(cart.x - bot.x, cart.z - bot.z) <= cartRad;

  // ── Shooting ──────────────────────────────────────────────────────────────
  if (shootWall && bot.shootCooldown <= 0) {
    const wDist = Math.hypot(wall.x - bot.x, wall.z - bot.z);
    if (wDist <= SHOT_RANGE) {
      bot.shootCooldown = 1 / SHOT_RATE;
      const hit = Math.random() < WALL_HIT_CHANCE;
      if (ctx.onWallShoot) ctx.onWallShoot(bot, wall, hit);
    }
  } else if (target && bot.reactionTimer <= 0 && bot.shootCooldown <= 0 && tDist <= SHOT_RANGE) {
    bot.shootCooldown = 1 / SHOT_RATE;

    const t = clamp((tDist - CLOSE_DIST) / (FAR_DIST - CLOSE_DIST), 0, 1);
    const hitChance = HIT_CHANCE_CLOSE + (HIT_CHANCE_FAR - HIT_CHANCE_CLOSE) * t;
    const hit = Math.random() < hitChance;

    if (ctx.onShoot) ctx.onShoot(bot, target, hit);

    if (hit) {
      target.hp -= SHOT_DMG;
      if (target.hp <= 0 && ctx.onKill) {
        bot.kills++;
        ctx.onKill(bot, target);
      }
    }
  }
}

export const COOP_BOT_CONSTANTS = {
  MAX_HP, PLAYER_HEIGHT, SHOT_DMG, SHOT_RATE, RESPAWN_TIME,
};
