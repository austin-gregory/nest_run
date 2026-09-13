// ── WebGPU sky backdrop ──────────────────────────────────────────────────────
// The game renders with THREE.WebGLRenderer, which cannot share a canvas or a
// context with WebGPU. So the backdrop gets its own canvas sitting *behind* the
// game canvas: the game clears to transparent and this shows through.
//
// That layering only works because these scenes are infinitely distant — they
// never need to depth-test against anything in the game world.
//
// Everything here is optional. No WebGPU, a failed CDN fetch, or a shader error
// leaves the game exactly as it was, still painting its own sky.

const VGPU_URL = "https://esm.sh/vgpu@0.4.1";

// Each scene is a chain of full-screen passes ending in a composite.
const SCENES = {
  blackhole: {
    shaders: {
      scene: "./src/backdrop/black-hole.wgsl",
      bright: "./src/backdrop/bright-pass.wgsl",
      blur: "./src/backdrop/blur.wgsl",
      composite: "./src/backdrop/composite.wgsl",
    },
    // Raymarching 256 steps per pixel is far too expensive at native
    // resolution next to a running game, and a distant backdrop does not need
    // the detail — render small and let the browser scale it up.
    scale: 0.5,
    maxDpr: 1,
  },
};

const BLURS = [
  { direction: [1, 0], radius: 1 },
  { direction: [0, 1], radius: 1 },
  { direction: [1, 0], radius: 2.4 },
  { direction: [0, 1], radius: 2.4 },
];

const CLEAR = [0, 0, 0, 1];

export function isBackdropSupported() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

/**
 * Mount a backdrop behind `gameCanvas`.
 *
 * Returns a handle immediately; `ready` resolves once it is actually drawing,
 * or resolves false if the backdrop could not start. `setView(yaw, pitch)`
 * points the backdrop camera, so the sky turns with the player.
 */
export function createBackdrop({ sceneName = "blackhole", gameCanvas, scale } = {}) {
  const config = SCENES[sceneName];
  let disposed = false;
  let gpu = null;
  let canvas = null;
  const view = { yaw: 0, pitch: 0.05 };

  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("resize", onResize);
    try { gpu?.dispose(); } catch { /* already torn down */ }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    gpu = null;
  }

  let onResize = () => {};

  async function start() {
    if (!config) {
      console.warn(`[backdrop] unknown scene "${sceneName}"`);
      return false;
    }
    if (!isBackdropSupported()) {
      console.info("[backdrop] WebGPU unavailable — keeping the built-in sky");
      return false;
    }

    // Own canvas, pinned behind everything else.
    canvas = document.createElement("canvas");
    canvas.id = "backdrop-canvas";
    canvas.style.cssText = [
      "position:fixed", "inset:0", "width:100%", "height:100%",
      "display:block", "z-index:0", "pointer-events:none", "background:#000",
    ].join(";");
    document.body.insertBefore(canvas, document.body.firstChild);

    // The page paints its own dark background, which would otherwise sit on top
    // of a z-index:-1 canvas. Clear it and stack the game canvas above instead.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    if (gameCanvas) {
      if (getComputedStyle(gameCanvas).position === "static") {
        gameCanvas.style.position = "relative";
      }
      gameCanvas.style.zIndex = "1";
    }

    const vgpu = await import(/* @vite-ignore */ VGPU_URL);
    if (disposed) return false;

    const sources = await loadShaders(config.shaders);
    if (disposed) return false;

    gpu = await vgpu.init();
    if (disposed) { gpu.dispose(); return false; }

    // The surface stays at 1x — a sub-1 dpr is not a valid range. Cost is cut
    // on the scene target instead, which is where the raymarch actually runs;
    // the composite pass upsamples it to the surface.
    const renderScale = scale != null ? scale : config.scale;
    const surface = vgpu.surface(gpu, canvas, { dpr: [1, 1] });
    const samp = vgpu.sampler(gpu, { minFilter: "linear", magFilter: "linear" });

    const effects = {
      scene: vgpu.effect(gpu, sources.scene, {
        set: { params: { pointer: [view.yaw, view.pitch], time: 0 } },
      }),
      bright: vgpu.effect(gpu, sources.bright, { set: { samp } }),
      blur: BLURS.map((blur) => vgpu.effect(gpu, sources.blur, { set: { samp, blur } })),
      composite: vgpu.effect(gpu, sources.composite, { set: { samp } }),
    };

    let targets = makeTargets(vgpu, gpu, surface.size, renderScale);
    bind(effects, targets);

    await Promise.all([
      effects.scene.compile(targets.scene),
      effects.bright.compile(targets.bloom[0]),
      ...effects.blur.map((b, i) => b.compile(targets.bloom[(i + 1) % 2])),
      effects.composite.compile({ colors: [surface.format] }),
    ]);
    if (disposed) return false;

    onResize = () => {
      if (disposed || !gpu) return;
      try {
        const next = makeTargets(vgpu, gpu, surface.size, renderScale);
        bind(effects, next);
        destroyTargets(targets);
        targets = next;
      } catch (err) {
        console.warn("[backdrop] resize failed", err);
      }
    };
    surface.onResize?.(onResize);
    window.addEventListener("resize", onResize);

    const gpuClock = vgpu.clock(gpu);
    vgpu.frameLoop(gpu, (frame) => {
      if (disposed) return;
      effects.scene.set({
        params: { pointer: [view.yaw, view.pitch], time: gpuClock.time },
      });
      frame.pass({ target: targets.scene, clear: CLEAR }, (p) => p.draw(effects.scene));
      frame.pass({ target: targets.bloom[0], clear: CLEAR }, (p) => p.draw(effects.bright));
      effects.blur.forEach((b, i) => {
        frame.pass({ target: targets.bloom[(i + 1) % 2], clear: CLEAR }, (p) => p.draw(b));
      });
      frame.pass({ target: surface, clear: CLEAR }, (p) => p.draw(effects.composite));
    });

    // Let the game's own sky stop painting over us.
    if (gameCanvas) gameCanvas.style.background = "transparent";
    console.info(`[backdrop] "${sceneName}" running at ${renderScale}x`);
    return true;
  }

  const ready = start().catch((err) => {
    console.warn("[backdrop] failed to start — keeping the built-in sky:", err);
    showFailureBadge(sceneName, err);
    dispose();
    return false;
  });

  return {
    ready,
    dispose,
    setView(yaw, pitch) { view.yaw = yaw; view.pitch = pitch; },
  };
}

// A silent fallback is indistinguishable from "the feature isn't wired up", so
// say so on screen. Dismissible, and never shown when the backdrop is running.
function showFailureBadge(sceneName, err) {
  try {
    if (document.getElementById("backdrop-error")) return;
    const el = document.createElement("div");
    el.id = "backdrop-error";
    el.style.cssText = [
      "position:fixed", "left:12px", "bottom:12px", "z-index:10000",
      "max-width:min(560px,90vw)", "padding:10px 14px",
      "background:rgba(40,0,0,.9)", "border:1px solid #a33", "border-radius:6px",
      "color:#ffb4b4", "font:12px/1.5 monospace", "cursor:pointer",
      "white-space:pre-wrap",
    ].join(";");
    el.textContent =
      `backdrop "${sceneName}" failed — using the built-in sky
` +
      `${err && err.message ? err.message : err}
(click to dismiss)`;
    el.addEventListener("click", () => el.remove());
    document.body.appendChild(el);
  } catch { /* nothing useful to do if even this fails */ }
}

async function loadShaders(paths) {
  const names = Object.keys(paths);
  const texts = await Promise.all(names.map(async (n) => {
    const res = await fetch(paths[n]);
    if (!res.ok) throw new Error(`shader ${paths[n]} -> HTTP ${res.status}`);
    return res.text();
  }));
  return Object.fromEntries(names.map((n, i) => [n, texts[i]]));
}

function makeTargets(vgpu, gpu, size, renderScale = 1) {
  // The raymarch runs here, so this is what gets scaled down.
  const sceneSize = [
    Math.max(1, Math.round(size[0] * renderScale)),
    Math.max(1, Math.round(size[1] * renderScale)),
  ];
  // Bloom runs at a fixed small height regardless of window size.
  const height = Math.min(360, sceneSize[1]);
  const bloomSize = [Math.max(1, Math.round((height * sceneSize[0]) / sceneSize[1])), height];
  return {
    scene: vgpu.target(gpu, { size: sceneSize, format: "rgba16float" }),
    bloom: [
      vgpu.target(gpu, { size: bloomSize, format: "rgba16float" }),
      vgpu.target(gpu, { size: bloomSize, format: "rgba16float" }),
    ],
  };
}

function bind(effects, targets) {
  effects.scene.set({ params: { resolution: targets.scene.size } });
  effects.bright.set({ src: targets.scene });
  effects.blur.forEach((b, i) => b.set({
    src: targets.bloom[i % 2],
    blur: { texelSize: targets.bloom[i % 2].texelSize },
  }));
  effects.composite.set({ scene: targets.scene, bloom: targets.bloom[0] });
}

function destroyTargets(targets) {
  targets.bloom[1]?.destroy?.();
  targets.bloom[0]?.destroy?.();
  targets.scene?.destroy?.();
}
