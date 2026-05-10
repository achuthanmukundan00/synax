/**
 * Scene Builder — Constructs the Transformer architecture visualization.
 *
 * Exports buildScene(profile) → { scene, camera, renderer, composer, refs, controls }
 * where refs contains all animated mesh/material references.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ROLE_PALETTES } from './core-profiles.js';

// ─── Layout constants (scale with profile) ───────────────────────────────

const STACK_LENGTH = 7.2;
const RING_RADIUS = 0.65;
const FIBER_OUTER_RADIUS = 1.1;
const MLP_OFFSET_Z = 0.45;
const KV_GRID_Z = 1.3;

export function buildScene(profile) {
  const p = ROLE_PALETTES[profile.colorRole] || ROLE_PALETTES.neutral;
  const L = profile.layerCount;
  const H = profile.attentionHeads;
  const LAYER_SPACING = STACK_LENGTH / (L - 1);
  const STACK_START = -STACK_LENGTH / 2;
  const STACK_END = STACK_LENGTH / 2;
  const OUTPUT_SURFACE_X = STACK_END + 0.35;
  const TOKEN_COUNT = profile.pulseCount;

  // ─── Container + Renderer ──────────────────────────────────────────────

  const container = document.getElementById('canvas-container');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#010308');
  scene.fog = new THREE.Fog('#010308', 4, 16);

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 24);
  camera.position.set(0, 0.15, 6.5);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  container.appendChild(renderer.domElement);

  // ─── OrbitControls — mouse rotate/zoom/pan ─────────────────────────────

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2.5;
  controls.maxDistance = 18;
  controls.target.set(0, 0, 0);
  controls.update();

  // ─── Post-processing ───────────────────────────────────────────────────

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.35, 0.4, 0.65,
  );
  composer.addPass(bloomPass);

  // ─── Lighting ──────────────────────────────────────────────────────────

  scene.add(new THREE.AmbientLight(0x0a1420, 0.06));

  const keyLight = new THREE.PointLight(0x306080, 0.5, 10);
  keyLight.position.set(0, 2, 3);
  scene.add(keyLight);

  const fillLight = new THREE.PointLight(0x182838, 0.15, 6);
  fillLight.position.set(-2, -1, 1.5);
  scene.add(fillLight);

  const lightRefs = [
    { light: keyLight, baseColor: new THREE.Color('#306080'), baseIntensity: 0.5 },
    { light: fillLight, baseColor: new THREE.Color('#182838'), baseIntensity: 0.15 },
  ];

  // ─── Core Group ────────────────────────────────────────────────────────

  const coreGroup = new THREE.Group();
  scene.add(coreGroup);

  // ─── Fiber directions (precomputed per head per layer) ─────────────────

  const fiberDirs = new Float32Array(L * H * 2);
  for (let l = 0; l < L; l++) {
    for (let h = 0; h < H; h++) {
      const angle = (h / H) * Math.PI * 2 + l * 0.15;
      const idx = (l * H + h) * 2;
      fiberDirs[idx] = Math.cos(angle);
      fiberDirs[idx + 1] = Math.sin(angle);
    }
  }

  // ─── Residual Stream Spine ─────────────────────────────────────────────

  const spineGeo = new THREE.CylinderGeometry(0.04, 0.04, STACK_LENGTH + 0.4, 16, 1);
  spineGeo.rotateZ(Math.PI / 2);
  const spineMat = new THREE.MeshStandardMaterial({
    color: '#204060', emissive: p.spine, emissiveIntensity: 0.8,
    roughness: 0.2, metalness: 0.6,
  });
  const spine = new THREE.Mesh(spineGeo, spineMat);
  coreGroup.add(spine);

  const spineHaloGeo = new THREE.CylinderGeometry(0.09, 0.09, STACK_LENGTH + 0.3, 16, 1);
  spineHaloGeo.rotateZ(Math.PI / 2);
  const spineHalo = new THREE.Mesh(spineHaloGeo, new THREE.MeshBasicMaterial({
    color: p.spine, transparent: true, opacity: 0.06, depthWrite: false,
  }));
  coreGroup.add(spineHalo);

  // ─── Layer Rings (InstancedMesh) ───────────────────────────────────────

  const ringGeo = new THREE.TorusGeometry(RING_RADIUS, 0.015, 12, 48);
  const ringMat = new THREE.MeshStandardMaterial({
    color: p.ring, emissive: p.ring, emissiveIntensity: 0.3,
    roughness: 0.35, metalness: 0.5,
  });
  const ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, L);
  ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const ringDummy = new THREE.Object3D();
  for (let l = 0; l < L; l++) {
    ringDummy.position.set(STACK_START + l * LAYER_SPACING, 0, 0);
    ringDummy.rotation.set(0, Math.PI / 2, 0);
    ringDummy.scale.setScalar(1);
    ringDummy.updateMatrix();
    ringMesh.setMatrixAt(l, ringDummy.matrix);
  }
  ringMesh.instanceMatrix.needsUpdate = true;
  coreGroup.add(ringMesh);

  // ─── Attention Fibers (LineSegments) ───────────────────────────────────

  const totalFibers = L * H;
  const fiberVerts = new Float32Array(totalFibers * 6);
  for (let l = 0; l < L; l++) {
    const x = STACK_START + l * LAYER_SPACING;
    for (let h = 0; h < H; h++) {
      const idx = l * H + h;
      const fi = idx * 2;
      const dy = fiberDirs[fi], dz = fiberDirs[fi + 1];
      fiberVerts[idx * 6]     = x;
      fiberVerts[idx * 6 + 1] = dy * (RING_RADIUS - 0.02);
      fiberVerts[idx * 6 + 2] = dz * (RING_RADIUS - 0.02);
      fiberVerts[idx * 6 + 3] = x;
      fiberVerts[idx * 6 + 4] = dy * FIBER_OUTER_RADIUS;
      fiberVerts[idx * 6 + 5] = dz * FIBER_OUTER_RADIUS;
    }
  }
  const fiberGeo = new THREE.BufferGeometry();
  fiberGeo.setAttribute('position', new THREE.BufferAttribute(fiberVerts, 3));
  const fiberMat = new THREE.LineBasicMaterial({
    color: p.fiber, transparent: true, opacity: 0.26, depthWrite: true,
  });
  const fiberLines = new THREE.LineSegments(fiberGeo, fiberMat);
  coreGroup.add(fiberLines);

  // ─── MLP Slabs (InstancedMesh) ─────────────────────────────────────────

  const mlpGeo = new THREE.BoxGeometry(0.08, 0.55 * profile.mlpWidth, 0.22);
  const mlpMat = new THREE.MeshStandardMaterial({
    color: p.mlp, emissive: p.mlp, emissiveIntensity: 0.15,
    roughness: 0.5, metalness: 0.3,
  });
  const mlpMesh = new THREE.InstancedMesh(mlpGeo, mlpMat, L);
  mlpMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  for (let l = 0; l < L; l++) {
    ringDummy.position.set(STACK_START + l * LAYER_SPACING, 0, MLP_OFFSET_Z);
    ringDummy.rotation.set(0, 0, 0);
    ringDummy.scale.setScalar(0.9 + (l % 3) * 0.05);
    ringDummy.updateMatrix();
    mlpMesh.setMatrixAt(l, ringDummy.matrix);
  }
  mlpMesh.instanceMatrix.needsUpdate = true;
  coreGroup.add(mlpMesh);

  // ─── Attention-Head Micro-Elements (InstancedMesh) ─────────────────────

  const headDotGeo = new THREE.BoxGeometry(0.03, 0.015, 0.015);
  const headDotMat = new THREE.MeshStandardMaterial({
    color: p.fiber, emissive: p.fiber, emissiveIntensity: 0.2,
    roughness: 0.4, metalness: 0.4,
  });
  const headDotCount = L * H;
  const headDotMesh = new THREE.InstancedMesh(headDotGeo, headDotMat, headDotCount);
  headDotMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  for (let l = 0; l < L; l++) {
    const x = STACK_START + l * LAYER_SPACING;
    for (let h = 0; h < H; h++) {
      const idx = l * H + h;
      const dy = fiberDirs[idx * 2], dz = fiberDirs[idx * 2 + 1];
      const midR = RING_RADIUS + (FIBER_OUTER_RADIUS - RING_RADIUS) * 0.55;
      ringDummy.position.set(x, dy * midR, dz * midR);
      ringDummy.rotation.set(0, 0, 0);
      ringDummy.scale.setScalar(0.5 + (h % 3) * 0.2);
      ringDummy.updateMatrix();
      headDotMesh.setMatrixAt(idx, ringDummy.matrix);
    }
  }
  headDotMesh.instanceMatrix.needsUpdate = true;
  coreGroup.add(headDotMesh);

  // ─── Neuron Clusters (zoom LOD — visible when camera close) ────────────

  const NEURONS_PER_HEAD = 6;
  const neuronCount = headDotCount * NEURONS_PER_HEAD;
  const neuronGeo = new THREE.SphereGeometry(0.008, 4, 4);
  const neuronMat = new THREE.MeshBasicMaterial({
    color: p.fiber, transparent: true, opacity: 0.0, depthWrite: false,
  });
  const neuronMesh = new THREE.InstancedMesh(neuronGeo, neuronMat, neuronCount);
  neuronMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Initially invisible — material opacity animates with zoom

  for (let l = 0; l < L; l++) {
    const x = STACK_START + l * LAYER_SPACING;
    for (let h = 0; h < H; h++) {
      const headIdx = l * H + h;
      const dy = fiberDirs[headIdx * 2], dz = fiberDirs[headIdx * 2 + 1];
      const midR = RING_RADIUS + (FIBER_OUTER_RADIUS - RING_RADIUS) * 0.55;
      const cx = x, cy = dy * midR, cz = dz * midR;
      for (let n = 0; n < NEURONS_PER_HEAD; n++) {
        const ni = headIdx * NEURONS_PER_HEAD + n;
        const angle = (n / NEURONS_PER_HEAD) * Math.PI * 2;
        const r = 0.025;
        ringDummy.position.set(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r * 0.5, cz + (n % 3 - 1) * 0.015);
        ringDummy.scale.setScalar(0.6 + Math.random() * 0.4);
        ringDummy.updateMatrix();
        neuronMesh.setMatrixAt(ni, ringDummy.matrix);
      }
    }
  }
  neuronMesh.instanceMatrix.needsUpdate = true;
  coreGroup.add(neuronMesh);

  // ─── KV Cache Lattice ──────────────────────────────────────────────────

  const kvCols = 28, kvRows = 10;
  const kvWidth = STACK_LENGTH + 0.8, kvHeight = 2.0;
  const kvVerts = [];
  for (let c = 0; c <= kvCols; c++) {
    const x = STACK_START - 0.4 + (c / kvCols) * kvWidth;
    kvVerts.push(x, -kvHeight / 2, KV_GRID_Z, x, kvHeight / 2, KV_GRID_Z);
  }
  for (let r = 0; r <= kvRows; r++) {
    const y = -kvHeight / 2 + (r / kvRows) * kvHeight;
    kvVerts.push(STACK_START - 0.4, y, KV_GRID_Z, STACK_START - 0.4 + kvWidth, y, KV_GRID_Z);
  }
  const kvGeo = new THREE.BufferGeometry();
  kvGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(kvVerts), 3));
  const kvMat = new THREE.LineBasicMaterial({
    color: p.kv, transparent: true, opacity: 0.13, depthWrite: true,
  });
  coreGroup.add(new THREE.LineSegments(kvGeo, kvMat));

  // ─── Output / Logit Surface ────────────────────────────────────────────

  const outputGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.03, 32);
  outputGeo.rotateZ(Math.PI / 2);
  const outputMat = new THREE.MeshStandardMaterial({
    color: '#204060', emissive: p.spine, emissiveIntensity: 0.35,
    roughness: 0.2, metalness: 0.7,
  });
  const outputSurface = new THREE.Mesh(outputGeo, outputMat);
  outputSurface.position.set(OUTPUT_SURFACE_X, 0, 0);
  coreGroup.add(outputSurface);

  const outputHalo = new THREE.Mesh(
    new THREE.TorusGeometry(0.6, 0.008, 8, 48),
    new THREE.MeshBasicMaterial({ color: p.spine, transparent: true, opacity: 0.18, depthWrite: false }),
  );
  outputHalo.position.set(OUTPUT_SURFACE_X, 0, 0);
  outputHalo.rotation.set(0, Math.PI / 2, 0);
  coreGroup.add(outputHalo);

  // ─── Token Pulses ──────────────────────────────────────────────────────

  const tokenProgress = new Float32Array(TOKEN_COUNT);
  const tokenPositions = new Float32Array(TOKEN_COUNT * 3);
  for (let i = 0; i < TOKEN_COUNT; i++) {
    tokenProgress[i] = Math.random();
    tokenPositions[i * 3] = STACK_START + tokenProgress[i] * STACK_LENGTH;
  }
  const tokenGeo = new THREE.BufferGeometry();
  tokenGeo.setAttribute('position', new THREE.BufferAttribute(tokenPositions, 3));
  const tokenMat = new THREE.PointsMaterial({
    size: 0.05, color: p.pulse, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const tokenPoints = new THREE.Points(tokenGeo, tokenMat);
  coreGroup.add(tokenPoints);

  // ─── Faint framing arcs ────────────────────────────────────────────────

  for (let i = 0; i < 2; i++) {
    const arc = new THREE.Mesh(
      new THREE.TorusGeometry(1.4 + i * 0.3, 0.002, 8, 64, Math.PI * 1.3),
      new THREE.MeshBasicMaterial({ color: p.kv, transparent: true, opacity: 0.06, depthWrite: false }),
    );
    arc.rotation.set(Math.PI / 2.5 + i * 0.5, 0, 0);
    coreGroup.add(arc);
  }

  // ─── Background specks ─────────────────────────────────────────────────

  const bgCount = 50;
  const bgPos = new Float32Array(bgCount * 3);
  for (let i = 0; i < bgCount; i++) {
    bgPos[i * 3] = (Math.random() - 0.5) * 10;
    bgPos[i * 3 + 1] = (Math.random() - 0.5) * 6;
    bgPos[i * 3 + 2] = -2 - Math.random() * 5;
  }
  const bgGeo = new THREE.BufferGeometry();
  bgGeo.setAttribute('position', new THREE.BufferAttribute(bgPos, 3));
  scene.add(new THREE.Points(bgGeo, new THREE.PointsMaterial({
    size: 0.012, color: p.kv, transparent: true, opacity: 0.18, depthWrite: false,
  })));

  // ─── Assemble refs ─────────────────────────────────────────────────────

  const refs = {
    coreGroup,
    spine,
    spineMat,
    spineHalo,
    ringMesh,
    ringMat,
    ringDummy,
    ringGeo,
    ringCount: L,
    mlpMesh,
    mlpMat,
    mlpGeo,
    fiberLines,
    fiberMat,
    fiberGeo,
    headDotMesh,
    headDotMat,
    headDotCount,
    neuronMesh,
    neuronMat,
    neuronCount,
    NEURONS_PER_HEAD,
    kvMat,
    outputSurface,
    outputMat,
    tokenPoints,
    tokenMat,
    tokenGeo,
    tokenProgress,
    tokenCount: TOKEN_COUNT,
    fiberDirs,
    lightRefs,
    L,
    H,
    LAYER_SPACING,
    STACK_START,
    STACK_END,
    FIBER_OUTER_RADIUS,
    RING_RADIUS,
    MLP_OFFSET_Z,
    OUTPUT_SURFACE_X,
  };

  return { scene, camera, renderer, composer, controls, bloomPass, refs };
}
