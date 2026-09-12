// Bake an equirectangular sky PNG from the WebGPU backdrop shaders.
//
//   npm i --no-save vgpu pngjs
//   node tools/bake-backdrop.mjs [width] [yaw] [pitch] [outPath]
//
// BACKDROP_SHADER picks the scene (default black-hole-equirect.wgsl):
//   BACKDROP_SHADER=ember-world-equirect.wgsl \
//     node tools/bake-backdrop.mjs 2048 0 0 assets/ember-sky.png
//
// Needed because runtime WebGPU is not available everywhere — Chromium on Linux
// hands out no adapter when Vulkan is disabled, even though chrome://gpu
// reports "WebGPU: Hardware accelerated". A baked sky drops into THREE's
// scene.background and works on plain WebGL.
//
// On a machine with no usable GPU, `npx vgpu install-software-renderer` gets
// this rendering on CPU (a 2048x1024 bake takes about a second).

import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { init, effect, target, sampler } from "vgpu/node";

const DIR = new URL("../src/backdrop/", import.meta.url).pathname;
const read = (n) => readFileSync(`${DIR}/${n}`, "utf8");

const W = Number(process.argv[2] ?? 1024);
const H = W / 2;
const yaw = Number(process.argv[3] ?? 0.6);
const pitch = Number(process.argv[4] ?? 0.28);
const SHADER = process.env.BACKDROP_SHADER ?? "black-hole-equirect.wgsl";
const out = process.argv[5] ?? new URL("../assets/blackhole-sky.png", import.meta.url).pathname;

const BLURS = [
  { direction: [1, 0], radius: 1 }, { direction: [0, 1], radius: 1 },
  { direction: [1, 0], radius: 2.4 }, { direction: [0, 1], radius: 2.4 },
];

const t0 = Date.now();
const gpu = await init();
const samp = sampler(gpu, { minFilter: "linear", magFilter: "linear" });

const sceneT = target(gpu, { size: [W, H], format: "rgba16float" });
const bh = Math.min(360, H);
const bw = Math.max(1, Math.round(bh * W / H));
const bloom = [
  target(gpu, { size: [bw, bh], format: "rgba16float" }),
  target(gpu, { size: [bw, bh], format: "rgba16float" }),
];
const outT = target(gpu, { size: [W, H] });

const scene = effect(gpu, read(SHADER), {
  set: { params: { resolution: [W, H], pointer: [yaw, pitch], time: 4.0 } },
});
const bright = effect(gpu, read("bright-pass.wgsl"), { set: { samp, src: sceneT } });
const blurs = BLURS.map((blur, i) => effect(gpu, read("blur.wgsl"), {
  set: { samp, src: bloom[i % 2], blur: { ...blur, texelSize: bloom[i % 2].texelSize } },
}));
const composite = effect(gpu, read("composite.wgsl"), {
  set: { samp, scene: sceneT, bloom: bloom[0] },
});

scene.draw(sceneT);
bright.draw(bloom[0]);
blurs.forEach((b, i) => b.draw(bloom[(i + 1) % 2]));
composite.draw(outT);

const pixels = await outT.read();
const png = new PNG({ width: W, height: H });
png.data.set(pixels);
writeFileSync(out, PNG.sync.write(png));
console.log(`baked ${out} ${W}x${H} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
gpu.dispose();
