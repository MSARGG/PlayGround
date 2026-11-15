import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* =========================================================================
   WHISPERWILD — THE LOST LIGHT
   A stylised third-person adventure. Terrain, water, sky, foliage,
   creatures, the character rig and its cloth are all procedural.
   ========================================================================= */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
const approach = (v, target, step) => v < target ? Math.min(v + step, target) : Math.max(v - step, target);
const angleDelta = (a, b) => ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
const dampAngle = (a, b, rate, dt) => a + angleDelta(a, b) * (1 - Math.exp(-rate * dt));

/* ---------- deterministic noise ---------- */
let rngState = 20240711;
function rnd() { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 4294967296; }
function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 4) {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { sum += amp * vnoise(x * f, y * f); f *= 2.03; amp *= 0.5; }
  return sum;
}

/* ---------- DOM ---------- */
const canvas = document.querySelector('#scene');
const mapCanvas = document.querySelector('#map');
const mapCtx = mapCanvas.getContext('2d');
const heartsEl = document.querySelector('#hearts');
const shardsEl = document.querySelector('#shards');
const questEl = document.querySelector('#quest');
const toastEl = document.querySelector('#toast');
const hintEl = document.querySelector('#hint');
const staminaEl = document.querySelector('.stamina');
const staminaFill = document.querySelector('#staminaFill');
const flashEl = document.querySelector('#damageFlash');
const loadingEl = document.querySelector('#loading');

/* ---------- renderer ---------- */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.03;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#a9d8d1');
scene.fog = new THREE.Fog('#c7e3dc', 72, 245);

const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 420);
camera.position.set(0, 18, 42);

const SUN_DIR = new THREE.Vector3(-0.38, 0.46, -0.8).normalize();

/* ---------- sky dome ---------- */
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uSun: { value: SUN_DIR }, uTime: { value: 0 }, uFog: { value: new THREE.Color('#cfe8e1') } },
  vertexShader: `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 uSun; uniform float uTime; uniform vec3 uFog;
    varying vec3 vDir;
    float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
    float fbm2(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<4;i++){ s+=a*n2(p); p*=2.03; a*=0.5; } return s; }
    void main(){
      vec3 d = normalize(vDir);
      float h = max(d.y, 0.0);
      vec3 horizon = uFog;
      vec3 mid = vec3(0.60, 0.82, 0.85);
      vec3 zenith = vec3(0.22, 0.49, 0.68);
      vec3 col = mix(horizon, mid, smoothstep(0.0, 0.28, h));
      col = mix(col, zenith, smoothstep(0.18, 0.92, h));
      float sun = max(dot(d, uSun), 0.0);
      col += vec3(1.0, 0.86, 0.61) * pow(sun, 9.0) * 0.42;
      col += vec3(1.0, 0.94, 0.78) * pow(sun, 320.0) * 2.4;
      // soft cloud banks, projected on a high plane
      if (d.y > 0.015) {
        vec2 uv = d.xz / (d.y + 0.22) * 0.85 + vec2(uTime * 0.004, uTime * 0.0015);
        float c = fbm2(uv * 1.15);
        float cloud = smoothstep(0.52, 0.72, c) * smoothstep(0.0, 0.16, d.y);
        vec3 cloudCol = mix(vec3(0.93, 0.95, 0.92), vec3(1.0, 0.95, 0.84), pow(sun, 3.0));
        col = mix(col, cloudCol, cloud * 0.72);
      }
      gl_FragColor = vec4(col, 1.0);
    }`
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(340, 40, 24), skyMat);
sky.frustumCulled = false;
scene.add(sky);

/* ---------- lights ---------- */
scene.add(new THREE.HemisphereLight('#e4f4ff', '#465b39', 1.0));
const fill = new THREE.DirectionalLight('#bcd8ff', 0.5);
fill.position.set(30, 24, 24);
scene.add(fill);

const sun = new THREE.DirectionalLight('#ffe2ac', 3.35);
sun.position.copy(SUN_DIR).multiplyScalar(80);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -36; sun.shadow.camera.right = 36;
sun.shadow.camera.top = 36; sun.shadow.camera.bottom = -36;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 190;
sun.shadow.bias = -0.00035; sun.shadow.normalBias = 0.04;
sun.shadow.radius = 2.4;
scene.add(sun);
scene.add(sun.target);

/* ---------- procedural texture helpers ---------- */
function radialTexture(inner = 'rgba(255,244,203,1)', mid = 'rgba(255,206,120,0.55)', outer = 'rgba(255,190,90,0)') {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  grd.addColorStop(0, inner); grd.addColorStop(0.32, mid); grd.addColorStop(1, outer);
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const glowTex = radialTexture();
const softTex = radialTexture('rgba(255,255,255,.95)', 'rgba(255,255,255,.4)', 'rgba(255,255,255,0)');
function cloudTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  for (let i = 0; i < 18; i++) {
    const x = 40 + rnd() * 176, y = 56 + (rnd() - 0.5) * 34, r = 16 + rnd() * 30;
    const grd = g.createRadialGradient(x, y, 1, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,.92)');
    grd.addColorStop(0.55, 'rgba(250,253,247,.5)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const cloudTex = cloudTexture();

function groundTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1000; i++) {
    const x = rnd() * 256, y = rnd() * 256, r = 2 + rnd() * 15;
    const v = 195 + (rnd() * 60 | 0);
    g.fillStyle = `rgba(${v},${v},${v},${0.05 + rnd() * 0.1})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * 256, y = rnd() * 256, len = 1 + rnd() * 3.4;
    const v = 175 + (rnd() * 75 | 0);
    g.strokeStyle = `rgba(${v - 25},${v},${v - 30},${0.08 + rnd() * 0.14})`;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + rnd() * 1.6 - 0.8, y - len); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 24);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/* ---------- island height field ---------- */
const WORLD = 180;
const HALF = WORLD / 2;
function islandMask(r) { return 1 - smoothstep(40, 71, r); }

function heightAt(x, z) {
  const r = Math.hypot(x, z);
  const m = islandMask(r);
  const n1 = fbm(x * 0.042 + 11.3, z * 0.042 - 4.7);
  const n2 = fbm(x * 0.125 - 2.2, z * 0.125 + 7.9);
  let h = -4.6 + 9.1 * m + (n1 - 0.5) * 5.2 * m + (n2 - 0.5) * 1.15 * m;
  // gentle clearing around the spawn
  const clearing = 1 - smoothstep(7, 18, r);
  h = lerp(h, 2.15 + (n2 - 0.5) * 0.35, clearing * 0.72);
  // flat plateau for the shrine
  const ds = Math.hypot(x - 24, z + 18);
  h = lerp(h, 2.9, (1 - smoothstep(4.5, 9.5, ds)) * 0.92);
  return h;
}


const TRAIL = [
  new THREE.Vector2(0, 2), new THREE.Vector2(-2, -4), new THREE.Vector2(-6, -10),
  new THREE.Vector2(-2, -17), new THREE.Vector2(8, -22), new THREE.Vector2(17, -24), new THREE.Vector2(23, -19)
];
function trailDistance(x, z) {
  let best = 1e9;
  for (let i = 0; i < TRAIL.length - 1; i++) {
    const a = TRAIL[i], b = TRAIL[i + 1];
    const vx = b.x - a.x, vz = b.y - a.y;
    const wx = x - a.x, wz = z - a.y;
    const t = clamp((wx * vx + wz * vz) / (vx * vx + vz * vz || 1), 0, 1);
    const dx = x - (a.x + vx * t), dz = z - (a.y + vz * t);
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const NORMAL_EPS = 0.55;
function normalAt(x, z) {
  const hL = heightAt(x - NORMAL_EPS, z), hR = heightAt(x + NORMAL_EPS, z);
  const hD = heightAt(x, z - NORMAL_EPS), hU = heightAt(x, z + NORMAL_EPS);
  return new THREE.Vector3(hL - hR, 2 * NORMAL_EPS, hD - hU).normalize();
}

/* ---------- terrain mesh ---------- */
function buildTerrain() {
  const SEG = 172, size = WORLD;
  const n = SEG + 1;
  const heights = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = (ix / SEG - 0.5) * size, z = (iz / SEG - 0.5) * size;
      heights[iz * n + ix] = heightAt(x, z);
    }
  }
  const pos = new Float32Array(n * n * 3);
  const col = new Float32Array(n * n * 3);
  const idx = [];
  const cSand = new THREE.Color('#ddcfa0'), cWet = new THREE.Color('#b5a982');
  const cDeep = new THREE.Color('#3e7671'), cGrass = new THREE.Color('#6ea55d');
  const cGrass2 = new THREE.Color('#538a4b'), cGrass3 = new THREE.Color('#8fbe71');
  const cRock = new THREE.Color('#899484'), cHigh = new THREE.Color('#a6b878');
  const tmp = new THREE.Color();
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      const x = (ix / SEG - 0.5) * size, z = (iz / SEG - 0.5) * size;
      const h = heights[i];
      pos[i * 3] = x; pos[i * 3 + 1] = h; pos[i * 3 + 2] = z;
      const hx = heights[iz * n + Math.min(SEG, ix + 1)] - heights[iz * n + Math.max(0, ix - 1)];
      const hz = heights[Math.min(SEG, iz + 1) * n + ix] - heights[Math.max(0, iz - 1) * n + ix];
      const grad = Math.hypot(hx, hz) / (2 * size / SEG);
      const ny = 1 / Math.sqrt(1 + grad * grad);
      if (h < -0.15) {
        tmp.copy(cDeep).lerp(cWet, clamp((h + 2.4) / 2.3, 0, 1));
      } else if (h < 0.85) {
        tmp.copy(cWet).lerp(cSand, smoothstep(-0.15, 0.6, h));
      } else {
        const patch = fbm(x * 0.09 + 3.1, z * 0.09 - 5.2);
        tmp.copy(cGrass).lerp(cGrass3, smoothstep(0.35, 0.75, patch));
        tmp.lerp(cGrass2, smoothstep(0.6, 0.25, patch) * 0.6);
        tmp.lerp(cRock, smoothstep(0.42, 0.9, 1 - ny) * 0.85);
        tmp.lerp(cHigh, smoothstep(3.6, 5.4, h) * 0.5);
      }
      const td = trailDistance(x, z);
      if (td < 2.2 && h > 0.3) {
        const wear = 1 - smoothstep(0.5, 2.2, td);
        tmp.lerp(new THREE.Color('#c3ad7c'), wear * 0.72);
        tmp.lerp(new THREE.Color('#ab946a'), (1 - smoothstep(0.2, 0.8, td)) * 0.3);
      }
      const tint = 0.9 + hash2(ix * 1.7, iz * 2.3) * 0.16;
      col[i * 3] = tmp.r * tint; col[i * 3 + 1] = tmp.g * tint; col[i * 3 + 2] = tmp.b * tint;
      if (ix < SEG && iz < SEG) {
        const a = i, b = i + 1, c = i + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: groundTexture(), roughness: 0.96, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return heights;
}
const terrainHeights = buildTerrain();

/* ---------- water ---------- */
const HT = 256;
const heightData = new Uint8Array(HT * HT * 4);
for (let iz = 0; iz < HT; iz++) {
  for (let ix = 0; ix < HT; ix++) {
    const x = (ix / (HT - 1) - 0.5) * WORLD, z = (iz / (HT - 1) - 0.5) * WORLD;
    const v = clamp((heightAt(x, z) + 5.5) / 12, 0, 1);
    const o = (iz * HT + ix) * 4;
    heightData[o] = Math.round(v * 255); heightData[o + 1] = 0; heightData[o + 2] = 0; heightData[o + 3] = 255;
  }
}
const heightTex = new THREE.DataTexture(heightData, HT, HT, THREE.RGBAFormat);
heightTex.minFilter = THREE.LinearFilter; heightTex.magFilter = THREE.LinearFilter;
heightTex.needsUpdate = true;

const waterUniforms = {
  uTime: { value: 0 },
  uSun: { value: SUN_DIR },
  uHeight: { value: heightTex },
  uFog: { value: new THREE.Color('#c7e3dc') },
  uCam: { value: new THREE.Vector3() }
};
const waterMat = new THREE.ShaderMaterial({
  uniforms: waterUniforms,
  transparent: true,
  vertexShader: `
    uniform float uTime;
    varying vec3 vWorld;
    void main(){
      vec3 p = position;
      float w = sin(p.x * 0.23 + uTime * 0.9) * 0.075
              + sin(p.z * 0.31 - uTime * 0.72) * 0.055
              + sin((p.x + p.z) * 0.15 + uTime * 1.35) * 0.04;
      p.y += w;
      vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
    }`,
  fragmentShader: `
    uniform float uTime; uniform vec3 uSun; uniform sampler2D uHeight;
    uniform vec3 uFog; uniform vec3 uCam;
    varying vec3 vWorld;
    float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main(){
      vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
      if (N.y < 0.0) N = -N;
      vec3 V = normalize(uCam - vWorld);
      float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
      vec2 uv = (vWorld.xz + 90.0) / 180.0;
      float terrainY = texture2D(uHeight, clamp(uv, 0.001, 0.999)).r * 12.0 - 5.5;
      float depth = max(-terrainY, 0.0);
      vec3 deep = vec3(0.10, 0.34, 0.38);
      vec3 shallow = vec3(0.36, 0.74, 0.68);
      vec3 skyCol = vec3(0.72, 0.90, 0.92);
      vec3 col = mix(deep, shallow, smoothstep(0.0, 2.2, depth));
      col = mix(col, skyCol, fres * 0.58);
      float spec = pow(max(dot(reflect(-uSun, N), V), 0.0), 110.0);
      col += vec3(1.0, 0.93, 0.76) * spec * 1.5;
      // shoreline foam + ripples
      float ripple = sin(depth * 26.0 - uTime * 2.2 + vWorld.x * 0.9) * 0.5 + 0.5;
      float foam = (1.0 - smoothstep(0.0, 0.75, depth)) * (0.45 + 0.55 * ripple);
      foam += smoothstep(0.72, 0.94, hash21(floor(vWorld.xz * 5.0 + uTime * 1.5))) * 0.12 * (1.0 - smoothstep(0.0, 3.0, depth));
      col = mix(col, vec3(0.94, 0.98, 0.95), clamp(foam, 0.0, 1.0) * 0.72);
      float glint = pow(hash21(floor(vWorld.xz * 12.0) + floor(uTime * 2.0)), 18.0);
      col += vec3(1.0, 0.96, 0.82) * glint * 0.22;
      float dist = length(uCam - vWorld);
      float fogF = smoothstep(95.0, 265.0, dist);
      col = mix(col, uFog, fogF);
      float alpha = mix(0.5, 0.94, smoothstep(0.0, 1.6, depth));
      alpha = mix(alpha, 1.0, fogF);
      gl_FragColor = vec4(col, alpha);
    }`
});
const waterGeo = new THREE.PlaneGeometry(560, 560, 110, 110);
waterGeo.rotateX(-Math.PI / 2);
const water = new THREE.Mesh(waterGeo, waterMat);
water.position.y = 0;
water.renderOrder = 1;
scene.add(water);

/* ---------- sun glow + clouds ---------- */
const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: '#ffe7b0', transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
sunSprite.position.copy(SUN_DIR).multiplyScalar(300);
sunSprite.scale.setScalar(95);
scene.add(sunSprite);

const clouds = [];
const cloudMat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.82, depthWrite: false, fog: true });
for (let i = 0; i < 13; i++) {
  const s = new THREE.Sprite(cloudMat);
  const a = rnd() * Math.PI * 2, r = 70 + rnd() * 150;
  s.position.set(Math.cos(a) * r, 40 + rnd() * 34, Math.sin(a) * r);
  const w = 55 + rnd() * 70;
  s.scale.set(w, w * 0.46, 1);
  s.material = cloudMat;
  scene.add(s);
  clouds.push({ s, speed: 0.5 + rnd() * 0.7 });
}

/* ---------- offshore islets & sea stacks ---------- */
{
  const ridgeGeo = new THREE.ConeGeometry(1, 1, 5, 1);
  ridgeGeo.translate(0, 0.5, 0);
  const ridgeMat = new THREE.MeshBasicMaterial({ color: '#ffffff', fog: true });
  const count = 46;
  const islets = new THREE.InstancedMesh(ridgeGeo, ridgeMat, count);
  const dummy = new THREE.Object3D();
  const palette = ['#5f837a', '#6b8f83', '#75998b', '#587c74', '#83a496'].map(c => new THREE.Color(c));
  for (let i = 0; i < count; i++) {
    const a = i / count * Math.PI * 2 + (rnd() - 0.5) * 0.16;
    const r = 76 + rnd() * 46;
    const h = 2.4 + rnd() * 6.5, w = 7 + rnd() * 15;
    dummy.position.set(Math.cos(a) * r, -1.9, Math.sin(a) * r);
    dummy.rotation.set(0, rnd() * Math.PI, 0);
    dummy.scale.set(w, h, w);
    dummy.updateMatrix();
    islets.setMatrixAt(i, dummy.matrix);
    islets.setColorAt(i, palette[(rnd() * palette.length) | 0]);
  }
  islets.castShadow = false; islets.receiveShadow = false;
  scene.add(islets);
}

/* ---------- grass tufts (single instanced draw call, wind in shader) ---------- */
const grassUniforms = { uTime: { value: 0 } };
{
  const bladeGeo = (h, w, bend, rot) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -w / 2, 0, 0, w / 2, 0, 0, bend, h, 0
    ]), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
      0, 1, 0, 0, 1, 0, 0, 1, 0
    ]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
    g.rotateY(rot);
    return g;
  };
  const tuft = mergeGeometries([
    bladeGeo(0.54, 0.095, 0.09, 0), bladeGeo(0.42, 0.075, -0.11, 1.7),
    bladeGeo(0.48, 0.085, 0.06, 3.35), bladeGeo(0.34, 0.065, -0.08, 5.05)
  ]);
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = grassUniforms.uTime;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      '#include <normal_fragment_begin>\n normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);'
    );
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       float sway = sin(uTime * 1.7 + instanceMatrix[3].x * 0.42 + instanceMatrix[3].z * 0.31);
       transformed.x += sway * 0.1 * max(position.y, 0.0);
       transformed.z += sway * 0.055 * max(position.y, 0.0);`
    );
  };
  const MAX = 12000;
  const mesh = new THREE.InstancedMesh(tuft, mat, MAX);
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const dummy = new THREE.Object3D();
  const palette = ['#4d7a3b', '#578747', '#62904d', '#6d9a55', '#79a35e', '#416a32', '#5c8c48'].map(c => new THREE.Color(c));
  let n = 0;
  for (let i = 0; i < 90000 && n < MAX; i++) {
    const a = rnd() * Math.PI * 2, r = 2.5 + Math.sqrt(rnd()) * 61;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < 0.35) continue;
    if (Math.hypot(x - 24, z + 18) < 6) continue;
    if (trailDistance(x, z) < 2.25) continue;
    dummy.position.set(x, y - 0.02, z);
    dummy.rotation.set(0, rnd() * Math.PI, 0);
    const sc = 0.38 + rnd() * 0.78;
    dummy.scale.set(sc, sc * (0.8 + rnd() * 0.5), sc);
    dummy.updateMatrix();
    mesh.setMatrixAt(n, dummy.matrix);
    mesh.setColorAt(n, palette[(rnd() * palette.length) | 0]);
    n++;
  }
  mesh.count = n;
  mesh.castShadow = false; mesh.receiveShadow = false;
  scene.add(mesh);
}

/* low bushes, scattered through the undergrowth */
{
  const parts = [];
  const blobs = [[0, 0.34, 0, 0.55], [0.42, 0.24, 0.12, 0.4], [-0.35, 0.22, -0.15, 0.38], [0.05, 0.2, 0.42, 0.34]];
  for (const [x, y, z, r] of blobs) {
    const g = new THREE.DodecahedronGeometry(r, 0);
    g.translate(x, y, z);
    parts.push(g);
  }
  const geo = mergeGeometries(parts);
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.96, flatShading: true });
  const MAX = 130;
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  const dummy = new THREE.Object3D();
  const palette = ['#4d8250', '#578f56', '#63985d', '#427347', '#6ea265'].map(c => new THREE.Color(c));
  let n = 0;
  for (let i = 0; i < 900 && n < MAX; i++) {
    const a = rnd() * Math.PI * 2, r = 10 + Math.sqrt(rnd()) * 52;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < 0.7) continue;
    if (Math.hypot(x, z) < 8) continue;
    if (Math.hypot(x - 24, z + 18) < 8) continue;
    if (trailDistance(x, z) < 2.8) continue;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
    dummy.scale.setScalar(0.7 + rnd() * 1.1);
    dummy.updateMatrix();
    mesh.setMatrixAt(n, dummy.matrix);
    mesh.setColorAt(n, palette[(rnd() * palette.length) | 0]);
    n++;
  }
  mesh.count = n;
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
}
/* ---------- trees, rocks, flowers, mushrooms ---------- */
const colliders = [];
const colliderGrid = new Map();
const CELL = 7;
function addCollider(x, z, r) {
  const c = { x, z, r };
  colliders.push(c);
  const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  if (!colliderGrid.has(key)) colliderGrid.set(key, []);
  colliderGrid.get(key).push(c);
}

function trunkGeometry() {
  const trunk = new THREE.CylinderGeometry(0.115, 0.21, 2.1, 7, 1);
  trunk.translate(0, 1.05, 0);
  const root = new THREE.ConeGeometry(0.32, 0.42, 7);
  root.translate(0, 0.16, 0);
  return mergeGeometries([trunk, root]);
}
function crownGeometry() {
  const parts = [];
  const blobs = [
    [0, 2.6, 0, 0.95], [0.55, 2.25, 0.28, 0.65], [-0.5, 2.35, -0.2, 0.72],
    [0.08, 3.02, -0.12, 0.6], [-0.22, 2.62, 0.58, 0.55], [0.4, 2.9, 0.45, 0.44]
  ];
  for (const [x, y, z, r] of blobs) {
    const g = new THREE.DodecahedronGeometry(r, 0);
    g.translate(x, y, z);
    parts.push(g);
  }
  return mergeGeometries(parts);
}
function pineGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.1, 0.17, 1.6, 6);
  trunk.translate(0, 0.8, 0);
  parts.push(trunk);
  const tiers = [[1.25, 1.15, 1.15], [2.15, 0.92, 1.2], [2.95, 0.66, 1.05], [3.55, 0.4, 0.8]];
  for (const [y, r, h] of tiers) {
    const cone = new THREE.ConeGeometry(r, h, 7);
    cone.translate(0, y + h * 0.36, 0);
    parts.push(cone);
  }
  return mergeGeometries(parts);
}

const treeSpots = [];
{
  const dummy = new THREE.Object3D();
  const deciduous = [];
  const pines = [];
  for (let i = 0; i < 900; i++) {
    const a = rnd() * Math.PI * 2, r = 11 + Math.sqrt(rnd()) * 55;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < 0.75) continue;
    const slope = 1 - normalAt(x, z).y;
    if (slope > 0.34) continue;
    if (Math.hypot(x, z) < 10) continue;
    if (Math.hypot(x - 24, z + 18) < 10) continue;
    if (trailDistance(x, z) < 3.2) continue;
    let tooClose = false;
    for (const t of treeSpots) { if (Math.hypot(t.x - x, t.z - z) < 4.4) { tooClose = true; break; } }
    if (tooClose) continue;
    const scale = 0.62 + rnd() * 0.62;
    const isPine = rnd() < 0.3;
    treeSpots.push({ x, z, y, scale, pine: isPine });
    (isPine ? pines : deciduous).push({ x, z, y, scale });
    addCollider(x, z, 0.36 * scale + 0.18);
    if (treeSpots.length > 175) break;
  }
  const trunkMat = new THREE.MeshStandardMaterial({ color: '#7a563c', roughness: 1, flatShading: true });
  const crownMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.94, flatShading: true });
  const pineMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true });
  const trunkGeo = trunkGeometry(), crownGeo = crownGeometry(), pineGeo = pineGeometry();
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, deciduous.length + pines.length);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, deciduous.length);
  const pinesMesh = new THREE.InstancedMesh(pineGeo, pineMat, pines.length);
  const leafPalette = ['#3f7a52', '#4d8a58', '#5b9662', '#346c4b', '#689c61', '#79a869'].map(c => new THREE.Color(c));
  const pinePalette = ['#2f6049', '#3a6f50', '#447a55', '#2a5a45'].map(c => new THREE.Color(c));
  const barkPalette = ['#8a6244', '#7a563c', '#94704f'].map(c => new THREE.Color(c));
  let ti = 0, ci = 0, pi = 0;
  for (const t of deciduous) {
    dummy.position.set(t.x, t.y - 0.05, t.z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
    dummy.scale.setScalar(t.scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(ti, dummy.matrix);
    trunks.setColorAt(ti, barkPalette[(rnd() * barkPalette.length) | 0]);
    ti++;
    dummy.position.set(t.x, t.y - 0.05, t.z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
    dummy.scale.set(t.scale * (0.9 + rnd() * 0.25), t.scale * (0.9 + rnd() * 0.3), t.scale * (0.9 + rnd() * 0.25));
    dummy.updateMatrix();
    crowns.setMatrixAt(ci, dummy.matrix);
    crowns.setColorAt(ci, leafPalette[(rnd() * leafPalette.length) | 0]);
    ci++;
  }
  for (const t of pines) {
    dummy.position.set(t.x, t.y - 0.05, t.z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
    dummy.scale.setScalar(t.scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(ti, dummy.matrix);
    trunks.setColorAt(ti, barkPalette[(rnd() * barkPalette.length) | 0]);
    ti++;
    dummy.position.set(t.x, t.y - 0.05, t.z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
    dummy.scale.set(t.scale * (0.85 + rnd() * 0.2), t.scale * (0.95 + rnd() * 0.25), t.scale * (0.85 + rnd() * 0.2));
    dummy.updateMatrix();
    pinesMesh.setMatrixAt(pi, dummy.matrix);
    pinesMesh.setColorAt(pi, pinePalette[(rnd() * pinePalette.length) | 0]);
    pi++;
  }
  for (const m of [trunks, crowns, pinesMesh]) {
    m.castShadow = true; m.receiveShadow = true;
    m.instanceMatrix.needsUpdate = true;
    scene.add(m);
  }
}

/* rocks */
{
  const geo = new THREE.DodecahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.98, flatShading: true });
  const MAX = 90;
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  const dummy = new THREE.Object3D();
  const palette = ['#8e9687', '#7f887c', '#9aa192', '#6f7a70', '#a3a795'].map(c => new THREE.Color(c));
  let n = 0;
  for (let i = 0; i < 500 && n < MAX; i++) {
    const a = rnd() * Math.PI * 2, r = 8 + Math.sqrt(rnd()) * 58;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < 0.2) continue;
    if (Math.hypot(x - 24, z + 18) < 8.5) continue;
    if (Math.hypot(x, z) < 7) continue;
    if (trailDistance(x, z) < 2.4) continue;
    const s = 0.3 + rnd() * 0.85;
    dummy.position.set(x, y + s * 0.3, z);
    dummy.rotation.set(rnd() * 0.6, rnd() * Math.PI * 2, rnd() * 0.4);
    dummy.scale.set(s * (1.1 + rnd() * 0.5), s * (0.7 + rnd() * 0.4), s * (0.95 + rnd() * 0.4));
    dummy.updateMatrix();
    mesh.setMatrixAt(n, dummy.matrix);
    mesh.setColorAt(n, palette[(rnd() * palette.length) | 0]);
    if (s > 0.6) addCollider(x, z, s * 0.85);
    n++;
  }
  mesh.count = n;
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
}

/* flowers */
{
  const stemGeo = new THREE.CylinderGeometry(0.015, 0.02, 0.32, 4);
  stemGeo.translate(0, 0.16, 0);
  const bloomGeo = new THREE.IcosahedronGeometry(0.105, 0);
  bloomGeo.scale(1, 0.7, 1);
  bloomGeo.translate(0, 0.35, 0);
  const stemMat = new THREE.MeshStandardMaterial({ color: '#4d7d47', roughness: 1 });
  const bloomMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8, emissive: '#3a2a1a', emissiveIntensity: 0.15, flatShading: true });
  const MAX = 540;
  const stems = new THREE.InstancedMesh(stemGeo, stemMat, MAX);
  const blooms = new THREE.InstancedMesh(bloomGeo, bloomMat, MAX);
  const dummy = new THREE.Object3D();
  const palette = ['#f4dfa3', '#f3b3ac', '#d6c6f2', '#f8f2dc', '#ffd08a', '#eaa6c7'].map(c => new THREE.Color(c));
  let n = 0;
  for (let i = 0; i < 4200 && n < MAX; i++) {
    const a = rnd() * Math.PI * 2, r = 4 + Math.sqrt(rnd()) * 58;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < 0.5) continue;
    if (Math.hypot(x - 24, z + 18) < 5.5) continue;
    if (trailDistance(x, z) < 2.1) continue;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
    const s = 0.75 + rnd() * 0.8;
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    stems.setMatrixAt(n, dummy.matrix);
    blooms.setMatrixAt(n, dummy.matrix);
    blooms.setColorAt(n, palette[(rnd() * palette.length) | 0]);
    n++;
  }
  stems.count = n; blooms.count = n;
  scene.add(stems); scene.add(blooms);
}

/* glowing mushrooms */
{
  const stemGeo = new THREE.CylinderGeometry(0.035, 0.05, 0.3, 5);
  stemGeo.translate(0, 0.15, 0);
  const capGeo = new THREE.SphereGeometry(0.13, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.6);
  capGeo.scale(1, 0.7, 1); capGeo.translate(0, 0.3, 0);
  const stemMat = new THREE.MeshStandardMaterial({ color: '#e8dcc2', roughness: 0.9 });
  const capMat = new THREE.MeshStandardMaterial({ color: '#bfe9e2', emissive: '#4fd0c0', emissiveIntensity: 1.25, roughness: 0.5 });
  const MAX = 150;
  const stems = new THREE.InstancedMesh(stemGeo, stemMat, MAX);
  const caps = new THREE.InstancedMesh(capGeo, capMat, MAX);
  const dummy = new THREE.Object3D();
  let n = 0;
  for (let i = 0; i < 700 && n < MAX; i++) {
    const a = rnd() * Math.PI * 2, r = 7 + Math.sqrt(rnd()) * 54;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < 0.6) continue;
    if (Math.hypot(x - 24, z + 18) < 7) continue;
    dummy.position.set(x, y, z);
    dummy.rotation.set((rnd() - 0.5) * 0.2, rnd() * Math.PI, (rnd() - 0.5) * 0.2);
    const s = 0.7 + rnd() * 1.1;
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    stems.setMatrixAt(n, dummy.matrix);
    caps.setMatrixAt(n, dummy.matrix);
    n++;
  }
  stems.count = n; caps.count = n;
  scene.add(stems); scene.add(caps);
}

/* ---------- the Sunshard Shrine ---------- */
const SHRINE = new THREE.Vector3(24, heightAt(24, -18), -18);
const shrine = new THREE.Group();
shrine.position.copy(SHRINE);
scene.add(shrine);
const shrineGlowMats = [];
let shrineBeam, shrineCore, shrineRingA, shrineRingB, shrineLight, shrineOrbitals = [];
{
  const stone = new THREE.MeshStandardMaterial({ color: '#a6a087', roughness: 0.92, flatShading: true });
  const stoneLight = new THREE.MeshStandardMaterial({ color: '#c4b795', roughness: 0.9, flatShading: true });
  const goldMat = new THREE.MeshStandardMaterial({ color: '#f2d391', roughness: 0.35, metalness: 0.35, emissive: '#704d18', emissiveIntensity: 0.5 });

  const step = new THREE.Mesh(new THREE.CylinderGeometry(6.4, 6.8, 0.28, 18), stone);
  step.position.y = 0.14; step.receiveShadow = true; step.castShadow = true; shrine.add(step);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(4.75, 5.05, 0.5, 14), stoneLight);
  base.position.y = 0.5; base.receiveShadow = true; base.castShadow = true; shrine.add(base);
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.15, 0.22, 14), stone);
  inner.position.y = 0.82; inner.receiveShadow = true; shrine.add(inner);

  for (let i = 0; i < 7; i++) {
    const a = i / 7 * Math.PI * 2;
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.6, 0.56), stone);
    pillar.position.set(Math.cos(a) * 3.9, 2.05, Math.sin(a) * 3.9);
    pillar.rotation.y = -a;
    pillar.castShadow = true; pillar.receiveShadow = true;
    shrine.add(pillar);
    addCollider(SHRINE.x + Math.cos(a) * 3.9, SHRINE.z + Math.sin(a) * 3.9, 0.62);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.2, 0.78), stoneLight);
    cap.position.set(Math.cos(a) * 3.9, 3.44, Math.sin(a) * 3.9);
    cap.rotation.y = -a; cap.castShadow = true;
    shrine.add(cap);
    const rune = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.0, 0.05), goldMat.clone());
    rune.material.emissiveIntensity = 0.9;
    rune.position.set(Math.cos(a) * 3.62, 2.0, Math.sin(a) * 3.62);
    rune.rotation.y = -a + Math.PI * 0.5;
    shrine.add(rune);
    shrineGlowMats.push(rune.material);
  }

  const floorRing = new THREE.Mesh(new THREE.RingGeometry(2.35, 2.9, 48), new THREE.MeshStandardMaterial({ color: '#e9c97f', emissive: '#c58c34', emissiveIntensity: 0.7, roughness: 0.5, side: THREE.DoubleSide }));
  floorRing.rotation.x = -Math.PI / 2; floorRing.position.y = 0.95;
  shrine.add(floorRing); shrineGlowMats.push(floorRing.material);

  shrineCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.56, 1), new THREE.MeshStandardMaterial({ color: '#fff5cd', emissive: '#ffc866', emissiveIntensity: 2.2, roughness: 0.25, metalness: 0.1 }));
  shrineCore.position.y = 3.0; shrineCore.castShadow = true;
  shrine.add(shrineCore);
  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: '#ffd47e', transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
  coreGlow.scale.setScalar(4.2); coreGlow.position.y = 3.0; shrine.add(coreGlow);
  shrineGlowMats.push(shrineCore.material);

  const ringMat = new THREE.MeshStandardMaterial({ color: '#ffe6a6', emissive: '#ffb64d', emissiveIntensity: 1.8, roughness: 0.3, metalness: 0.2 });
  shrineRingA = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.075, 8, 40), ringMat);
  shrineRingA.position.y = 3.0; shrineRingA.rotation.x = 0.6; shrine.add(shrineRingA);
  shrineRingB = new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.05, 8, 44), ringMat.clone());
  shrineRingB.position.y = 3.0; shrineRingB.rotation.x = -0.8; shrine.add(shrineRingB);
  shrineGlowMats.push(ringMat, shrineRingB.material);

  for (let i = 0; i < 3; i++) {
    const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), new THREE.MeshStandardMaterial({ color: '#fff2c2', emissive: '#ffca6e', emissiveIntensity: 1.8, roughness: 0.3 }));
    shard.scale.set(0.6, 1.5, 0.6);
    shrine.add(shard); shrineOrbitals.push(shard); shrineGlowMats.push(shard.material);
  }

  const beamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform float uTime; uniform float uOpacity; varying vec2 vUv;
      void main(){
        float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x);
        float fade = smoothstep(0.0, 0.1, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
        float pulse = 0.72 + 0.28 * sin(uTime * 2.2 + vUv.y * 8.0);
        gl_FragColor = vec4(vec3(1.0, 0.87, 0.56), vUv.y * 0.0 + fade * edge * uOpacity * pulse);
      }`
  });
  shrineBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.9, 20, 16, 1, true), beamMat);
  shrineBeam.position.y = 10.4;
  shrine.add(shrineBeam);

  shrineLight = new THREE.PointLight('#ffcf85', 14, 20, 2);
  shrineLight.position.y = 3.2;
  shrine.add(shrineLight);
}

/* ---------- sunshards ---------- */
const shards = [];
const shardGlowMat = new THREE.MeshStandardMaterial({ color: '#c9fbef', emissive: '#54d8c8', emissiveIntensity: 1.4, roughness: 0.2, metalness: 0.15 });
const shardSpots = [[-12, 6], [10, 14], [-20, 20], [35, 6], [-6, 30], [40, -34], [-32, -18], [8, -34], [-40, 12], [48, 22]];
for (const [sx, sz] of shardSpots) {
  let x = sx, z = sz, y = heightAt(x, z);
  if (y < 0.4) { x *= 0.7; z *= 0.7; y = heightAt(x, z); }
  const g = new THREE.Group();
  g.position.set(x, y + 0.95, z);
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.4, 0), shardGlowMat);
  crystal.scale.set(0.8, 1.65, 0.8);
  crystal.castShadow = true;
  g.add(crystal);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: '#9ff6e6', transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.scale.setScalar(2.5); g.add(halo);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.02, 6, 28), new THREE.MeshStandardMaterial({ color: '#d6fff5', emissive: '#65e0cd', emissiveIntensity: 1.2, roughness: 0.3 }));
  ring.rotation.x = Math.PI / 2; g.add(ring);
  scene.add(g);
  shards.push({ group: g, crystal, halo, ring, baseY: y + 0.95, phase: rnd() * 6.28, got: false, x, z });
}

const pollen = (() => {
  const COUNT = 260;
  const positions = new Float32Array(COUNT * 3);
  const bases = [];
  for (let i = 0; i < COUNT; i++) {
    const a = rnd() * Math.PI * 2, r = 4 + Math.sqrt(rnd()) * 56;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, y = heightAt(x, z) + 0.5 + rnd() * 6;
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
    bases.push({ x, y, z, p: rnd() * 6.28 });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: '#fff0b8', size: 0.17, map: softTex, alphaTest: 0.02, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);
  return { geo, positions, bases };
})();

/* ---------- particle field ---------- */
class ParticleField {
  constructor(max, blending = THREE.AdditiveBlending) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: softTex }, uHeight: { value: innerHeight } },
      transparent: true, depthWrite: false, blending,
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
        uniform float uHeight;
        varying float vA; varying vec3 vC;
        void main(){
          vA = aAlpha; vC = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (uHeight * 0.55) / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uTex; varying float vA; varying vec3 vC;
        void main(){
          vec4 t = texture2D(uTex, gl_PointCoord);
          gl_FragColor = vec4(vC, 1.0) * t * vA;
          if (gl_FragColor.a < 0.005) discard;
        }`
    });
    this.material = mat;
    this.geo = geo;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  spawn(x, y, z, vx, vy, vz, life, size, color, grav = 0, drag = 0.6) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.size[i] = size; this.alpha[i] = 1;
    this.color[i * 3] = color.r; this.color[i * 3 + 1] = color.g; this.color[i * 3 + 2] = color.b;
    this.grav[i] = grav; this.drag[i] = drag;
  }
  update(dt) {
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const last = --this.count;
        if (i !== last) {
          for (let k = 0; k < 3; k++) {
            this.pos[i * 3 + k] = this.pos[last * 3 + k];
            this.vel[i * 3 + k] = this.vel[last * 3 + k];
            this.color[i * 3 + k] = this.color[last * 3 + k];
          }
          this.size[i] = this.size[last]; this.alpha[i] = this.alpha[last];
          this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last];
          this.grav[i] = this.grav[last]; this.drag[i] = this.drag[last];
        }
        i--;
        continue;
      }
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d + this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = t * t;
    }
    this.geo.setDrawRange(0, this.count);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.material.uniforms.uHeight.value = innerHeight;
  }
  burst(x, y, z, n, opts = {}) {
    const {
      speed = 2.2, spread = 0.9, life = 0.8, size = 0.12, color = new THREE.Color('#ffe9b0'),
      grav = -2.5, drag = 1.2, up = 1
    } = opts;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, sp = speed * (0.35 + rnd() * 0.85);
      const c = color.clone().offsetHSL((rnd() - 0.5) * 0.05, 0, (rnd() - 0.5) * 0.12);
      this.spawn(x, y, z,
        Math.cos(a) * sp * spread, up * (0.4 + rnd()) * speed * 0.5, Math.sin(a) * sp * spread,
        life * (0.65 + rnd() * 0.7), size * (0.65 + rnd() * 0.8), c, grav, drag);
    }
  }
}
const dustFx = new ParticleField(260, THREE.NormalBlending);
const sparkFx = new ParticleField(320, THREE.AdditiveBlending);

/* ---------- audio (procedural, no assets) ---------- */
const Audio = {
  ctx: null, master: null, muted: false,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      // soft wind bed
      const len = this.ctx.sampleRate * 3;
      const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { last = last * 0.96 + (Math.random() * 2 - 1) * 0.04; data[i] = last; }
      const src = this.ctx.createBufferSource();
      src.buffer = buffer; src.loop = true;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 520; filter.Q.value = 0.5;
      const gain = this.ctx.createGain(); gain.gain.value = 0.28;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
    } catch (err) { /* audio is optional */ }
  },
  tone(freq, dur = 0.18, type = 'sine', vol = 0.18, slide = 0, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.03);
  },
  noise(dur = 0.22, vol = 0.2, freq = 1400, q = 0.9, type = 'bandpass', delay = 0) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
  },
  jump() { this.tone(430, 0.16, 'triangle', 0.12, 260); },
  doubleJump() { this.tone(560, 0.2, 'triangle', 0.12, 420); this.tone(880, 0.14, 'sine', 0.07, 240, 0.03); },
  land() { this.noise(0.13, 0.1, 380, 0.7, 'lowpass'); },
  dash() { this.noise(0.28, 0.16, 900, 0.6); this.tone(220, 0.18, 'sawtooth', 0.05, -90); },
  attack() { this.noise(0.15, 0.13, 2400, 1.2); },
  hit() { this.tone(180, 0.12, 'square', 0.1, -70); this.noise(0.1, 0.12, 900, 1); },
  pickup() { this.tone(740, 0.14, 'triangle', 0.12, 120); this.tone(1100, 0.22, 'sine', 0.1, 200, 0.07); },
  hurt() { this.tone(150, 0.3, 'sawtooth', 0.12, -60); this.noise(0.2, 0.12, 300, 0.6, 'lowpass'); },
  win() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.7, 'triangle', 0.11, 0, i * 0.11)); },
  deny() { this.tone(220, 0.2, 'triangle', 0.08, -40); }
};

/* ---------- the wanderer ---------- */
const player = new THREE.Group();
player.position.set(0, heightAt(0, 0), 0);
scene.add(player);
const avatar = new THREE.Group();
player.add(avatar);

const M = {
  tunic: new THREE.MeshStandardMaterial({ color: '#3f7d86', roughness: 0.85 }),
  tunicDark: new THREE.MeshStandardMaterial({ color: '#2e5f68', roughness: 0.9 }),
  skin: new THREE.MeshStandardMaterial({ color: '#efc9a3', roughness: 0.75 }),
  hair: new THREE.MeshStandardMaterial({ color: '#4a362a', roughness: 0.9 }),
  boot: new THREE.MeshStandardMaterial({ color: '#5a4433', roughness: 0.92 }),
  cape: new THREE.MeshStandardMaterial({ color: '#b8543f', roughness: 0.88, side: THREE.DoubleSide }),
  scarf: new THREE.MeshStandardMaterial({ color: '#e8c47a', roughness: 0.85, side: THREE.DoubleSide }),
  gold: new THREE.MeshStandardMaterial({ color: '#e7c67d', roughness: 0.35, metalness: 0.5 }),
  steel: new THREE.MeshStandardMaterial({ color: '#dcebdf', roughness: 0.22, metalness: 0.65, emissive: '#8fd8cf', emissiveIntensity: 0.22 }),
  leather: new THREE.MeshStandardMaterial({ color: '#6b4c37', roughness: 0.9 }),
  eye: new THREE.MeshStandardMaterial({ color: '#2f2722', roughness: 0.5 }),
  mouth: new THREE.MeshStandardMaterial({ color: '#a4655a', roughness: 0.8 })
};
function piece(parent, geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}

const torso = new THREE.Group();
torso.position.y = 0.93;
avatar.add(torso);
piece(torso, new THREE.BoxGeometry(0.5, 0.26, 0.34), M.tunicDark, 0, 0.05, 0);
const chest = piece(torso, new THREE.CylinderGeometry(0.29, 0.25, 0.58, 7), M.tunic, 0, 0.45, 0);
chest.scale.z = 0.72;
piece(torso, new THREE.BoxGeometry(0.54, 0.09, 0.36), M.leather, 0, 0.22, 0);
piece(torso, new THREE.BoxGeometry(0.12, 0.12, 0.05), M.gold, 0, 0.22, -0.2);
piece(torso, new THREE.BoxGeometry(0.06, 0.34, 0.03), M.leather, 0.0, 0.44, -0.205);
piece(torso, new THREE.BoxGeometry(0.62, 0.14, 0.34), M.tunicDark, 0, 0.7, 0);

const headPivot = new THREE.Group();
headPivot.position.set(0, 0.8, 0);
torso.add(headPivot);
piece(headPivot, new THREE.CylinderGeometry(0.08, 0.1, 0.12, 6), M.skin, 0, 0.03, 0);
const head = piece(headPivot, new THREE.SphereGeometry(0.245, 16, 12), M.skin, 0, 0.24, -0.01);
head.scale.set(1, 1.06, 0.98);
const hair = piece(headPivot, new THREE.SphereGeometry(0.26, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), M.hair, 0, 0.3, 0.012);
hair.rotation.x = -0.08;
piece(headPivot, new THREE.BoxGeometry(0.3, 0.075, 0.13), M.hair, 0, 0.4, -0.145).rotation.x = 0.3;
piece(headPivot, new THREE.BoxGeometry(0.075, 0.2, 0.085), M.hair, -0.2, 0.27, 0.09).rotation.z = 0.3;
piece(headPivot, new THREE.BoxGeometry(0.075, 0.2, 0.085), M.hair, 0.2, 0.27, 0.09).rotation.z = -0.3;
piece(headPivot, new THREE.BoxGeometry(0.05, 0.05, 0.06), M.skin, 0, 0.2, -0.245);
for (const x of [-0.085, 0.085]) {
  piece(headPivot, new THREE.SphereGeometry(0.037, 8, 6), M.eye, x, 0.25, -0.226);
  piece(headPivot, new THREE.SphereGeometry(0.014, 5, 4), new THREE.MeshStandardMaterial({ color: '#fdf9ef', roughness: 0.3 }), x + 0.009, 0.263, -0.252);
  piece(headPivot, new THREE.BoxGeometry(0.075, 0.014, 0.025), M.hair, x, 0.31, -0.232).rotation.z = x > 0 ? -0.1 : 0.1;
}
piece(headPivot, new THREE.BoxGeometry(0.075, 0.016, 0.02), M.mouth, 0, 0.15, -0.235);
for (const s of [-1, 1]) piece(headPivot, new THREE.BoxGeometry(0.06, 0.09, 0.06), M.skin, s * 0.245, 0.22, 0);

function clothGeometry(width, height, cols, rows, taper, drape) {
  const g = new THREE.PlaneGeometry(1, height, cols, rows);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = clamp(0.5 - y / height, 0, 1);
    pos.setX(i, pos.getX(i) * lerp(1, taper, t) * width);
    pos.setZ(i, -drape * t * t);
  }
  g.computeVertexNormals();
  return g;
}
const capeGeo = clothGeometry(0.54, 0.8, 5, 6, 0.7, 0.07);
const cape = new THREE.Mesh(capeGeo, M.cape);
cape.position.set(0, 0.29, 0.21);
cape.rotation.x = -0.08;
cape.castShadow = true;
torso.add(cape);
const capeBase = Float32Array.from(cape.geometry.attributes.position.array);
const scarfGeo = clothGeometry(0.17, 0.52, 2, 4, 0.55, 0.03);
const scarf = new THREE.Mesh(scarfGeo, M.scarf);
scarf.position.set(0.05, 0.62, 0.2);
scarf.rotation.x = -0.15;
scarf.castShadow = true;
torso.add(scarf);
const scarfBase = Float32Array.from(scarf.geometry.attributes.position.array);
piece(torso, new THREE.TorusGeometry(0.16, 0.055, 6, 16, Math.PI * 1.4), M.scarf, 0, 0.79, 0).rotation.x = Math.PI / 2;

function buildArm(side) {
  const shoulder = new THREE.Group();
  shoulder.position.set(side * 0.33, 0.7, 0);
  torso.add(shoulder);
  piece(shoulder, new THREE.BoxGeometry(0.17, 0.22, 0.22), M.tunic, 0, -0.1, 0);
  const upper = piece(shoulder, new THREE.BoxGeometry(0.145, 0.26, 0.17), M.tunic, 0, -0.22, 0);
  const elbow = new THREE.Group();
  elbow.position.y = -0.34;
  shoulder.add(elbow);
  piece(elbow, new THREE.BoxGeometry(0.13, 0.24, 0.15), M.skin, 0, -0.12, 0);
  const hand = piece(elbow, new THREE.SphereGeometry(0.085, 8, 6), M.skin, 0, -0.26, 0);
  hand.scale.set(1, 0.95, 1.1);
  return { shoulder, elbow, hand };
}
const armL = buildArm(-1);
const armR = buildArm(1);

const woodMat = new THREE.MeshStandardMaterial({ color: '#8c5d3d', roughness: 0.85 });
const shield = new THREE.Group();
shield.position.set(-0.11, -0.28, -0.02);
armL.elbow.add(shield);
const shieldDisc = piece(shield, new THREE.CylinderGeometry(0.3, 0.3, 0.06, 18), woodMat, 0, 0, 0);
shieldDisc.rotation.z = Math.PI / 2;
const shieldRim = piece(shield, new THREE.TorusGeometry(0.29, 0.025, 6, 22), M.gold, 0, 0, 0);
shieldRim.rotation.y = Math.PI / 2;
const shieldBoss = piece(shield, new THREE.SphereGeometry(0.075, 10, 8), M.gold, -0.045, 0, 0);
shieldBoss.scale.x = 0.6;
piece(shield, new THREE.BoxGeometry(0.015, 0.42, 0.035), M.leather, -0.05, 0, 0);

const pauldron = piece(torso, new THREE.SphereGeometry(0.185, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.58), M.leather, 0.33, 0.76, 0);
pauldron.rotation.z = -0.3;
pauldron.scale.set(1, 0.8, 1);
piece(torso, new THREE.SphereGeometry(0.045, 7, 6), M.gold, 0.4, 0.82, 0);
for (const x of [-0.19, 0.19]) piece(torso, new THREE.SphereGeometry(0.04, 7, 6), M.gold, x, 0.72, -0.2);

const sword = new THREE.Group();
sword.position.set(0, -0.28, -0.02);
armR.elbow.add(sword);
piece(sword, new THREE.CylinderGeometry(0.035, 0.04, 0.24, 6), M.leather, 0, 0.02, 0);
piece(sword, new THREE.BoxGeometry(0.4, 0.06, 0.1), M.gold, 0, 0.15, 0);
piece(sword, new THREE.SphereGeometry(0.055, 8, 6), M.gold, 0, -0.11, 0);
piece(sword, new THREE.BoxGeometry(0.095, 0.68, 0.03), M.steel, 0, 0.5, 0);
const tip = piece(sword, new THREE.ConeGeometry(0.062, 0.16, 4), M.steel, 0, 0.9, 0);
tip.rotation.y = Math.PI / 4;
piece(sword, new THREE.BoxGeometry(0.024, 0.46, 0.012), new THREE.MeshStandardMaterial({ color: '#fff6d5', emissive: '#ffd88a', emissiveIntensity: 1.4, roughness: 0.3 }), 0, 0.5, -0.018);
sword.rotation.x = -0.2;
sword.rotation.z = 0.1;

function buildLeg(side) {
  const hip = new THREE.Group();
  hip.position.set(side * 0.15, 0.93, 0);
  avatar.add(hip);
  piece(hip, new THREE.BoxGeometry(0.2, 0.2, 0.24), M.tunicDark, 0, -0.05, 0);
  piece(hip, new THREE.BoxGeometry(0.185, 0.36, 0.22), M.tunicDark, 0, -0.24, 0);
  const knee = new THREE.Group();
  knee.position.y = -0.44;
  hip.add(knee);
  piece(knee, new THREE.BoxGeometry(0.165, 0.34, 0.2), M.tunic, 0, -0.17, 0);
  piece(knee, new THREE.BoxGeometry(0.2, 0.19, 0.19), M.leather, 0, -0.3, 0);
  piece(knee, new THREE.BoxGeometry(0.23, 0.15, 0.34), M.boot, 0, -0.4, -0.045);
  return { hip, knee };
}
const legL = buildLeg(-1);
const legR = buildLeg(1);

const slashFx = new THREE.Group();
slashFx.position.y = 1.12;
avatar.add(slashFx);
const slashMesh = new THREE.Mesh(
  new THREE.RingGeometry(0.72, 1.95, 30, 1, -0.55, 2.05),
  new THREE.MeshBasicMaterial({ color: '#fff1c2', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
);
slashMesh.rotation.x = -Math.PI / 2;
slashFx.add(slashMesh);
const swordGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: '#a9f3e4', transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
swordGlow.scale.setScalar(0.45);
swordGlow.position.set(0, 0.5, 0);
sword.add(swordGlow);

/* ---------- mosslings ---------- */
const enemies = [];
const ENEMY_SPAWNS = [[15, 9], [-17, 13], [-27, -9], [33, 9], [5, -28], [-9, -33], [40, -30], [46, 17], [-44, 2]];
function makeMossling(x, z, elder = false) {
  const g = new THREE.Group();
  const y = heightAt(x, z);
  g.position.set(x, y, z);
  const s = elder ? 1.45 : 1;
  const bodyMat = new THREE.MeshStandardMaterial({ color: elder ? '#c9a95e' : '#7fbb74', roughness: 0.42, emissive: '#143a26', emissiveIntensity: 0.25 });
  const darkMat = new THREE.MeshStandardMaterial({ color: '#395f45', roughness: 0.7 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: '#fdf5d8', roughness: 0.4 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: '#2c3a2c', roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.66, 16, 12), bodyMat);
  body.scale.set(1.12, 0.78, 1);
  body.position.y = 0.55;
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);
  const face = new THREE.Group();
  face.position.set(0, 0.58, -0.56);
  g.add(face);
  for (const ex of [-0.21, 0.21]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.085, 9, 7), eyeMat);
    eye.position.set(ex, 0.05, 0); eye.scale.z = 0.7; face.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.042, 7, 6), pupilMat);
    pupil.position.set(ex + 0.005, 0.045, -0.055); face.add(pupil);
  }
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.022, 5, 12, Math.PI), pupilMat);
  mouth.rotation.z = Math.PI; mouth.position.set(0, -0.11, -0.03); face.add(mouth);
  const sprout = new THREE.Group();
  sprout.position.set(0, 1.04, 0.02);
  g.add(sprout);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.24, 5), darkMat);
  stem.position.y = 0.08; sprout.add(stem);
  for (const side of [-1, 1]) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.12, 7, 5), new THREE.MeshStandardMaterial({ color: '#5c9a5b', roughness: 0.7 }));
    leaf.position.set(side * 0.12, 0.22, 0);
    leaf.scale.set(1.25, 0.35, 0.7);
    leaf.rotation.z = side * 0.5;
    sprout.add(leaf);
  }
  g.scale.setScalar(s);
  scene.add(g);
  const light = new THREE.PointLight('#8fe0a0', 2.2, 5, 2);
  light.position.y = 0.8; g.add(light);
  enemies.push({
    g, body, bodyMat, face, sprout, light,
    hp: elder ? 5 : 3, maxHp: elder ? 5 : 3, size: s, elder,
    home: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), vy: 0, grounded: true,
    state: 'idle', timer: 0.5 + rnd(), phase: rnd() * 6.28, hurtFlash: 0, alive: true, squash: 0
  });
}
for (let i = 0; i < ENEMY_SPAWNS.length; i++) {
  const [ex, ez] = ENEMY_SPAWNS[i];
  makeMossling(ex, ez, i === 3 || i === 7);
}

/* =========================================================================
   GAME STATE
   ========================================================================= */
const state = {
  started: false, won: false, health: 5, maxHealth: 5, shards: 0, time: 0,
  nearShrine: false, denyTimer: 0, wonTimer: -1, hitstop: 0, muted: false
};
const P = {
  radius: 0.42, walk: 5.7, sprint: 9.7, dashSpeed: 17.5,
  gravity: 30, fallGravity: 40, jumpV: 9.6, doubleJumpV: 8.5,
  maxFall: 34, accelGround: 54, accelAir: 25
};
const ps = {
  vel: new THREE.Vector3(), vy: 0, grounded: true, coyote: 0, jumpBuffer: 0,
  jumpsLeft: 2, stamina: 100, exhausted: false,
  dashTimer: 0, dashCooldown: 0, dashDir: new THREE.Vector3(0, 0, -1),
  attackTimer: 0, attackCooldown: 0, attackHit: false, combo: 0, comboTimer: 0,
  invuln: 0, hurtTimer: 0, landSquash: 0, recover: 0, walkPhase: 0,
  runBlend: 0, airBlend: 0, dashBlend: 0, attackBlend: 0, speed: 0,
  shake: 0, facing: 0, jumpHeld: false, wasGrounded: true
};

function groundAt(x, z) {
  let h = heightAt(x, z);
  const d = Math.hypot(x - SHRINE.x, z - SHRINE.z);
  if (d < 3.0) h = Math.max(h, SHRINE.y + 0.93);
  else if (d < 4.85) h = Math.max(h, SHRINE.y + 0.73);
  return h;
}

/* ---------- HUD ---------- */
const heartEls = [];
function buildHearts() {
  for (let i = 0; i < state.maxHealth; i++) {
    const s = document.createElement('span');
    s.className = 'heart'; s.textContent = '♥';
    heartsEl.appendChild(s); heartEls.push(s);
  }
}
buildHearts();
let hudCache = { health: -1, shards: -1, stamina: -1, exhausted: false };
function updateHud() {
  if (hudCache.health !== state.health) {
    hudCache.health = state.health;
    heartEls.forEach((h, i) => h.className = 'heart' + (i >= state.health ? ' empty' : ''));
  }
  if (hudCache.shards !== state.shards) {
    hudCache.shards = state.shards;
    shardsEl.textContent = state.shards;
    if (!state.won) {
      questEl.textContent = state.shards >= 3 ? 'Wake the Sunshard Shrine' : 'Find the Sunshard Shrine';
      hintEl.innerHTML = state.shards >= 3
        ? '<span>✦</span> The shrine is awake to you — return to its light.'
        : `<span>✧</span> ${3 - state.shards} more sunshard${3 - state.shards === 1 ? '' : 's'} to wake the shrine…`;
    }
  }
  const st = Math.round(ps.stamina);
  if (hudCache.stamina !== st || hudCache.exhausted !== ps.exhausted) {
    hudCache.stamina = st; hudCache.exhausted = ps.exhausted;
    staminaFill.style.width = st + '%';
    staminaEl.classList.toggle('low', ps.exhausted);
  }
}
let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2300);
}
function screenFlash() {
  flashEl.classList.add('show');
  requestAnimationFrame(() => requestAnimationFrame(() => flashEl.classList.remove('show')));
}

/* ---------- shards / shrine ---------- */
function addShard(n = 1) {
  state.shards += n;
  updateHud();
}
function collectShard(s) {
  s.got = true;
  s.group.visible = false;
  addShard(1);
  Audio.pickup();
  sparkFx.burst(s.group.position.x, s.group.position.y, s.group.position.z, 26, {
    speed: 3.2, life: 0.85, size: 0.16, color: new THREE.Color('#a9f6e6'), grav: -1.2, up: 0.7
  });
  toast('Sunshard found  ✧');
}
function killEnemy(en) {
  if (!en.alive) return;
  en.alive = false;
  scene.remove(en.g);
  sparkFx.burst(en.g.position.x, en.g.position.y + 0.6, en.g.position.z, 30, {
    speed: 3.4, life: 0.9, size: 0.17, color: new THREE.Color('#c8f3a8'), grav: -4, up: 1.1
  });
  addShard(1);
  Audio.pickup();
  toast(en.elder ? 'The elder mossling yields a sunshard ✧' : 'The mossling scampers off! +1 sunshard');
}
function activateShrine() {
  if (state.won) return;
  state.won = true;
  state.wonTimer = -1;
  setTimeout(() => {
    if (!state.won) return;
    const mins = Math.floor(state.time / 60), secs = Math.floor(state.time % 60).toString().padStart(2, '0');
    document.querySelector('#winStats').textContent = `${state.shards} SUNSHARDS · ${mins}:${secs}`;
    document.querySelector('#winScreen').classList.remove('hidden');
  }, 1600);
  shrineBeam.material.uniforms.uOpacity.value = 1;
  shrineLight.intensity = 90;
  shrineLight.distance = 34;
  shrineGlowMats.forEach(m => { if (m.emissiveIntensity !== undefined) m.emissiveIntensity = Math.max(m.emissiveIntensity, 2.4); });
  questEl.textContent = 'The wild remembers';
  hintEl.innerHTML = '<span>✦</span> The light is home.';
  Audio.win();
  for (let i = 0; i < 4; i++) {
    setTimeout(() => sparkFx.burst(SHRINE.x, SHRINE.y + 3.0, SHRINE.z, 40, {
      speed: 5.5, life: 1.6, size: 0.22, color: new THREE.Color('#ffe6a1'), grav: -0.8, up: 1.4, spread: 1.3
    }), i * 260);
  }
  ps.shake = 0.35;
}

/* ---------- combat ---------- */
function startAttack() {
  if (ps.attackCooldown > 0) return;
  ps.combo = ps.comboTimer > 0 ? (ps.combo + 1) % 3 : 0;
  ps.comboTimer = 0.72;
  ps.attackTimer = 0.42;
  ps.attackCooldown = 0.33;
  ps.attackHit = false;
  ps.dashTimer = Math.min(ps.dashTimer, 0.02);
  Audio.attack();
}
function resolveAttack() {
  const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.rotation.y);
  const reach = 2.9 + (ps.combo === 2 ? 0.4 : 0);
  let hitAny = false;
  for (const en of enemies) {
    if (!en.alive) continue;
    const dx = en.g.position.x - player.position.x;
    const dz = en.g.position.z - player.position.z;
    const dist = Math.hypot(dx, dz);
    const dy = Math.abs(en.g.position.y - player.position.y);
    if (dist > reach + en.size * 0.4 || dy > 1.9) continue;
    const dir = new THREE.Vector3(dx, 0, dz).normalize();
    if (forward.dot(dir) < 0.08) continue;
    const dmg = ps.combo === 2 ? 2 : 1;
    en.hp -= dmg;
    en.hurtFlash = 0.22;
    en.vel.x += dir.x * 5.5; en.vel.z += dir.z * 5.5;
    en.vy = Math.max(en.vy, 2.4); en.grounded = false;
    sparkFx.burst(en.g.position.x, en.g.position.y + 0.6, en.g.position.z, 14, {
      speed: 2.8, life: 0.5, size: 0.12, color: new THREE.Color('#ffe9ad'), grav: -6, up: 1
    });
    Audio.hit();
    ps.shake = Math.max(ps.shake, 0.16);
    state.hitstop = Math.max(state.hitstop, 0.055);
    hitAny = true;
    if (en.hp <= 0) killEnemy(en);
  }
}
function hurtPlayer(amount, fromX, fromZ) {
  if (state.won || ps.invuln > 0 || state.health <= 0) return;
  state.health -= amount;
  ps.invuln = 1.15;
  ps.shake = 0.4;
  screenFlash();
  Audio.hurt();
  const dx = player.position.x - fromX, dz = player.position.z - fromZ;
  const d = Math.hypot(dx, dz) || 1;
  ps.vel.x += dx / d * 7.5; ps.vel.z += dz / d * 7.5;
  ps.vy = 4.2; ps.grounded = false; ps.jumpsLeft = Math.max(1, ps.jumpsLeft);
  if (state.health <= 0) {
    state.health = state.maxHealth;
    player.position.set(0, heightAt(0, 0), 0);
    ps.vel.set(0, 0, 0); ps.vy = 0; ps.grounded = true;
    toast('A gentle breeze carries you back…');
  }
  updateHud();
}

/* ---------- input ---------- */
const keys = Object.create(null);
const joy = { x: 0, y: 0, active: false };
const input = { jumpQueued: false, jumpCut: false, attackQueued: false, dashQueued: false, sprintHeld: false };

window.addEventListener('keydown', (ev) => {
  const code = ev.code;
  keys[code] = true;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) ev.preventDefault();
  if (code === 'Space' && !ev.repeat) {
    input.jumpQueued = true;
    input.jumpCut = false;
  }
  if ((code === 'KeyF' || code === 'KeyJ' || code === 'Enter') && !ev.repeat) input.attackQueued = true;
  if ((code === 'KeyQ' || code === 'KeyE' || code === 'ShiftRight') && !ev.repeat) input.dashQueued = true;
  if (code === 'KeyM' && !ev.repeat) {
    Audio.muted = !Audio.muted;
    if (Audio.master) Audio.master.gain.value = Audio.muted ? 0 : 0.55;
    toast(Audio.muted ? 'Sound off' : 'Sound on');
  }
  if (code === 'Escape' || code === 'KeyP') {
    // no pause overlay: keep the world calm, just a friendly nudge
  }
});
window.addEventListener('keyup', (ev) => {
  keys[ev.code] = false;
  if (ev.code === 'Space') input.jumpCut = true;
});
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  joy.x = joy.y = 0;
});

/* joystick */
const stick = document.querySelector('#stick');
const knob = document.querySelector('#knob');
let stickId = null;
function moveStick(ev) {
  const r = stick.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let dx = ev.clientX - cx, dy = ev.clientY - cy;
  const max = r.width * 0.36;
  const len = Math.hypot(dx, dy);
  if (len > max) { dx = dx / len * max; dy = dy / len * max; }
  joy.x = dx / max; joy.y = dy / max;
  joy.active = Math.hypot(joy.x, joy.y) > 0.12;
  knob.style.transform = `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`;
}
function endStick(ev) {
  if (ev.pointerId !== stickId) return;
  stickId = null; joy.x = joy.y = 0; joy.active = false;
  knob.style.transform = 'translate(-50%,-50%)';
}
stick.addEventListener('pointerdown', (ev) => { ev.preventDefault(); stickId = ev.pointerId; stick.setPointerCapture(stickId); moveStick(ev); });
stick.addEventListener('pointermove', (ev) => { if (ev.pointerId === stickId) moveStick(ev); });
stick.addEventListener('pointerup', endStick);
stick.addEventListener('pointercancel', endStick);

document.querySelector('#jumpBtn').addEventListener('pointerdown', (ev) => { ev.preventDefault(); input.jumpQueued = true; input.jumpCut = false; });
document.querySelector('#jumpBtn').addEventListener('pointerup', () => { input.jumpCut = true; });
document.querySelector('#attackBtn').addEventListener('pointerdown', (ev) => { ev.preventDefault(); input.attackQueued = true; });
document.querySelector('#dashBtn').addEventListener('pointerdown', (ev) => { ev.preventDefault(); input.dashQueued = true; });

/* camera orbit: drag on the scene, wheel to zoom */
let camYaw = 0, camPitch = 0.21, camDist = 10.2;
let dragging = false, dragId = null, dragX = 0, dragY = 0, dragMoved = 0, lastDrag = -10;
canvas.addEventListener('pointerdown', (ev) => {
  if (!state.started) return;
  if (ev.target !== canvas) return;
  dragging = true; dragId = ev.pointerId; dragX = ev.clientX; dragY = ev.clientY; dragMoved = 0;
  canvas.setPointerCapture?.(ev.pointerId);
});
canvas.addEventListener('pointermove', (ev) => {
  if (!dragging || ev.pointerId !== dragId) return;
  const dx = ev.clientX - dragX, dy = ev.clientY - dragY;
  dragX = ev.clientX; dragY = ev.clientY;
  dragMoved += Math.abs(dx) + Math.abs(dy);
  camYaw -= dx * 0.006;
  camPitch = clamp(camPitch + dy * 0.004, 0.08, 1.05);
  lastDrag = state.time;
});
function endDrag(ev) {
  if (ev.pointerId !== dragId) return;
  if (dragging && dragMoved < 8 && ev.pointerType === 'mouse') input.attackQueued = true;
  dragging = false; dragId = null;
  lastDrag = state.time;
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (ev) => {
  if (!state.started) return;
  ev.preventDefault();
  camDist = clamp(camDist + ev.deltaY * 0.012, 6.2, 21);
}, { passive: false });

/* start / restart */
document.querySelector('#playBtn').addEventListener('click', () => {
  Audio.init();
  state.started = true;
  document.body.classList.remove('pre-game');
  document.querySelector('#startScreen').classList.add('hidden');
  hintEl.innerHTML = '<span>✦</span> The Sunshard Shrine waits beyond the old trees…';
  camYaw = player.rotation.y;
  camDist = 10.2;
  lastDrag = state.time;
  toast('Follow the light.  SPACE twice to double jump');
});
document.querySelector('#againBtn').addEventListener('click', () => location.reload());

/* =========================================================================
   PHYSICS
   ========================================================================= */
const FIXED = 1 / 120;
function stepPlayer(dt) {
  ps.attackCooldown = Math.max(0, ps.attackCooldown - dt);
  ps.dashCooldown = Math.max(0, ps.dashCooldown - dt);
  ps.attackTimer = Math.max(0, ps.attackTimer - dt);
  ps.comboTimer = Math.max(0, ps.comboTimer - dt);
  ps.invuln = Math.max(0, ps.invuln - dt);
  ps.shake = Math.max(0, ps.shake - dt * 2.4);
  ps.hurtTimer = Math.max(0, ps.hurtTimer - dt);
  ps.jumpBuffer = Math.max(0, ps.jumpBuffer - dt);

  if (input.jumpQueued) { input.jumpQueued = false; ps.jumpBuffer = 0.15; }
  if (input.jumpCut) { input.jumpCut = false; if (ps.vy > 2.6) ps.vy *= 0.55; }
  if (input.attackQueued) { input.attackQueued = false; startAttack(); }

  const groundY = groundAt(player.position.x, player.position.z);
  const wasGrounded = ps.grounded;
  if (ps.grounded) { ps.coyote = 0.12; ps.jumpsLeft = 1; }
  else ps.coyote = Math.max(0, ps.coyote - dt);

  // camera-relative movement
  const fwdInput = ((keys.KeyW || keys.ArrowUp) ? 1 : 0) - ((keys.KeyS || keys.ArrowDown) ? 1 : 0) - joy.y;
  const sideInput = ((keys.KeyD || keys.ArrowRight) ? 1 : 0) - ((keys.KeyA || keys.ArrowLeft) ? 1 : 0) + joy.x;
  let wishX = -Math.sin(camYaw) * fwdInput + Math.cos(camYaw) * sideInput;
  let wishZ = -Math.cos(camYaw) * fwdInput - Math.sin(camYaw) * sideInput;
  let wishLen = Math.hypot(wishX, wishZ);
  if (wishLen > 1) { wishX /= wishLen; wishZ /= wishLen; wishLen = 1; }
  const mag = wishLen;

  // jumping: buffered, coyote-aware, with one air jump
  if (ps.jumpBuffer > 0) {
    if (ps.grounded || ps.coyote > 0) {
      ps.vy = P.jumpV;
      ps.grounded = false;
      ps.coyote = 0;
      ps.jumpBuffer = 0;
      ps.jumpsLeft = 1;
      ps.landSquash = 0;
      player.position.y += 0.02;
      Audio.jump();
      for (let i = 0; i < 7; i++) {
        dustFx.spawn(player.position.x + (rnd() - 0.5) * 0.5, groundY + 0.06, player.position.z + (rnd() - 0.5) * 0.5,
          (rnd() - 0.5) * 1.4, 0.5 + rnd(), (rnd() - 0.5) * 1.4, 0.4 + rnd() * 0.3, 0.12, new THREE.Color('#e8dcc0'), -1.2, 2.2);
      }
    } else if (ps.jumpsLeft > 0) {
      ps.vy = P.doubleJumpV;
      ps.jumpsLeft = 0;
      ps.jumpBuffer = 0;
      Audio.doubleJump();
      sparkFx.burst(player.position.x, player.position.y + 0.7, player.position.z, 18, {
        speed: 2.4, life: 0.5, size: 0.13, color: new THREE.Color('#b9f5e7'), grav: -2.5, up: 0.4
      });
      ps.shake = Math.max(ps.shake, 0.06);
    }
  }

  // sprint stamina
  const sprintHeld = !!(keys.ShiftLeft || keys.ShiftRight) || (joy.active && Math.hypot(joy.x, joy.y) > 0.92);
  const wantSprint = sprintHeld && mag > 0.18 && !ps.exhausted && ps.stamina > 1 && ps.dashTimer <= 0;
  ps.stamina = clamp(ps.stamina + (wantSprint ? -22 : 18) * dt, 0, 100);
  if (ps.stamina <= 0.01) ps.exhausted = true;
  if (ps.exhausted && ps.stamina >= 26) ps.exhausted = false;

  // dash
  if (input.dashQueued) {
    input.dashQueued = false;
    if (ps.dashCooldown <= 0 && ps.stamina >= 18 && !state.won) {
      ps.dashTimer = 0.22;
      ps.dashCooldown = 0.75;
      ps.stamina -= 18;
      if (mag > 0.12) ps.dashDir.set(wishX / (wishLen || 1), 0, wishZ / (wishLen || 1));
      else ps.dashDir.set(-Math.sin(player.rotation.y), 0, -Math.cos(player.rotation.y));
      ps.vy = Math.max(ps.vy, 0.6);
      ps.invuln = Math.max(ps.invuln, 0.24);
      Audio.dash();
      ps.shake = Math.max(ps.shake, 0.14);
      for (let i = 0; i < 12; i++) {
        dustFx.spawn(player.position.x, player.position.y + 0.4 + rnd() * 0.7, player.position.z,
          (rnd() - 0.5) * 2.6 - ps.dashDir.x * 2.5, (rnd() - 0.2) * 1.4, (rnd() - 0.5) * 2.6 - ps.dashDir.z * 2.5,
          0.35 + rnd() * 0.3, 0.14, new THREE.Color('#cfe9dd'), -0.8, 2.0);
      }
    }
  }

  if (ps.dashTimer > 0) {
    ps.dashTimer = Math.max(0, ps.dashTimer - dt);
    const k = 0.55 + 0.45 * clamp(ps.dashTimer / 0.22, 0, 1);
    ps.vel.x = ps.dashDir.x * P.dashSpeed * k;
    ps.vel.z = ps.dashDir.z * P.dashSpeed * k;
    player.rotation.y = dampAngle(player.rotation.y, Math.atan2(-ps.dashDir.x, -ps.dashDir.z), 22, dt);
    if (rnd() < 0.55) {
      sparkFx.spawn(player.position.x + (rnd() - 0.5) * 0.6, player.position.y + 0.4 + rnd() * 0.9, player.position.z + (rnd() - 0.5) * 0.6,
        -ps.dashDir.x * 2 + (rnd() - 0.5), 0.3 + rnd() * 0.6, -ps.dashDir.z * 2 + (rnd() - 0.5),
        0.3, 0.1, new THREE.Color('#bff6ea'), 0.2, 3.0);
    }
  } else {
    const gy = groundAt(player.position.x, player.position.z);
    const wading = gy < 0.02;
    let maxSpeed = wantSprint ? P.sprint : P.walk;
    if (wading) maxSpeed *= 0.55;
    const targetX = wishX * maxSpeed, targetZ = wishZ * maxSpeed;
    const accel = (ps.grounded ? (mag > 0.1 ? P.accelGround : 36) : P.accelAir) * dt;
    ps.vel.x = approach(ps.vel.x, targetX, accel);
    ps.vel.z = approach(ps.vel.z, targetZ, accel);
    if (mag < 0.08 && ps.grounded) {
      const drag = Math.exp(-15 * dt);
      ps.vel.x *= drag; ps.vel.z *= drag;
    }
    // slope physics: soft wall for climbing, slide for steep ground
    if (ps.grounded) {
      const n = normalAt(player.position.x, player.position.z);
      if (n.y < 0.82) {
        const slide = (0.82 - n.y) * 52;
        ps.vel.x += n.x * slide * dt;
        ps.vel.z += n.z * slide * dt;
        const climb = -n.y; // downhill is (n.x,n.z); uphill movement gets slowed
        const uphillDot = -(wishX * n.x + wishZ * n.z);
        if (uphillDot > 0 && n.y < 0.9) {
          const resist = (1 - n.y) * uphillDot * 24;
          ps.vel.x -= wishX * resist * dt * 8;
          ps.vel.z -= wishZ * resist * dt * 8;
        }
      }
    }
    if (wading && ps.grounded && mag > 0.2 && rnd() < 0.25) {
      dustFx.spawn(player.position.x, player.position.y + 0.04, player.position.z,
        (rnd() - 0.5) * 1.2, 1.2 + rnd(), (rnd() - 0.5) * 1.2,
        0.4, 0.14, new THREE.Color('#cfeee6'), -6, 1.4);
    }
  }

  if (mag > 0.12 && ps.dashTimer <= 0) {
    const targetYaw = Math.atan2(-wishX, -wishZ);
    player.rotation.y = dampAngle(player.rotation.y, targetYaw, ps.grounded ? 14 : 7, dt);
  }

  // integrate horizontal + collide
  let px = player.position.x + ps.vel.x * dt;
  let pz = player.position.z + ps.vel.z * dt;
  for (let pass = 0; pass < 2; pass++) {
    const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = colliderGrid.get(`${cx + ox},${cz + oz}`);
        if (!list) continue;
        for (const c of list) {
          const dx = px - c.x, dz = pz - c.z;
          const minD = c.r + P.radius;
          const d2 = dx * dx + dz * dz;
          if (d2 < minD * minD && d2 > 0.0001) {
            const d = Math.sqrt(d2), push = minD - d;
            px += dx / d * push; pz += dz / d * push;
            const vn = ps.vel.x * (dx / d) + ps.vel.z * (dz / d);
            if (vn < 0) { ps.vel.x -= vn * (dx / d); ps.vel.z -= vn * (dz / d); }
          }
        }
      }
    }
  }
  const rad = Math.hypot(px, pz);
  if (rad > 57) {
    const k = (rad - 57) * 0.85;
    px -= px / rad * k; pz -= pz / rad * k;
    ps.vel.x *= 0.75; ps.vel.z *= 0.75;
  }
  player.position.x = px;
  player.position.z = pz;
  ps.speed = Math.hypot(ps.vel.x, ps.vel.z);

  const gy = groundAt(px, pz);
  if (!ps.grounded) {
    const gravity = ps.vy > 0 ? P.gravity : P.fallGravity;
    ps.vy = Math.max(ps.vy - gravity * dt, -P.maxFall);
    player.position.y += ps.vy * dt;
    if (player.position.y <= gy) {
      const impact = -ps.vy;
      player.position.y = gy;
      ps.vy = 0;
      ps.grounded = true;
      ps.jumpsLeft = 1;
      ps.coyote = 0.12;
      if (impact > 2.5) {
        ps.landSquash = clamp(impact / 17, 0.16, 1);
        Audio.land();
        const n = impact > 11 ? 16 : 8;
        for (let i = 0; i < n; i++) {
          dustFx.spawn(px + (rnd() - 0.5) * 0.7, gy + 0.05, pz + (rnd() - 0.5) * 0.7,
            (rnd() - 0.5) * 3.2, 0.3 + rnd() * 1.3, (rnd() - 0.5) * 3.2,
            0.45 + rnd() * 0.35, 0.13 + rnd() * 0.06, new THREE.Color('#e9dfc8'), -2.4, 1.8);
        }
        if (impact > 12) { ps.shake = Math.max(ps.shake, 0.22); sparkFx.burst(px, gy + 0.1, pz, 8, { speed: 1.6, life: 0.4, size: 0.11, color: new THREE.Color('#dff6ea'), grav: -2, up: 0.5 }); }
      }
    }
  } else if (wasGrounded) {
    if (player.position.y > gy + 0.55) {
      ps.grounded = false;
    } else {
      player.position.y = gy;
      ps.vy = 0;
    }
  }

  if (ps.attackTimer > 0 && !ps.attackHit && ps.attackTimer <= 0.28) {
    ps.attackHit = true;
    resolveAttack();
  }
}

function stepEnemies(dt) {
  for (const en of enemies) {
    if (!en.alive) continue;
    en.hurtFlash = Math.max(0, en.hurtFlash - dt);
    const p = en.g.position;
    const dx = player.position.x - p.x, dz = player.position.z - p.z;
    const d = Math.hypot(dx, dz) || 0.001;
    if (state.started && !state.won) {
      en.timer -= dt;
      if (d < 15 && en.timer <= 0 && en.grounded && d > 0.85) {
        en.vy = en.elder ? 4.7 : 3.9;
        const hop = en.elder ? 2.1 : 2.55;
        en.vel.x = dx / d * hop;
        en.vel.z = dz / d * hop;
        en.timer = 0.5 + rnd() * 0.5;
        en.grounded = false;
      }
      if (d < 18) en.faceYaw = Math.atan2(-dx, -dz);
    }
    p.x += en.vel.x * dt;
    p.z += en.vel.z * dt;
    const drag = Math.exp(-2.4 * dt);
    en.vel.x *= drag; en.vel.z *= drag;
    en.vy -= 26 * dt;
    p.y += en.vy * dt;
    const gy = heightAt(p.x, p.z);
    if (p.y <= gy) {
      if (!en.grounded && en.vy < -3.5) en.squash = 1;
      p.y = gy; en.vy = 0; en.grounded = true;
    } else en.grounded = false;
    en.squash = Math.max(0, en.squash - dt * 4.5);
    const r = Math.hypot(p.x, p.z);
    if (r > 55) { p.x *= 55 / r; p.z *= 55 / r; }
    if (state.started && !state.won && d < 0.9 + 0.35 * en.size && Math.abs(p.y - player.position.y) < 1.5) {
      hurtPlayer(1, p.x, p.z);
      en.vel.x = -dx / d * 3.4; en.vel.z = -dz / d * 3.4;
      en.vy = Math.max(en.vy, 2.2);
      en.grounded = false;
    }
  }
}

/* =========================================================================
   CHARACTER ANIMATION
   ========================================================================= */
const capePos = cape.geometry.attributes.position;
const scarfPos = scarf.geometry.attributes.position;
let footPhaseSign = 1;
function animateCloth(mesh, base, t, amount, wave) {
  const pos = mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const bx = base[i * 3], by = base[i * 3 + 1];
    const w = clamp((0.47 - by) / 0.94, 0, 1);
    const f = (Math.sin(t * wave + bx * 7 + by * 5) * 0.028 + Math.sin(t * wave * 0.53 + bx * 3) * 0.02) * w;
    pos.setZ(i, f * amount);
  }
  pos.needsUpdate = true;
}
function animateAvatar(dt) {
  const t = state.time;
  ps.speed = Math.hypot(ps.vel.x, ps.vel.z);
  const targetRun = clamp(ps.speed / 8.6, 0, 1);
  ps.runBlend = damp(ps.runBlend, targetRun, 10, dt);
  ps.airBlend = damp(ps.airBlend, ps.grounded ? 0 : 1, 12, dt);
  ps.dashBlend = damp(ps.dashBlend, ps.dashTimer > 0 ? 1 : 0, 20, dt);
  ps.attackBlend = damp(ps.attackBlend, ps.attackTimer > 0 ? 1 : 0, 20, dt);
  ps.landSquash = Math.max(0, ps.landSquash - dt * 3.4);

  const run = ps.runBlend * (1 - ps.airBlend);
  const air = ps.airBlend;
  const dash = ps.dashBlend;
  if (ps.grounded) ps.walkPhase += dt * (3.1 + ps.speed * 1.42);
  const p = ps.walkPhase;
  const swing = Math.sin(p);

  // legs
  legL.hip.rotation.x = swing * 0.95 * run - air * 0.58 + dash * 1.05;
  legR.hip.rotation.x = -swing * 0.95 * run - air * 0.18 + dash * 0.85;
  legL.knee.rotation.x = -0.08 - Math.max(0, -swing) * 1.15 * run - air * 1.12 - dash * 0.4;
  legR.knee.rotation.x = -0.08 - Math.max(0, swing) * 1.15 * run - air * 0.62 - dash * 0.3;

  // arms: left counter-swings, right carries the blade
  const armSwing = -swing;
  const idleSway = Math.sin(t * 1.5) * 0.035 * (1 - run);
  armL.shoulder.rotation.x = armSwing * 0.72 * run + idleSway - air * 0.5 - dash * 0.5;
  armL.shoulder.rotation.z = -0.07 - air * 0.35 - dash * 0.15;
  armL.elbow.rotation.x = 0.3 + Math.max(0, armSwing) * 0.5 * run + air * 0.55 + dash * 0.25;

  let armRX = swing * 0.5 * run + idleSway * 0.5 - air * 0.3 + 0.06;
  let armRZ = 0.06;
  let elbowRX = 0.52 + Math.max(0, -swing) * 0.22 * run + air * 0.25;

  // sword arc: wind up, sweep, recover
  let slashOpacity = 0;
  if (ps.attackTimer > 0) {
    const ap = 1 - ps.attackTimer / 0.42;
    const dir = ps.combo === 2 ? -1 : 1;
    if (ap < 0.3) {
      const k = ap / 0.3;
      armRX = lerp(0.06, -1.55, k);
      armRZ = lerp(0.06, -0.85 * dir, k);
    } else if (ap < 0.62) {
      const k = smoothstep(0, 1, (ap - 0.3) / 0.32);
      armRX = lerp(-1.55, 0.55, k);
      armRZ = lerp(-0.85 * dir, 1.35 * dir, k);
      slashOpacity = Math.sin(k * Math.PI) * 0.85;
      slashMesh.rotation.z = lerp(0.75 * dir, -1.05 * dir, k);
    } else {
      const k = (ap - 0.62) / 0.38;
      armRX = lerp(0.55, 0.06, k);
      armRZ = lerp(1.35 * dir, 0.06, k);
    }
    elbowRX = 0.35;
  }
  armR.shoulder.rotation.x = damp(armR.shoulder.rotation.x, armRX, 26, dt);
  armR.shoulder.rotation.z = damp(armR.shoulder.rotation.z, armRZ, 26, dt);
  armR.elbow.rotation.x = damp(armR.elbow.rotation.x, elbowRX, 20, dt);
  slashMesh.material.opacity = damp(slashMesh.material.opacity, slashOpacity, 24, dt);

  // torso posture
  const baseTorsoY = 0.93;
  const bob = ps.grounded ? Math.abs(Math.sin(p * 2)) * 0.055 * run : 0.02;
  torso.position.y = damp(torso.position.y, baseTorsoY + bob, 18, dt);
  const lean = -0.15 * run - 0.42 * dash + 0.22 * (ps.invuln > 0.85 ? 1 : 0) + Math.sin(t * 1.4) * 0.012 * (1 - run);
  torso.rotation.x = damp(torso.rotation.x, lean, 12, dt);
  const twist = ps.attackTimer > 0 ? Math.sin((1 - ps.attackTimer / 0.42) * Math.PI) * 0.42 * (ps.combo === 2 ? -1 : 1) : 0;
  torso.rotation.y = damp(torso.rotation.y, twist, 18, dt);
  torso.rotation.z = damp(torso.rotation.z, -ps.vel.x * 0.006 - Math.sin(p) * 0.02 * run, 10, dt);

  // head life
  headPivot.rotation.x = damp(headPivot.rotation.x, -0.03 - 0.06 * run + air * 0.08, 9, dt);
  headPivot.rotation.y = damp(headPivot.rotation.y, Math.sin(t * 0.8) * 0.06 * (1 - run) + (ps.attackTimer > 0 ? 0.16 : 0), 8, dt);
  headPivot.rotation.z = Math.sin(t * 1.1) * 0.02;

  // squash & stretch around the feet
  const stretch = air ? clamp(ps.vy * 0.006, -0.05, 0.06) : 0;
  const sq = ps.landSquash;
  avatar.scale.set(1 + sq * 0.16, 1 - sq * 0.2 + stretch, 1 + sq * 0.16);

  // cloth
  cape.rotation.x = -0.1 - Math.min(0.55, ps.speed * 0.045) - air * 0.28 - dash * 0.3 + Math.sin(t * 6.5) * 0.025;
  cape.rotation.z = Math.sin(t * 3.3) * 0.055 + Math.sin(p) * 0.03 * run;
  scarf.rotation.x = -0.12 - Math.min(0.7, ps.speed * 0.06) - air * 0.4 + Math.sin(t * 7.4) * 0.05;
  animateCloth(cape, capeBase, t, 1 + ps.speed * 0.12, 7.5);
  animateCloth(scarf, scarfBase, t, 1.4 + ps.speed * 0.18, 11);
  swordGlow.material.opacity = 0.16 + Math.sin(t * 3.2) * 0.05 + (ps.attackTimer > 0 ? 0.5 : 0);
  sword.rotation.x = damp(sword.rotation.x, ps.attackTimer > 0 ? 0.15 : -0.2, 12, dt);

  // invulnerability blink
  avatar.visible = ps.invuln <= 0 || Math.sin(t * 42) > -0.35;

  // footsteps + splash
  if (ps.grounded && run > 0.25) {
    const sign = Math.sign(swing) || 1;
    if (sign !== footPhaseSign) {
      footPhaseSign = sign;
      const wading = groundAt(player.position.x, player.position.z) < 0.02;
      const side = sign * 0.16;
      const fx = player.position.x + Math.cos(player.rotation.y) * side;
      const fz = player.position.z - Math.sin(player.rotation.y) * side;
      if (wading) {
        dustFx.spawn(fx, player.position.y + 0.05, fz, (rnd() - 0.5) * 1.2, 1.2 + rnd() * 0.8, (rnd() - 0.5) * 1.2,
          0.4, 0.13, new THREE.Color('#d5f2ea'), -5, 1.4);
      } else {
        dustFx.spawn(fx, player.position.y + 0.04, fz, (rnd() - 0.5) * 0.8 + ps.vel.x * 0.12, 0.35 + rnd() * 0.5, (rnd() - 0.5) * 0.8 + ps.vel.z * 0.12,
          0.34 + rnd() * 0.2, 0.09 + rnd() * 0.05, new THREE.Color('#e6dcc4'), -1.4, 2.4);
      }
    }
  } else footPhaseSign = Math.sign(swing) || 1;
}

/* =========================================================================
   WORLD UPDATES
   ========================================================================= */
function updateWorld(dt) {
  const t = state.time;
  skyMat.uniforms.uTime.value = t;
  waterUniforms.uTime.value = t;
  waterUniforms.uCam.value.copy(camera.position);
  grassUniforms.uTime.value = t;
  shrineBeam.material.uniforms.uTime.value = t;

  // sun & shadow follow the wanderer
  sun.position.copy(player.position).addScaledVector(SUN_DIR, 75);
  sun.target.position.set(player.position.x, player.position.y, player.position.z);
  sun.target.updateMatrixWorld();

  // pollen
  const pos = pollen.geo.attributes.position;
  for (let i = 0; i < pollen.bases.length; i++) {
    const m = pollen.bases[i];
    pos.array[i * 3] = m.x + Math.sin(t * 0.42 + m.p) * 0.4;
    pos.array[i * 3 + 1] = m.y + Math.sin(t * 0.8 + m.p) * 0.3 + Math.sin(t * 0.21 + i) * 0.2;
    pos.array[i * 3 + 2] = m.z + Math.cos(t * 0.36 + m.p) * 0.32;
  }
  pos.needsUpdate = true;

  // shards float, shimmer, and are magnetised
  for (const s of shards) {
    if (s.got) continue;
    s.crystal.rotation.y += dt * 1.3;
    s.ring.rotation.z += dt * 0.9;
    const bob = Math.sin(t * 2.1 + s.phase) * 0.16;
    s.group.position.y = s.baseY + bob;
    s.halo.material.opacity = 0.55 + Math.sin(t * 2.6 + s.phase) * 0.2;
    if (state.started) {
      const dx = player.position.x - s.group.position.x;
      const dz = player.position.z - s.group.position.z;
      const dy = player.position.y + 0.9 - s.group.position.y;
      const d = Math.hypot(dx, dz);
      if (d < 5.0 && d > 0.8) {
        const pull = (1 - d / 5.0) * 5.5 * dt;
        s.group.position.x += dx / d * pull;
        s.group.position.z += dz / d * pull;
        s.group.position.y += dy * pull * 0.8;
      }
      if (d < 1.8 && Math.abs(dy) < 2.1) collectShard(s);
    }
  }

  // shrine
  shrineCore.position.y = 3.0 + Math.sin(t * 1.4) * 0.14;
  shrineCore.rotation.y = t * 0.8;
  shrineRingA.rotation.z = t * 0.5;
  shrineRingB.rotation.z = -t * 0.38;
  shrineRingA.rotation.y = Math.sin(t * 0.4) * 0.3;
  shrineOrbitals.forEach((o, i) => {
    const a = t * 0.9 + i * Math.PI * 2 / 3;
    o.position.set(Math.cos(a) * 2.15, 3.0 + Math.sin(t * 1.5 + i) * 0.3, Math.sin(a) * 2.15);
    o.rotation.y = t * 2 + i;
  });
  const beamTarget = state.won ? 0.9 : 0.0;
  shrineBeam.material.uniforms.uOpacity.value = damp(shrineBeam.material.uniforms.uOpacity.value, beamTarget, 2.2, dt);
  shrineLight.intensity = damp(shrineLight.intensity, state.won ? 90 : 14 + Math.sin(t * 2.2) * 2.5, 3, dt);
  shrineGlowMats.forEach((m, i) => {
    m.emissiveIntensity = 1.4 + Math.sin(t * 2.4 + i * 0.8) * 0.5 + (state.won ? 1.2 : 0);
  });

  // clouds
  for (const c of clouds) {
    c.s.position.x += c.speed * dt * 0.8;
    if (c.s.position.x > 210) c.s.position.x = -210;
  }

  // creature presentation
  for (const en of enemies) {
    if (!en.alive) continue;
    en.phase += dt * 2.6;
    en.g.rotation.y = dampAngle(en.g.rotation.y, en.faceYaw !== undefined ? en.faceYaw : en.g.rotation.y, 8, dt);
    const stretch = clamp(en.vy * 0.05, -0.28, 0.3);
    const sq = en.squash * 0.32;
    en.g.scale.set(en.size * (1 - stretch * 0.5 + sq), en.size * (1 + stretch - sq), en.size * (1 - stretch * 0.5 + sq));
    en.body.position.y = 0.55 + Math.abs(Math.sin(en.phase)) * 0.02;
    en.sprout.rotation.z = Math.sin(t * 2.2 + en.phase) * 0.18;
    en.sprout.rotation.x = Math.sin(t * 1.7 + en.phase) * 0.12;
    en.face.position.y = 0.58 + Math.abs(Math.sin(en.phase)) * 0.02;
    en.bodyMat.emissive.set(en.hurtFlash > 0 ? '#ff9a63' : '#143a26');
    en.bodyMat.emissiveIntensity = en.hurtFlash > 0 ? 1.8 : 0.25;
    en.light.intensity = 1.8 + Math.sin(t * 3 + en.phase) * 0.5 + (en.hurtFlash > 0 ? 9 : 0);
  }

  dustFx.update(dt);
  sparkFx.update(dt);

  // shrine proximity
  if (state.started && !state.won) {
    const d = Math.hypot(player.position.x - SHRINE.x, player.position.z - SHRINE.z);
    state.denyTimer = Math.max(0, state.denyTimer - dt);
    if (d < 5.4 && !state.nearShrine) {
      state.nearShrine = true;
      if (state.shards >= 3) activateShrine();
      else if (state.denyTimer <= 0) {
        state.denyTimer = 4;
        Audio.deny();
        toast(`The shrine is quiet… ${3 - state.shards} more sunshard${3 - state.shards === 1 ? '' : 's'}.`);
      }
    }
    if (d > 7.5) state.nearShrine = false;
  }

}

/* =========================================================================
   CAMERA
   ========================================================================= */
function updateCamera(dt) {
  if (!state.started) {
    const t = state.time;
    const a = t * 0.05 + 0.62;
    const desired = new THREE.Vector3(Math.cos(a) * 44, 14 + Math.sin(t * 0.14) * 2.5, Math.sin(a) * 44);
    camera.position.lerp(desired, 1 - Math.exp(-2.0 * dt));
    camera.lookAt(4, 4.0, -4);
    camera.fov = damp(camera.fov, 49, 2, dt);
    camera.updateProjectionMatrix();
    return;
  }
  const speedF = clamp(ps.speed / 9, 0, 1);
  if (!dragging && state.time - lastDrag > 1.2 && ps.speed > 1.5) {
    if (Math.abs(angleDelta(camYaw, player.rotation.y)) < 1.55) {
      camYaw = dampAngle(camYaw, player.rotation.y, 1.7, dt);
    }
  }
  const lookX = player.position.x + ps.vel.x * 0.11;
  const lookY = player.position.y + 1.42;
  const lookZ = player.position.z + ps.vel.z * 0.11;
  const horiz = Math.cos(camPitch) * camDist;
  const desired = new THREE.Vector3(
    lookX + Math.sin(camYaw) * horiz,
    lookY + Math.sin(camPitch) * camDist,
    lookZ + Math.cos(camYaw) * horiz
  );
  // keep the camera out of hillsides
  const dir = desired.clone().sub(new THREE.Vector3(lookX, lookY, lookZ));
  const len = dir.length() || 0.001;
  dir.divideScalar(len);
  let allowed = len;
  for (let i = 1; i <= 12; i++) {
    const t = len * i / 12;
    const sx = lookX + dir.x * t, sy = lookY + dir.y * t, sz = lookZ + dir.z * t;
    if (sy < heightAt(sx, sz) + 0.65) { allowed = Math.max(2.3, t - 0.6); break; }
  }
  desired.set(lookX, lookY, lookZ).addScaledVector(dir, allowed);
  camera.position.lerp(desired, 1 - Math.exp(-11 * dt));
  if (ps.shake > 0.003) {
    camera.position.x += (rnd() - 0.5) * ps.shake;
    camera.position.y += (rnd() - 0.5) * ps.shake * 0.75;
    camera.position.z += (rnd() - 0.5) * ps.shake;
  }
  camera.lookAt(lookX, lookY - 0.05, lookZ);
  const baseFov = innerWidth < 700 ? 54 : 48;
  const targetFov = baseFov + (ps.dashTimer > 0 ? 5 : 0) + speedF * 1.8 + (ps.attackTimer > 0 ? 0.6 : 0);
  camera.fov = damp(camera.fov, targetFov, 5, dt);
  camera.updateProjectionMatrix();
}

/* =========================================================================
   MINI MAP
   ========================================================================= */
const MAP_SIZE = 150;
const mapBg = document.createElement('canvas');
mapBg.width = mapBg.height = MAP_SIZE;
{
  const g = mapBg.getContext('2d');
  for (let py = 0; py < MAP_SIZE; py++) {
    for (let px = 0; px < MAP_SIZE; px++) {
      const x = (px / (MAP_SIZE - 1) - 0.5) * 160;
      const z = (py / (MAP_SIZE - 1) - 0.5) * 160;
      const h = heightAt(x, z);
      let col;
      if (h < -1.2) col = '#2e6d72';
      else if (h < 0.05) col = '#4b9a95';
      else if (h < 0.7) col = '#c9c096';
      else {
        const n = fbm(x * 0.08, z * 0.08);
        col = n > 0.56 ? '#89b673' : n > 0.48 ? '#7aa968' : '#6d9b60';
        if (h > 3.4) col = '#9bb47b';
      }
      g.fillStyle = col;
      g.fillRect(px, py, 1, 1);
    }
  }
}
function worldToMap(x, z) {
  return [MAP_SIZE / 2 + x * 0.92, MAP_SIZE / 2 + z * 0.92];
}
function drawMap() {
  const c = mapCtx, s = MAP_SIZE;
  c.clearRect(0, 0, s, s);
  c.save();
  c.beginPath(); c.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2); c.clip();
  c.drawImage(mapBg, 0, 0, s, s);
  // shrine
  const [sx, sy] = worldToMap(SHRINE.x, SHRINE.z);
  c.save();
  c.translate(sx, sy);
  c.rotate(state.time * 0.3);
  c.fillStyle = state.won ? '#fff3c4' : '#ffd98a';
  c.shadowColor = '#ffd98a'; c.shadowBlur = state.won ? 12 : 6;
  c.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 ? 2.4 : 5.4;
    const a = i / 8 * Math.PI * 2;
    c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  c.closePath(); c.fill();
  c.restore();
  // shards
  for (const sh of shards) {
    if (sh.got) continue;
    const [mx, my] = worldToMap(sh.group.position.x, sh.group.position.z);
    c.fillStyle = '#8ef0de';
    c.beginPath(); c.moveTo(mx, my - 3); c.lineTo(mx + 2.4, my); c.lineTo(mx, my + 3); c.lineTo(mx - 2.4, my); c.closePath(); c.fill();
  }
  // creatures
  for (const en of enemies) {
    if (!en.alive) continue;
    const [mx, my] = worldToMap(en.g.position.x, en.g.position.z);
    c.fillStyle = en.elder ? '#ffb066' : '#e8846f';
    c.beginPath(); c.arc(mx, my, en.elder ? 2.6 : 2, 0, Math.PI * 2); c.fill();
  }
  // wanderer
  const [px, py] = worldToMap(player.position.x, player.position.z);
  c.save();
  c.translate(px, py);
  c.rotate(Math.atan2(-Math.sin(player.rotation.y), -Math.cos(player.rotation.y)));
  c.fillStyle = '#fff9e3';
  c.shadowColor = '#173136'; c.shadowBlur = 4;
  c.beginPath(); c.moveTo(0, -6.5); c.lineTo(4.6, 5.2); c.lineTo(0, 3); c.lineTo(-4.6, 5.2); c.closePath(); c.fill();
  c.restore();
  c.restore();
}

/* =========================================================================
   MAIN LOOP
   ========================================================================= */
let lastTime = performance.now();
let accumulator = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.05, (now - lastTime) / 1000 || 0.016);
  lastTime = now;
  state.time += rawDt;
  state.hitstop = Math.max(0, state.hitstop - rawDt);

  if (state.started) {
    const scaled = rawDt * (state.hitstop > 0 ? 0.16 : 1);
    accumulator += scaled;
    let steps = 0;
    while (accumulator >= FIXED && steps < 6) {
      stepPlayer(FIXED);
      stepEnemies(FIXED);
      accumulator -= FIXED;
      steps++;
    }
    if (steps === 6) accumulator = 0;
  } else {
    accumulator = 0;
    ps.idleTime = state.time;
  }

  animateAvatar(rawDt);
  updateWorld(rawDt);
  updateCamera(rawDt);
  drawMap();
  updateHud();

  renderer.render(scene, camera);
  if (loadingEl && loadingEl.style.opacity !== '0') {
    loadingEl.style.opacity = '0';
    setTimeout(() => loadingEl.remove(), 700);
  }
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.fov = innerWidth < 700 ? 54 : camera.fov;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);

// Small debug surface — handy for verification and tinkering.
window.__whisperwild = {
  state, ps, player, enemies, shards, heightAt, groundAt, camera, scene, renderer,
  activateShrine, collectShard, killEnemy, get camYaw() { return camYaw; }
};
