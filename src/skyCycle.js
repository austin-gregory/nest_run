// ── Animated sky from baked frames ───────────────────────────────────────────
// scene.background can hold one texture and cannot blend between two, so the
// sky is drawn as an inverted sphere with a material that crossfades a pair of
// equirect frames. Gives a living sky on plain WebGL — no WebGPU at runtime.
//
// Frames are baked by tools/bake-frames.mjs and played as a ping-pong
// (0 1 2 3 4 5 4 3 2 1 …) rather than a loop. The sequences are turbulent flow
// and never return to their start, so looping would pop on the wrap; a
// ping-pong has no seam at all.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = `
uniform sampler2D texA;
uniform sampler2D texB;
uniform float blend;
varying vec2 vUv;
void main() {
  vec4 a = texture2D(texA, vUv);
  vec4 b = texture2D(texB, vUv);
  gl_FragColor = mix(a, b, blend);
  #include <colorspace_fragment>
}
`;

/**
 * @param scene   THREE.Scene to add the sky to
 * @param opts.frames    array of image URLs, in order
 * @param opts.radius    sphere radius; must sit inside the camera's far plane
 * @param opts.hold      seconds to rest on a frame before crossfading
 * @param opts.fade      seconds the crossfade itself takes
 */
export function createSkyCycle(scene, {
  frames,
  radius = 500,
  hold = 3.5,
  fade = 2.5,
} = {}) {
  if (!frames || frames.length < 2) {
    throw new Error("createSkyCycle needs at least two frames");
  }

  const loader = new THREE.TextureLoader();
  const textures = frames.map((url) => {
    const t = loader.load(url);
    t.colorSpace = THREE.SRGBColorSpace;
    // The sky is sampled across the whole sphere; clamping avoids a bright
    // seam bleeding around the longitude wrap.
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearFilter;   // no mips: one level, sampled flat
    t.generateMipmaps = false;
    return t;
  });

  const material = new THREE.ShaderMaterial({
    uniforms: {
      texA: { value: textures[0] },
      texB: { value: textures[1 % textures.length] },
      blend: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,      // always behind everything
    fog: false,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), material);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  scene.add(mesh);

  let index = 0;
  let direction = 1;    // ping-pong
  let timer = 0;

  function nextIndex(from, dir) {
    let next = from + dir;
    if (next >= textures.length || next < 0) return from - dir;
    return next;
  }

  return {
    mesh,
    /** Call each frame with dt (seconds) and the camera, so the sky follows it. */
    update(dt, camera) {
      if (camera) camera.getWorldPosition(mesh.position);

      timer += dt;
      if (timer < hold) {
        material.uniforms.blend.value = 0;
        return;
      }
      const t = (timer - hold) / fade;
      if (t >= 1) {
        // Land on the next frame and set up the following pair.
        const landed = nextIndex(index, direction);
        if (landed === index - direction) direction = -direction;
        index = landed;
        timer = 0;
        material.uniforms.blend.value = 0;
        material.uniforms.texA.value = textures[index];
        material.uniforms.texB.value = textures[nextIndex(index, direction)];
        return;
      }
      // Smoothstep so the fade eases in and out instead of sliding linearly.
      material.uniforms.blend.value = t * t * (3 - 2 * t);
    },
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
      textures.forEach((t) => t.dispose());
    },
  };
}

/** Build the frame URL list for a baked sequence. */
export function skyFrames(prefix, count) {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}.png`);
}
