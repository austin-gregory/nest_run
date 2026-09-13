// Bake a sequence of equirect sky frames for the animated backdrop.
//
//   npm i --no-save vgpu pngjs
//   node tools/bake-frames.mjs <shader.wgsl> <outPrefix> [frames] [width] [dt] [yaw] [pitch]
//
// e.g.
//   node tools/bake-frames.mjs ember-world-equirect.wgsl assets/ember-sky 6 1536 25
//   node tools/bake-frames.mjs black-hole-equirect.wgsl assets/blackhole-sky 6 1536 8 0.6 0.22
//
// Writes <outPrefix>-0.png … <outPrefix>-N.png. src/skyCycle.js ping-pongs
// through them (…E F E D…) rather than looping, so there is no seam to pop:
// the sequences are turbulent flow and do not return to their start.
//
// Needs a WebGPU adapter. On a machine without one,
// `npx vgpu install-software-renderer` renders this on CPU.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import { init, effect, target, sampler } from "vgpu/node";

const SHADER_DIR = new URL("../src/backdrop/", import.meta.url).pathname;
const read = (n) => readFileSync(SHADER_DIR + n, "utf8");

const [shader, outPrefix] = process.argv.slice(2, 4);
if (!shader || !outPrefix) {
  console.error("usage: node tools/bake-frames.mjs <shader.wgsl> <outPrefix> [frames] [width] [dt] [yaw] [pitch]");
  process.exit(1);
}
const FRAMES = Number(process.argv[4] ?? 6);
const W = Number(process.argv[5] ?? 1536);
const H = W / 2;
const DT = Number(process.argv[6] ?? 20);
const yaw = Number(process.argv[7] ?? 0);
const pitch = Number(process.argv[8] ?? 0);

const BLURS = [
  { direction: [1, 0], radius: 1 }, { direction: [0, 1], radius: 1 },
  { direction: [1, 0], radius: 2.4 }, { direction: [0, 1], radius: 2.4 },
];

const gpu = await init();
const samp = sampler(gpu, { minFilter: "linear", magFilter: "linear" });

const sceneT = target(gpu, { size: [W, H], format: "rgba16float" });
const bh = Math.min(360, H);
const bw = Math.max(1, Math.round((bh * W) / H));
const bloom = [
  target(gpu, { size: [bw, bh], format: "rgba16float" }),
  target(gpu, { size: [bw, bh], format: "rgba16float" }),
];
const outT = target(gpu, { size: [W, H] });

const scene = effect(gpu, read(shader), {
  set: { params: { resolution: [W, H], pointer: [yaw, pitch], time: 0 } },
});
const bright = effect(gpu, read("bright-pass.wgsl"), { set: { samp, src: sceneT } });
const blurs = BLURS.map((blur, i) => effect(gpu, read("blur.wgsl"), {
  set: { samp, src: bloom[i % 2], blur: { ...blur, texelSize: bloom[i % 2].texelSize } },
}));
const composite = effect(gpu, read("composite.wgsl"), {
  set: { samp, scene: sceneT, bloom: bloom[0] },
});

mkdirSync(dirname(outPrefix), { recursive: true });

const started = Date.now();
for (let i = 0; i < FRAMES; i++) {
  scene.set({ params: { time: i * DT } });
  scene.draw(sceneT);
  bright.draw(bloom[0]);
  blurs.forEach((b, j) => b.draw(bloom[(j + 1) % 2]));
  composite.draw(outT);

  const pixels = await outT.read();
  const png = new PNG({ width: W, height: H });
  png.data.set(pixels);
  const path = `${outPrefix}-${i}.png`;
  writeFileSync(path, PNG.sync.write(png));
  console.log(`  frame ${i}  t=${i * DT}s  -> ${path}`);
}
console.log(`baked ${FRAMES} frames at ${W}x${H} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
gpu.dispose();
