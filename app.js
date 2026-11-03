import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const canvas = document.getElementById('stage');
const status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
const key = new THREE.DirectionalLight(0xfff4e8, 2.6);
key.position.set(1.2, 2.0, 1.4);
const rim = new THREE.DirectionalLight(0xbfd2ff, 2.2);
rim.position.set(-1.5, 1.2, -1.6);
const fill = new THREE.HemisphereLight(0xb8c4d6, 0x2a2622, 0.6);
scene.add(key, rim, fill);

const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 20);
const VIEWS = [
  { pos: [0.62, 0.30, 0.95], at: [0, 0.15, 0.0] },   // front three-quarter
  { pos: [1.10, 0.22, 0.05], at: [0, 0.15, 0.0] },   // side
  { pos: [0.75, 0.75, -0.85], at: [0, 0.14, -0.05] }, // high rear
];
let viewIndex = 0;
let spreadAmt = 0;
const camAt = new THREE.Vector3(), camOffset = new THREE.Vector3();
function setView(i) {
  viewIndex = i;
  frameCamera();
}
function frameCamera() {
  // pull back as the wings open so a 1 m span stays in frame
  const v = VIEWS[viewIndex];
  camAt.set(...v.at).y += 0.04 * spreadAmt;
  camOffset.set(...v.pos).sub(new THREE.Vector3(...v.at)).multiplyScalar(1 + 1.15 * spreadAmt);
  camera.position.copy(camAt).add(camOffset);
  camera.lookAt(camAt);
}
setView(0);

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

// ------------------------------------------------------------------ model
const MODEL = new URLSearchParams(location.search).get('model') || './raven.pack.glb';
const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(MODEL, (e) => {
  if (e.total) status.textContent = `loading ${(100 * e.loaded / e.total).toFixed(0)}%`;
});
const raven = gltf.scene;
scene.add(raven);
raven.traverse((o) => {
  if (!o.isMesh) return;
  o.frustumCulled = false;
  // The room environment over-lights the keratin compared with Blender renders.
  if (o.material.name === 'BeakLegs') o.material.envMapIntensity = 0.45;
});

const mixer = new THREE.AnimationMixer(raven);
const clip = (name) => gltf.animations.find((a) => a.name === name);
const toFold = mixer.clipAction(clip('SpreadToFold'));
const toSpread = mixer.clipAction(clip('FoldToSpread'));
for (const a of [toFold, toSpread]) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }

let wings = 'folded';
let queue = [];
function play(action, speed = 1) {
  for (const a of [toFold, toSpread]) if (a !== action) a.stop();
  action.reset();
  action.timeScale = speed;
  action.play();
}
// start perched: jump to the end of the fold
play(toFold);
toFold.time = toFold.getClip().duration;
mixer.addEventListener('finished', (e) => {
  wings = e.action === toFold ? 'folded' : 'spread';
  const next = queue.shift();
  if (next) setTimeout(next, 900);
});
function spread() { if (wings !== 'spread') { wings = 'moving'; play(toSpread, 1.0); } }
function fold() { if (wings !== 'folded') { wings = 'moving'; play(toFold, 0.9); } }
document.getElementById('spread').onclick = () => { queue = []; spread(); };
document.getElementById('fold').onclick = () => { queue = []; fold(); };
document.getElementById('stretch').onclick = () => { if (wings === 'folded') { queue = [fold]; spread(); } };
document.getElementById('view').onclick = () => setView((viewIndex + 1) % VIEWS.length);

// ------------------------------------------------------------------ bill
// The source sculpt has an open bill. The jaw bone is not keyed in any clip; this sets it each frame.
const jaw = raven.getObjectByName('jaw');
const jawRest = jaw.quaternion.clone();
let JAW_CLOSED = THREE.MathUtils.degToRad(13); // fitted: cutting edges meet within 1 mm
const qJaw = new THREE.Quaternion();
let cawUntil = 0;
function caw() { cawUntil = performance.now() + 900; }
document.getElementById('caw').onclick = caw;
function updateJaw(now) {
  // two quick pulses while cawing, closed otherwise
  const t = cawUntil - now;
  const open = t > 0 ? Math.max(0, Math.sin((1 - t / 900) * Math.PI * 2)) : 0;
  qJaw.setFromAxisAngle(new THREE.Vector3(1, 0, 0), JAW_CLOSED * (1 - open) - THREE.MathUtils.degToRad(6) * open);
  jaw.quaternion.copy(jawRest).multiply(qJaw);
}

// ------------------------------------------------------------------ gaze
const find = (n) => raven.getObjectByName(n);
const chain = [[find('neck_01'), 0.25], [find('neck_02'), 0.30], [find('head'), 0.45]];
const pointer = new THREE.Vector2(0, 0);
let lastMove = -1e9;
addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  lastMove = performance.now();
});

const ray = new THREE.Raycaster();
const plane = new THREE.Plane();
const headPos = new THREE.Vector3();
const target = new THREE.Vector3();
const local = new THREE.Vector3();
let yaw = 0, pitch = 0, wanderYaw = 0, wanderPitch = 0, nextWander = 0;
let inspect = 'front', nextInspect = 0, gazeActive = false;
const EYE_YAW_OFFSET = THREE.MathUtils.degToRad(55);
const qYaw = new THREE.Quaternion(), qPitch = new THREE.Quaternion(), qd = new THREE.Quaternion();
const qParent = new THREE.Quaternion(), qParentInv = new THREE.Quaternion(), qPart = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
const clamp = THREE.MathUtils.clamp;

function updateGaze(dt, now) {
  const head = chain[2][0];
  head.getWorldPosition(headPos);
  let ty, tp;
  if (now - lastMove < 4000) {
    // pointer target on a plane facing the camera, between the head and the camera
    const toCam = camera.position.clone().sub(headPos);
    plane.setFromNormalAndCoplanarPoint(toCam.clone().normalize(), headPos.clone().addScaledVector(toCam, 0.6));
    ray.setFromCamera(pointer, camera);
    if (!ray.ray.intersectPlane(plane, target)) return;
    gazeActive = true;
    local.copy(target).sub(headPos);
    raven.worldToLocal(local.add(raven.position));
    ty = Math.atan2(local.x, local.z);
    tp = Math.atan2(local.y, Math.hypot(local.x, local.z));
  } else {
    // idle: occasional glances like a watchful bird
    if (now > nextWander) {
      wanderYaw = (Math.random() * 2 - 1) * 1.0;
      wanderPitch = (Math.random() * 2 - 1) * 0.25;
      nextWander = now + 1500 + Math.random() * 3000;
    }
    ty = wanderYaw; tp = wanderPitch;
    gazeActive = false;
  }
  // Raven eyes face ~68 degrees off the bill line and move only ~11 degrees, so to inspect
  // something the bird turns its head and puts one eye on it. Alternate eye and frontal looks.
  const active = now - lastMove < 4000;
  if (now > nextInspect) {
    const r = Math.random(), side = ty > 0 ? 'L' : 'R', other = side === 'L' ? 'R' : 'L';
    inspect = !active ? 'front' : r < 0.35 ? 'front' : r < 0.8 ? side : other;
    nextInspect = now + 1800 + Math.random() * 3200;
  }
  if (inspect === 'L') ty -= EYE_YAW_OFFSET;
  if (inspect === 'R') ty += EYE_YAW_OFFSET;
  ty = clamp(ty, -1.35, 1.35);
  tp = clamp(tp, -0.6, 0.55);
  const k = 1 - Math.exp(-dt * 7);
  yaw += (ty - yaw) * k;
  pitch += (tp - pitch) * k;
  qYaw.setFromAxisAngle(Y, yaw);
  qPitch.setFromAxisAngle(X, -pitch);
  qd.multiplyQuaternions(qYaw, qPitch);
  for (const link of chain) {
    const [bone, w] = link;
    // A paused or finished clip stops rewriting these bones, so undo last frame's offset ourselves.
    if (link.out && bone.quaternion.equals(link.out)) bone.quaternion.copy(link.base);
    link.base = (link.base || new THREE.Quaternion()).copy(bone.quaternion);
    bone.parent.updateWorldMatrix(true, false);
    bone.parent.getWorldQuaternion(qParent);
    qParentInv.copy(qParent).invert();
    qPart.identity().slerp(qd, w);
    // world-space delta -> bone local space
    bone.quaternion.premultiply(qParent).premultiply(qPart).premultiply(qParentInv);
    link.out = (link.out || new THREE.Quaternion()).copy(bone.quaternion);
  }
}

// ------------------------------------------------------------------ eyes
// Bounded look-at, adapted from web/eye-tracking.js: ravens move each eye about 11 degrees
// (22.2 degrees between extremes, Troscianko et al. 2012). The eye bone's rest +Y is the axis
// through the lid opening, and the pupil is built on that axis.
const EYE_MAX = THREE.MathUtils.degToRad(11);
const eyes = ['L', 'R'].map((s) => {
  const bone = raven.getObjectByName(`eye${s}`) || raven.getObjectByName(`eye.${s}`);
  const rest = bone.quaternion.clone();
  return { bone, rest, neutral: Y.clone().applyQuaternion(rest), cur: new THREE.Quaternion() };
});
const eyePos = new THREE.Vector3(), eyeDir = new THREE.Vector3(), qHead = new THREE.Quaternion(), qGoal = new THREE.Quaternion();
function updateEyes(dt) {
  for (const e of eyes) {
    e.bone.quaternion.copy(e.rest);
    e.bone.parent.updateWorldMatrix(true, false);
    e.bone.parent.getWorldQuaternion(qHead);
    let goal = qGoal.identity();
    if (gazeActive) {
      e.bone.updateWorldMatrix(false, false);
      e.bone.getWorldPosition(eyePos);
      eyeDir.copy(target).sub(eyePos).applyQuaternion(qHead.invert()).normalize();
      goal = new THREE.Quaternion().rotateTowards(qGoal.setFromUnitVectors(e.neutral, eyeDir), EYE_MAX);
    }
    e.cur.slerp(goal, 1 - Math.exp(-dt / 0.06));
    e.bone.quaternion.copy(e.cur).multiply(e.rest);
  }
}

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
let fpsT = 0, frames = 0;
status.textContent = '';
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  mixer.update(dt);
  const amt = toSpread.isRunning() || (toSpread.enabled && wings === 'spread')
    ? toSpread.time / toSpread.getClip().duration
    : 1 - toFold.time / toFold.getClip().duration;
  spreadAmt += (THREE.MathUtils.clamp(amt, 0, 1) - spreadAmt) * (1 - Math.exp(-dt * 4));
  frameCamera();
  updateGaze(dt, now);
  updateEyes(dt);
  updateJaw(now);
  renderer.render(scene, camera);
  frames++; fpsT += dt;
  if (fpsT > 1) { status.textContent = `${frames} fps`; frames = 0; fpsT = 0; }
});
window.__raven = { raven, mixer, camera, spread, fold, renderer, scene, setView, updateGaze, updateEyes, updateJaw, caw, THREE, eyes, getInspect: () => inspect, setJawClosed: (d) => { JAW_CLOSED = THREE.MathUtils.degToRad(d); }, setInspect: (v) => { inspect = v; nextInspect = performance.now() + 1e9; }, setSpreadAmt: (v) => { spreadAmt = v; frameCamera(); } };

