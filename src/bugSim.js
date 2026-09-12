// ── Headless bug movement ────────────────────────────────────────────────────
// main.js runs the full bug AI against live meshes, mixers and materials. When
// the commander is hosting (a commander-vs-bots match has no FPS client at all)
// there are no bug meshes to drive — only marker positions — so this module
// reproduces just the movement half of that AI.
//
// Keep the tuning here in step with aiTick() in main.js.

const GRAVITY   = 22;
const TURN_RATE = 4;      // rad/s toward the target heading
const ACCEL     = 6;
const LUNGE_RANGE = 14;   // start lunging inside this distance
const LUNGE_COOLDOWN = [1.9, 2.8];
const LUNGE_SPEED = [8.5, 9.8];
const LUNGE_VY    = [6.8, 7.8];
const ATTACK_RANGE = 0.8;

function randRange(a, b) { return a + Math.random() * (b - a); }

export function createBugSimEntry(id, x, z, speed, hp, bugType) {
  return {
    id, bugType,
    x, y: 0, z,
    vx: 0, vz: 0, vy: 0,
    yaw: 0,
    speed: speed || 6,
    hp: hp == null ? 70 : hp,
    air: false,
    lungeTimer: randRange(...LUNGE_COOLDOWN),
    dormant: false,
  };
}

// ctx: { map, targets: [{x, z}], fallbackTarget: {x, z}, speedBoost }
export function stepBug(bug, dt, ctx) {
  if (bug.dormant) return;
  const { map, targets = [], fallbackTarget = null } = ctx;

  // Nearest target, else the cart.
  let trg = fallbackTarget;
  let best = Infinity;
  for (const t of targets) {
    const d = Math.hypot(t.x - bug.x, t.z - bug.z);
    if (d < best) { best = d; trg = t; }
  }
  if (!trg) return;

  const dx = trg.x - bug.x;
  const dz = trg.z - bug.z;
  const dist = Math.hypot(dx, dz);

  // Turn toward the target.
  const want = Math.atan2(dx, dz);
  let dy = want - bug.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  bug.yaw += dy * Math.min(1, TURN_RATE * dt);

  const fx = Math.sin(bug.yaw);
  const fz = Math.cos(bug.yaw);

  if (!bug.air) {
    const moving = dist > ATTACK_RANGE ? 1 : 0;
    const spd = (ctx.speedBoost ? bug.speed * 2 : bug.speed) * moving;
    // Exponential approach, framerate-independent.
    const k = 1 - Math.exp(-ACCEL * dt);
    bug.vx += (fx * spd - bug.vx) * k;
    bug.vz += (fz * spd - bug.vz) * k;
    bug.x += bug.vx * dt;
    bug.z += bug.vz * dt;

    bug.lungeTimer -= dt;
    if (dist < LUNGE_RANGE && bug.lungeTimer <= 0) {
      bug.air = true;
      bug.lungeTimer = randRange(...LUNGE_COOLDOWN);
      const js = randRange(...LUNGE_SPEED);
      const n = Math.max(0.001, dist);
      bug.vx = (dx / n) * js;
      bug.vz = (dz / n) * js;
      bug.vy = randRange(...LUNGE_VY);
    }
  } else {
    bug.vy -= GRAVITY * dt;
    bug.x += bug.vx * dt;
    bug.z += bug.vz * dt;
    bug.y += bug.vy * dt;
    const gy = map ? map.gy(bug.x, bug.z) : 0;
    if (bug.y <= gy) {
      bug.y = gy;
      bug.air = false;
      bug.vy = 0;
    }
  }

  if (!bug.air) bug.y = map ? map.gy(bug.x, bug.z) : 0;
}
