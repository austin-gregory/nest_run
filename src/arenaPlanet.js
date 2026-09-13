// ── Arena planet ─────────────────────────────────────────────────────────────
// A real sphere in the scene rather than paint on the sky texture, so its bands
// actually flow, its terminator is lit, and geometry can pass in front of it.
//
// Plain GLSL on the existing WebGLRenderer. Nothing here needs WebGPU, a three
// upgrade or a bundler — the vgpu/TSL route would have required all three and
// bought nothing this cannot do.
//
// It rides a group pinned to the camera, so it never gets closer no matter how
// far the player travels: parallax on something meant to read as astronomically
// distant is exactly what breaks the illusion. Depth testing is left on, so the
// arena's platforms correctly occlude it.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const VERT = `
varying vec3 vLocal;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

void main() {
  vLocal = normalize(position);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vViewDir = normalize(cameraPosition - worldPos.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAG = `
uniform float uTime;
uniform vec3  uLightDir;
uniform vec3  uDeep;
uniform vec3  uMid;
uniform vec3  uPale;
uniform vec3  uStorm;
uniform vec3  uRim;

varying vec3 vLocal;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1,0,0));
  float n010 = hash13(i + vec3(0,1,0));
  float n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1));
  float n101 = hash13(i + vec3(1,0,1));
  float n011 = hash13(i + vec3(0,1,1));
  float n111 = hash13(i + vec3(1,1,1));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}

float fbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

// Spin the sampling frame instead of the mesh: the terminator then stays put
// while the bands rotate under it, which is what a lit planet actually does.
vec3 spin(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}

void main() {
  vec3 sp = spin(vLocal, uTime * 0.035);

  // Latitude bands, warped so they meander rather than sitting as clean rings.
  // The frequency matters: at 3.4 only about three bands span the sphere and
  // the warp smears them into flat colour.
  float warp = fbm(sp * 2.1 + vec3(0.0, uTime * 0.02, 0.0));
  float lat = sp.y * 9.0 + warp * 0.75;
  float bands = 0.5 + 0.5 * sin(lat * 3.0);

  // Turbulence riding along the bands; faster near the equator, like shear.
  // Centred on zero, otherwise it only ever brightens and washes the bands out.
  float shear = 1.0 - abs(sp.y) * 0.65;
  float churn = fbm(spin(sp, uTime * 0.05 * shear) * 4.2 + warp) - 0.5;
  bands = clamp(bands * 0.86 + churn * 0.55, 0.0, 1.0);

  vec3 surface = mix(uDeep, uMid, smoothstep(0.10, 0.52, bands));
  surface = mix(surface, uPale, smoothstep(0.52, 0.88, bands));

  // A single long-lived storm, drifting slowly against the rotation.
  vec3 stormCentre = normalize(vec3(0.72, -0.30, 0.62));
  vec3 drifted = spin(sp, uTime * -0.012);
  float d = distance(drifted, stormCentre);
  float storm = smoothstep(0.46, 0.10, d);
  float swirl = fbm(drifted * 7.0 + uTime * 0.06);
  surface = mix(surface, uStorm, storm * (0.55 + 0.45 * swirl));

  // Lighting: a soft terminator, with a little wrap so the night side is not
  // a flat black disc against the sky.
  float ndl = dot(normalize(vWorldNormal), normalize(uLightDir));
  float lit = clamp((ndl + 0.25) / 1.25, 0.0, 1.0);
  lit = pow(lit, 0.85);
  vec3 color = surface * (0.10 + 0.90 * lit);

  // Atmosphere: fresnel rim, brightest where the limb is also lit.
  float fres = pow(1.0 - clamp(dot(normalize(vWorldNormal), normalize(vViewDir)), 0.0, 1.0), 3.0);
  color += uRim * fres * (0.30 + 0.70 * lit) * 2.6;

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * @param scene            THREE.Scene
 * @param opts.direction   world direction the planet sits in (normalised)
 * @param opts.distance    how far out; keep inside the camera's far plane
 * @param opts.radius      sphere radius — with distance, sets apparent size
 * @param opts.lightDir    world direction light arrives from
 */
export function createArenaPlanet(scene, {
  direction = new THREE.Vector3(-0.55, 0.42, -0.72),
  distance = 400,
  radius = 58,
  lightDir = new THREE.Vector3(0.62, 0.28, 0.58),
  deep  = [0.055, 0.145, 0.310],
  mid   = [0.165, 0.435, 0.640],
  pale  = [0.640, 0.840, 0.900],
  storm = [0.022, 0.070, 0.170],
  rim   = [0.247, 0.659, 0.847],
} = {}) {
  const linear = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  const uniforms = {
    uTime: { value: 0 },
    uLightDir: { value: lightDir.clone().normalize() },
    uDeep: { value: linear(deep) },
    uMid: { value: linear(mid) },
    uPale: { value: linear(pale) },
    uStorm: { value: linear(storm) },
    uRim: { value: linear(rim) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: false,          // it is sky, not something in the arena's haze
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), material);
  mesh.position.copy(direction).normalize().multiplyScalar(distance);
  // Tilt the spin axis so the bands are not dead level with the arena floor.
  mesh.rotation.z = 0.22;
  mesh.rotation.x = 0.08;

  // The pivot follows the camera; the planet keeps its offset from it, so the
  // planet never approaches however far the player moves.
  const pivot = new THREE.Group();
  pivot.add(mesh);
  scene.add(pivot);

  return {
    mesh,
    pivot,
    update(dt, camera) {
      uniforms.uTime.value += dt;
      if (camera) camera.getWorldPosition(pivot.position);
    },
    dispose() {
      scene.remove(pivot);
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
