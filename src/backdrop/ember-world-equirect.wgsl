// ── Ember world: equirectangular sky for the main (nest run) mission ─────────
// Self-contained on purpose. vgpu's lava example imports @vgpu/wgsl-std, which
// needs the WGSL module resolver and therefore a bundler; everything here is
// written inline so `tools/bake-backdrop.mjs` can render it with no build step.
//
// blackbody() is lifted from that example — an incandescence ramp for molten
// rock, cold black crust through deep red and orange to white-hot.
//
// Warm palette on purpose: the mission's fog is 0x2d1f16, so the sky has to sit
// in the same dusty brown-orange family rather than fight it.

struct Params {
  resolution: vec2f,
  pointer: vec2f,
  time: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

const PI: f32 = 3.14159265359;

// Molten planet. y sets elevation: 0.1 put it at ~6 degrees, nearly on the
// horizon and easily hidden by terrain; 0.45 lifts it to ~24, where it clears
// the skyline and is visible from eye level without looking straight up.
const PLANET_DIR: vec3f = vec3f(0.34, 0.45, 0.93);
const PLANET_DIST: f32 = 10.0;
const PLANET_RADIUS: f32 = 3.1;

// Small cold moon on the opposite side for depth.
const MOON_DIR: vec3f = vec3f(-0.72, 0.33, -0.61);
const MOON_DIST: f32 = 15.0;
const MOON_RADIUS: f32 = 0.85;

const SUN_DIR: vec3f = vec3f(-0.45, 0.22, 0.86);

fn hash13(p3in: vec3f) -> f32 {
  var p3 = fract(p3in * 0.1031);
  p3 += dot(p3, p3.zyx + vec3f(31.32));
  return fract((p3.x + p3.y) * p3.z);
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += vec2f(dot(q, q + vec2f(45.32)));
  return fract(q.x * q.y);
}

fn valueNoise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = hash13(i + vec3f(0.0, 0.0, 0.0));
  let n100 = hash13(i + vec3f(1.0, 0.0, 0.0));
  let n010 = hash13(i + vec3f(0.0, 1.0, 0.0));
  let n110 = hash13(i + vec3f(1.0, 1.0, 0.0));
  let n001 = hash13(i + vec3f(0.0, 0.0, 1.0));
  let n101 = hash13(i + vec3f(1.0, 0.0, 1.0));
  let n011 = hash13(i + vec3f(0.0, 1.0, 1.0));
  let n111 = hash13(i + vec3f(1.0, 1.0, 1.0));
  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

fn fbm3(p0: vec3f, octaves: i32) -> f32 {
  var p = p0;
  var value = 0.0;
  var amplitude = 0.5;
  for (var i = 0; i < octaves; i++) {
    value += amplitude * valueNoise3(p);
    p *= 2.02;
    amplitude *= 0.5;
  }
  return value;
}

// Ridged noise carves crack networks rather than soft blobs.
fn ridged3(p0: vec3f, octaves: i32) -> f32 {
  var p = p0;
  var value = 0.0;
  var amplitude = 0.5;
  for (var i = 0; i < octaves; i++) {
    value += amplitude * (1.0 - abs(valueNoise3(p) * 2.0 - 1.0));
    p *= 2.11;
    amplitude *= 0.5;
  }
  return value;
}

// Incandescence ramp for molten rock (from vgpu's lava example).
fn blackbody(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  let ember = mix(vec3f(0.0, 0.0, 0.0), vec3f(0.45, 0.015, 0.0), smoothstep(0.0, 0.30, x));
  let red = mix(ember, vec3f(1.0, 0.16, 0.01), smoothstep(0.28, 0.55, x));
  let orange = mix(red, vec3f(1.0, 0.42, 0.03), smoothstep(0.52, 0.78, x));
  return mix(orange, vec3f(1.0, 0.85, 0.45), smoothstep(0.75, 1.0, x));
}

// Distance along `dir` to a sphere at `centre`, or -1.
fn raySphere(dir: vec3f, centre: vec3f, radius: f32) -> f32 {
  let b = dot(dir, centre);
  if (b < 0.0) { return -1.0; }
  let c = dot(centre, centre) - radius * radius;
  let h = b * b - c;
  if (h < 0.0) { return -1.0; }
  return b - sqrt(h);
}

fn starField(dir: vec3f) -> vec3f {
  let spherical = vec2f(atan2(dir.z, dir.x) / (2.0 * PI), asin(clamp(dir.y, -1.0, 1.0)) / PI);
  let grid = spherical * vec2f(900.0, 450.0);
  let cell = floor(grid);
  let local = fract(grid) - 0.5;
  let seed = hash21(cell);
  let radius = mix(0.02, 0.06, seed * seed);
  let point = smoothstep(radius, 0.0, length(local)) * step(0.988, seed);
  let temperature = hash21(cell + vec2f(17.0, 29.0));
  // Warm-biased tint so the stars belong to this palette.
  let tint = mix(vec3f(0.62, 0.70, 1.0), vec3f(1.0, 0.78, 0.5), temperature * 0.85 + 0.15);
  return tint * point * (1.1 + seed * 2.4);
}

// Dust bands. Warm and low-contrast — this is atmosphere, not a focal point.
fn nebula(dir: vec3f) -> vec3f {
  let warp = fbm3(dir * 1.6 + vec3f(0.0, params.time * 0.004, 0.0), 4);
  let band = fbm3(dir * 2.4 + warp * 0.8, 5);
  // High thresholds keep dust in a few bands instead of overcasting the whole
  // sky — at lower cutoffs this washed out the stars and flattened the planet.
  let dense = smoothstep(0.58, 0.88, band);
  let rim = max(0.0, smoothstep(0.46, 0.70, band) - dense);

  let deep = vec3f(0.022, 0.010, 0.006) * dense;
  let glow = vec3f(0.070, 0.026, 0.009) * rim * 0.6;

  // A faint core behind the molten planet ties the two together.
  let toward = pow(max(0.0, dot(dir, normalize(PLANET_DIR))), 5.0);
  let ignite = vec3f(0.10, 0.036, 0.012) * toward * dense;

  return deep + glow + ignite;
}

fn shadeMolten(hitPoint: vec3f, centre: vec3f) -> vec3f {
  let normal = normalize(hitPoint - centre);
  let t = params.time;

  // Slow creep so a set of bakes at different times gives different flow.
  let domain = normal * 2.3 + vec3f(0.0, 0.0, t * 0.03);
  let plates = ridged3(domain * 1.5, 5);
  let crust = fbm3(domain * 3.1, 5);

  // Cracks: the gaps between plates run hot.
  let crack = smoothstep(0.58, 0.92, plates);
  let deepCrack = smoothstep(0.72, 0.98, plates);
  let heat = clamp(crack * 0.75 + deepCrack * 0.55 - crust * 0.22, 0.0, 1.0);

  let molten = blackbody(heat);
  let rock = mix(vec3f(0.045, 0.028, 0.022), vec3f(0.10, 0.062, 0.045), crust);

  var surface = mix(rock, molten * 1.35, smoothstep(0.12, 0.55, heat));

  // Sun terminator, kept shallow so the night side still glows from within.
  let lambert = max(0.0, dot(normal, normalize(SUN_DIR)));
  let lit = 0.22 + 0.78 * pow(lambert, 0.8);
  surface *= mix(0.55, 1.0, lit);
  surface += molten * heat * 0.9;   // self-emission, independent of the sun

  return surface;
}

fn shadeMoon(hitPoint: vec3f, centre: vec3f) -> vec3f {
  let normal = normalize(hitPoint - centre);
  let craters = fbm3(normal * 7.0, 4);
  let base = mix(vec3f(0.075, 0.070, 0.068), vec3f(0.16, 0.15, 0.14), craters);
  let lambert = max(0.0, dot(normal, normalize(SUN_DIR)));
  // Warm bounce from the molten world on the shadowed side.
  let bounce = vec3f(0.09, 0.035, 0.014) * max(0.0, dot(normal, normalize(PLANET_DIR)));
  return base * (0.06 + 0.94 * lambert) + bounce;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Longitude across the image, latitude up it; the centre maps to +Z.
  let lon = (uv.x * 2.0 - 1.0) * PI;
  // Negated: THREE's equirectUv maps up to v=1, and flipY (the TextureLoader
  // default) puts v=1 at the image's TOP row — so high elevation has to land
  // at the top of the bake, not the bottom.
  let lat = (0.5 - uv.y) * PI;
  let dir = normalize(vec3f(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon)));

  var color = nebula(dir) + starField(dir);

  let planetCentre = normalize(PLANET_DIR) * PLANET_DIST;
  let moonCentre = normalize(MOON_DIR) * MOON_DIST;

  let tMoon = raySphere(dir, moonCentre, MOON_RADIUS);
  if (tMoon > 0.0) {
    color = shadeMoon(dir * tMoon, moonCentre);
  }

  let tPlanet = raySphere(dir, planetCentre, PLANET_RADIUS);
  if (tPlanet > 0.0) {
    color = shadeMolten(dir * tPlanet, planetCentre);
  } else {
    // Heat haze hugging the limb, falling off fast.
    let cosAng = dot(dir, normalize(planetCentre));
    let limb = acos(clamp(cosAng, -1.0, 1.0));
    let horizon = asin(clamp(PLANET_RADIUS / PLANET_DIST, 0.0, 1.0));
    let halo = exp(-max(0.0, limb - horizon) * 26.0);
    color += vec3f(0.85, 0.30, 0.08) * halo * 0.55;
  }

  // Linear HDR out; the bright-pass and composite chain tone maps it.
  return vec4f(color, 1.0);
}
