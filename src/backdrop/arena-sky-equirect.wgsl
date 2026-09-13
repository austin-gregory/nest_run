// ── Arena sky: starfield and moons ───────────────────────────────────────────
// The black hole that used to live here is gone; arena's focal bodies are now
// real meshes in the scene (src/arenaPlanet.js), which animate and are occluded
// by the platforms. All this bake has to supply is the backdrop behind them.
//
// Rays are straight, so this renders in a fraction of the time the geodesic
// march took — there is nothing left to bend light.

struct Params {
  resolution: vec2f,
  pointer: vec2f,
  time: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

const PI: f32 = 3.14159265359;

// Two cold moons, high in the sky.
const MOON_DIR: vec3f = vec3f(-0.58, 0.72, -0.38);
const MOON_ANG: f32 = 0.055;
const MOON2_DIR: vec3f = vec3f(0.66, 0.60, 0.45);
const MOON2_ANG: f32 = 0.032;

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += vec2f(dot(q, q + vec2f(45.32)));
  return fract(q.x * q.y);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x), u.y);
}

// A lit sphere seen at infinity: `ang` is its angular radius, so the disc edge
// is a smoothstep on the angle between the ray and the moon's direction.
fn moonDisc(rayDir: vec3f, moonDir: vec3f, ang: f32, tint: vec3f) -> vec3f {
  let d = normalize(moonDir);
  let cosA = dot(normalize(rayDir), d);
  let theta = acos(clamp(cosA, -1.0, 1.0));
  if (theta > ang) { return vec3f(0.0); }

  // Position within the disc, used to fake a lit sphere's shading.
  let r = theta / ang;
  let z = sqrt(max(0.0, 1.0 - r * r));          // height on the sphere
  let up = normalize(cross(d, vec3f(0.0, 1.0, 0.0)) + vec3f(1e-4));
  let side = normalize(cross(up, d));
  let offset = normalize(rayDir - d * cosA + vec3f(1e-6));
  let nx = dot(offset, side) * r;
  let ny = dot(offset, up) * r;
  // -d, not +d: the face we can see points back toward the viewer. With +d the
  // whole disc computed as facing away, so every moon rendered flat ambient.
  let normal = normalize(-d * z + side * nx + up * ny);

  // Lit from the side so there is a visible terminator rather than a flat disc.
  let lightDir = normalize(-d * 0.30 + side * 0.90 + up * 0.30);
  let lambert = max(0.0, dot(normal, lightDir));
  let craters = 0.72 + 0.28 * noise(vec2f(nx, ny) * 9.0);
  let edge = smoothstep(1.0, 0.965, r);          // soften the limb
  return tint * craters * (0.10 + 0.90 * lambert) * edge;
}

fn starField(direction: vec3f) -> vec3f {
  let d = normalize(direction);
  let spherical = vec2f(atan2(d.z, d.x) / (2.0 * PI), asin(clamp(d.y, -1.0, 1.0)) / PI);
  let grid = spherical * vec2f(720.0, 360.0);
  let cell = floor(grid);
  let local = fract(grid) - 0.5;
  let seed = hash21(cell);
  let radius = mix(0.02, 0.07, seed * seed);
  let point = smoothstep(radius, 0.0, length(local)) * step(0.986, seed);
  let glow = smoothstep(radius * 4.0, 0.0, length(local)) * step(0.997, seed) * 0.35;
  let temperature = hash21(cell + vec2f(17.0, 29.0));
  let tint = mix(vec3f(0.48, 0.65, 1.0), vec3f(1.0, 0.72, 0.42), temperature);
  return tint * (point * (1.5 + seed * 3.0) + glow);
}


@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Up in the sky lands at the TOP of the baked image, matching THREE's
  // equirectUv + flipY convention.
  let lon = (uv.x * 2.0 - 1.0) * PI;
  let lat = (0.5 - uv.y) * PI;
  let dir = normalize(vec3f(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon)));

  var color = starField(dir);
  color += moonDisc(dir, MOON_DIR, MOON_ANG, vec3f(0.62, 0.63, 0.70));
  color += moonDisc(dir, MOON2_DIR, MOON2_ANG, vec3f(0.52, 0.47, 0.43));

  return vec4f(color, 1.0);
}
