/**
 * Shoggoth Core Morphology — Three.js observer for Synax.
 *
 * Adapted from the Synax Core Morphology experiments in
 * ~/workspace/git/achu-portfolio/src/components/three/SynaxAICore.tsx
 * and ~/workspace/git/achu-portfolio/src/components/experiments/SynaxCoreMorphology.tsx
 *
 * Renders a living AI core that reacts to telemetry events:
 * - idle → slow breathing, calm containment field
 * - thinking → active particles, brighter nucleus
 * - streaming → pulsing flow, shimmering rings
 * - tool_pending → amber tinge, tension buildup
 * - tool_running → amber scan lines, compressed field
 * - suspicious → red-tinged, alert ripples
 * - error → rapid pulse, red warning glow
 * - completed → green calm pulse, settled field
 * - blocked → amber/orange waiting state
 */

import * as THREE from 'three';

// ─── Constants ────────────────────────────────────────────────────────────

const PHASE_COLORS = {
  idle:        { primary: '#3a6db0', secondary: '#5a85b8', emissive: '#1a3a5a' },
  thinking:    { primary: '#4a80c4', secondary: '#6a9ad4', emissive: '#1a3a6a' },
  streaming:   { primary: '#539c6c', secondary: '#73bc8c', emissive: '#1a3a2a' },
  tool_running:{ primary: '#be8536', secondary: '#dea554', emissive: '#3a2810' },
  error:       { primary: '#b74134', secondary: '#d76154', emissive: '#3a1010' },
  completed:   { primary: '#539c6c', secondary: '#73bc8c', emissive: '#1a2a1a' },
  blocked:     { primary: '#be8536', secondary: '#dea554', emissive: '#3a2810' },
};

// ─── Global state ─────────────────────────────────────────────────────────

let currentPhase = 'idle';
let phaseTargetTime = 0;
let lastToolSeverity = 'normal';
let nucleusRef = null;
let containmentRef = null;
let particlesRef = null;
let scanLineRef = null;
let coreGroupRef = null;
let ringSegments = [];
let ringMaterials = [];
let severityPulse = 0;
let targetSeverityPulse = 0;

// ─── Three.js Setup ───────────────────────────────────────────────────────

const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#03080f');
scene.fog = new THREE.Fog('#03080f', 5, 12);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 20);
camera.position.set(0, 0, 6.5);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

// ─── Lighting ─────────────────────────────────────────────────────────────

scene.add(new THREE.AmbientLight(0x222233, 0.15));
const light1 = new THREE.PointLight(0x7fffd1, 1.2);
light1.position.set(3, 2, 4);
scene.add(light1);

const light2 = new THREE.PointLight(0xffffff, 0.4);
light2.position.set(-3, -1.5, 2);
scene.add(light2);

const light3 = new THREE.PointLight(0xffffff, 0.6);
light3.position.set(0, -3, 1);
scene.add(light3);

// ─── Core Group ───────────────────────────────────────────────────────────

const coreGroup = new THREE.Group();
scene.add(coreGroup);
coreGroupRef = coreGroup;

// ─── Outer Containment Rings ──────────────────────────────────────────────

const ringCount = 3;
const rings = [];
for (let i = 0; i < ringCount; i++) {
  const geo = new THREE.TorusGeometry(1.4 + i * 0.25, 0.01 + i * 0.005, 16, 80);
  const mat = new THREE.MeshBasicMaterial({
    color: i === 0 ? '#7fffd1' : '#ffffff',
    transparent: true,
    opacity: 0.35 - i * 0.08,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.set(Math.PI / (2.2 + i * 0.3), i * Math.PI / 8, i * Math.PI / 12);
  coreGroup.add(mesh);
  rings.push({ mesh, mat, baseOpacity: mat.opacity, index: i });
}

// ─── Inner Field Ring Segments ────────────────────────────────────────────

const totalSegments = 28;
for (let i = 0; i < totalSegments; i++) {
  const angle = (i / totalSegments) * Math.PI * 2;
  const length = 0.12 + (i % 3) * 0.06;
  const radius = 1.18;
  const x = Math.cos(angle) * radius;
  const y = Math.sin(angle) * radius;

  const geo = new THREE.BoxGeometry(length, 0.02, 0.015);
  const mat = new THREE.MeshBasicMaterial({
    color: i % 3 === 0 ? '#ffffff' : '#7fffd1',
    transparent: true,
    opacity: i % 4 === 0 ? 0.5 : 0.25,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, 0);
  mesh.rotation.set(0, 0, angle + Math.PI / 2);
  coreGroup.add(mesh);
  ringSegments.push({ mesh, mat, baseOpacity: mat.opacity, angle, index: i });
  ringMaterials.push(mat);
}

// ─── Nucleus ──────────────────────────────────────────────────────────────

const nucleusGeo = new THREE.OctahedronGeometry(0.3, 1);
const nucleusMat = new THREE.MeshStandardMaterial({
  color: '#0a1a14',
  emissive: '#7fffd1',
  emissiveIntensity: 0.55,
  roughness: 0.18,
  metalness: 0.75,
  flatShading: true,
});
const nucleus = new THREE.Mesh(nucleusGeo, nucleusMat);
nucleus.rotation.set(0.5, 0.3, 1.2);
coreGroup.add(nucleus);
nucleusRef = nucleus;

// Nucleus halo
const haloGeo = new THREE.SphereGeometry(0.42, 16, 16);
const haloMat = new THREE.MeshBasicMaterial({ color: '#7fffd1', transparent: true, opacity: 0.06 });
const halo = new THREE.Mesh(haloGeo, haloMat);
coreGroup.add(halo);

// ─── Scan Line ────────────────────────────────────────────────────────────

const scanLineGeo = new THREE.BoxGeometry(3.8, 0.012, 0.012);
const scanLineMat = new THREE.MeshBasicMaterial({ color: '#7fffd1', transparent: true, opacity: 0.14 });
const scanLine = new THREE.Mesh(scanLineGeo, scanLineMat);
scanLine.position.set(0, 0, 0.15);
coreGroup.add(scanLine);
scanLineRef = scanLine;

// ─── Vertical Bars ────────────────────────────────────────────────────────

for (let i = 0; i < 5; i++) {
  const x = -1.2 + i * 0.6;
  const barGeo = new THREE.BoxGeometry(0.008, 2.8, 0.008);
  const barMat = new THREE.MeshBasicMaterial({
    color: '#7fffd1',
    transparent: true,
    opacity: 0.08 + Math.abs(i - 2) * 0.02,
  });
  const bar = new THREE.Mesh(barGeo, barMat);
  bar.position.set(x, 0, -0.05);
  coreGroup.add(bar);
}

// ─── Particle Field ───────────────────────────────────────────────────────

const particleCount = 200;
const particlePositions = new Float32Array(particleCount * 3);
const particleSizes = new Float32Array(particleCount);

for (let i = 0; i < particleCount; i++) {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const radius = 1.4 + Math.random() * 1.2;
  particlePositions[i * 3] = Math.sin(phi) * Math.cos(theta) * radius;
  particlePositions[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * radius * 0.7;
  particlePositions[i * 3 + 2] = Math.cos(phi) * radius * 0.5;
  particleSizes[i] = Math.random() * 3 + 0.5;
}

const particleGeo = new THREE.BufferGeometry();
particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
particleGeo.setAttribute('size', new THREE.BufferAttribute(particleSizes, 1));

const particleMat = new THREE.PointsMaterial({
  color: '#7fffd1',
  size: 0.025,
  transparent: true,
  opacity: 0.5,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const particles = new THREE.Points(particleGeo, particleMat);
scene.add(particles);
particlesRef = particles;

// ─── Background Specks ────────────────────────────────────────────────────

for (let i = 0; i < 30; i++) {
  const a = (i / 30) * Math.PI * 2;
  const r = 3.5 + (i % 3) * 0.8;
  const speckGeo = new THREE.SphereGeometry(0.02, 4, 4);
  const speckMat = new THREE.MeshBasicMaterial({ color: '#7fffd1', transparent: true, opacity: 0.15 });
  const speck = new THREE.Mesh(speckGeo, speckMat);
  speck.position.set(Math.cos(a + i * 0.3) * r, Math.sin(a + i * 0.3) * r * 0.6, -1 - (i % 4) * 0.25);
  scene.add(speck);
}

// ─── Animation ────────────────────────────────────────────────────────────

const clock = new THREE.Clock();

function getPhaseColor(phase) {
  return PHASE_COLORS[phase] ?? PHASE_COLORS.idle;
}

function animate() {
  requestAnimationFrame(animate);

  const t = clock.getElapsedTime();
  const delta = Math.min(clock.getDelta(), 0.1);
  const phaseColor = getPhaseColor(currentPhase);

  // Smooth severity pulse
  severityPulse += (targetSeverityPulse - severityPulse) * 0.05;

  // ── Core breathing ──
  const breathBase = Math.sin(t * (currentPhase === 'error' ? 1.8 : currentPhase === 'tool_running' ? 0.6 : 0.7));
  const breathAmplitude = currentPhase === 'error'
    ? 0.04 + Math.abs(breathBase) * 0.03
    : 0.025 + breathBase * 0.015;

  coreGroup.scale.setScalar(1 + Math.sin(t * 0.7) * breathAmplitude);
  coreGroup.rotation.y += delta * (currentPhase === 'tool_running' ? 0.18 : 0.12);
  coreGroup.rotation.z += delta * 0.05;

  // ── Nucleus ──
  const pulse = 1 + Math.sin(t * (currentPhase === 'error' ? 2.6 : 1.3)) * 0.06;
  nucleus.scale.setScalar(pulse);
  nucleusMat.emissive.set(new THREE.Color(phaseColor.emissive + severityPulse > 0.5 ? '#ff4030' : phaseColor.emissive));

  // Merge severity tint into emissive
  const emissiveIntensity = 0.55 + Math.sin(t * 1.3) * 0.2 + severityPulse * 0.3;
  nucleusMat.emissiveIntensity = Math.min(emissiveIntensity, 1.2);

  if (severityPulse > 0.3) {
    nucleusMat.emissive.set(new THREE.Color('#ff3020'));
    nucleusMat.emissiveIntensity = 0.5 + severityPulse;
  }

  // ── Scan line ──
  scanLine.position.y = ((t * (currentPhase === 'tool_running' ? 0.6 : 0.25)) % 2.8) - 1.4;
  scanLineMat.opacity = 0.12 + Math.abs(Math.sin(t * 2)) * 0.08 + severityPulse * 0.05;

  // ── Ring color shifting ──
  for (const [i, mat] of ringMaterials.entries()) {
    const targetColor = new THREE.Color(
      i % 3 === 0 ? phaseColor.secondary : phaseColor.primary
    );
    const currentColor = new THREE.Color(mat.color);
    currentColor.lerp(targetColor, 0.02);
    mat.color.set(currentColor);

    if (severityPulse > 0.3 && i % 2 === 0) {
      mat.color.lerp(new THREE.Color('#ff4030'), 0.03);
    }
  }

  // Ring opacity pulsing
  for (const ring of rings) {
    ring.mat.opacity = ring.baseOpacity + Math.sin(t * 1.2 + ring.index) * 0.03 + severityPulse * 0.03;
  }

  // Segment flash during tool calls
  for (const seg of ringSegments) {
    const toolFlash = currentPhase === 'tool_running' ? 0.08 : 0;
    seg.mat.opacity = seg.baseOpacity + toolFlash * Math.abs(Math.sin(t * 4 + seg.index * 0.3));
  }

  // ── Particles ──
  particles.rotation.y += delta * 0.08;
  particles.rotation.z += delta * 0.05;
  particleMat.opacity = 0.5 - severityPulse * 0.15 + (currentPhase === 'thinking' ? 0.1 : 0);

  // Severity glow on particle color
  if (severityPulse > 0.3) {
    particleMat.color.lerp(new THREE.Color('#ff6040'), 0.05);
  } else {
    particleMat.color.lerp(new THREE.Color('#7fffd1'), 0.02);
  }

  // ── Lights ──
  if (currentPhase === 'error' || severityPulse > 0.5) {
    light1.color.lerp(new THREE.Color('#ff4030'), 0.04);
  } else {
    const targetLightColor = new THREE.Color(phaseColor.primary);
    light1.color.lerp(targetLightColor, 0.03);
  }

  renderer.render(scene, camera);
}

// ─── SSE Connection ───────────────────────────────────────────────────────

const eventSource = new EventSource('/events');
const transcriptEl = document.getElementById('transcript-overlay');
const toolNotificationsEl = document.getElementById('tool-notifications');
const statusDot = document.getElementById('status-dot');
const phaseLabel = document.getElementById('phase-label');
const budgetBar = document.getElementById('budget-bar');
const clearBtn = document.getElementById('clear-btn');
let transcriptLines = [];
let toolToastTimers = new Map();

clearBtn.addEventListener('click', () => {
  transcriptLines = [];
  transcriptEl.innerHTML = '';
  toolNotificationsEl.innerHTML = '';
});

eventSource.addEventListener('message', (event) => {
  try {
    const data = JSON.parse(event.data);
    handleObserverEvent(data);
  } catch {
    // ignore parse errors
  }
});

eventSource.addEventListener('error', () => {
  statusDot.className = 'idle';
  phaseLabel.textContent = 'DISCONNECTED';
});

function handleObserverEvent(event) {
  // Update phase
  if (event.phase && event.phase !== currentPhase) {
    currentPhase = event.phase;
    phaseTargetTime = performance.now();

    // Update status dot and label
    statusDot.className = event.phase;
    let label = event.phase.toUpperCase();
    if (event.tool?.severity === 'suspicious') label = '⚠ ' + label;
    if (event.tool?.severity === 'attention') label = '⚡ ' + label;
    phaseLabel.textContent = label;
  }

  // Severity pulse
  if (event.severity === 'suspicious') {
    targetSeverityPulse = 0.8;
  } else if (event.severity === 'attention') {
    targetSeverityPulse = 0.35;
  } else if (currentPhase === 'error') {
    targetSeverityPulse = 0.6;
  } else {
    targetSeverityPulse = 0;
  }

  // Handle tool notifications
  if (event.tool) {
    if (event.type === 'tool_call_started') {
      addToolToast(event);
    } else if (event.type === 'tool_call_finished' || event.type === 'tool_call_failed') {
      updateToolToast(event);
    }
  }

  // Handle transcript / notes
  if (event.text && (
    event.type === 'model_note' ||
    event.type === 'assistant_delta' ||
    event.type === 'session_started' ||
    event.type === 'session_finished' ||
    event.type === 'error'
  )) {
    appendTranscript(event);
  }

  // Budget bar
  if (event.contextUsedTokens != null && event.contextWindowTokens != null && event.contextWindowTokens > 0) {
    const pct = Math.min(100, (event.contextUsedTokens / event.contextWindowTokens) * 100);
    budgetBar.style.width = pct + '%';
    if (pct > 80) budgetBar.style.background = 'rgba(183, 65, 52, 0.5)';
    else if (pct > 60) budgetBar.style.background = 'rgba(190, 133, 54, 0.5)';
    else budgetBar.style.background = 'rgba(58, 109, 176, 0.5)';
  }

  // Session finish — fade severity
  if (event.type === 'session_finished') {
    targetSeverityPulse = 0;
  }
}

// ─── Transcript ───────────────────────────────────────────────────────────

const MAX_TRANSCRIPT_LINES = 50;

function appendTranscript(event) {
  let text = event.text?.slice(0, 300) ?? '';
  if (!text.trim()) return;

  // Clean up think blocks
  text = text.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '').trim();
  if (!text) return;

  const line = document.createElement('div');
  line.className = 'note-line';
  if (event.type === 'session_started' || event.type === 'session_finished') {
    line.classList.add('session');
    line.innerHTML = `<span class="glyph">◆</span>${escapeHtml(text)}`;
  } else {
    line.innerHTML = `<span class="glyph">✽</span>${escapeHtml(text)}`;
  }

  transcriptEl.appendChild(line);
  transcriptLines.push(line);

  // Trim old lines
  while (transcriptLines.length > MAX_TRANSCRIPT_LINES) {
    const old = transcriptLines.shift();
    if (old) old.remove();
  }

  // Auto-scroll
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ─── Tool Toasts ──────────────────────────────────────────────────────────

function addToolToast(event) {
  const tool = event.tool;
  const id = 'tool-' + event.id + '-' + tool.name;

  const toast = document.createElement('div');
  toast.className = `tool-toast severity-${tool.severity}`;
  toast.id = id;
  toast.innerHTML = `
    <div class="tool-name">${escapeHtml(tool.name)}</div>
    <div class="tool-summary">${escapeHtml(tool.summary?.slice(0, 100) ?? '')}</div>
    <div class="tool-meta">
      <span class="severity-badge">${tool.severity.toUpperCase()}</span>
      <span>${new Date(tool.timestamp).toLocaleTimeString()}</span>
      <span>${tool.status.toUpperCase()}</span>
    </div>
  `;

  toolNotificationsEl.appendChild(toast);

  // Auto-remove after 8s for normal tools, 15s for attention/suspicious
  const duration = tool.severity === 'normal' ? 8000 : 15000;
  const timer = setTimeout(() => removeToast(id), duration);
  toolToastTimers.set(id, timer);
}

function updateToolToast(event) {
  // Find and update existing toast or create new one
  const tool = event.tool;
  const existingId = 'tool-' + event.id + '-' + tool.name;
  let toast = document.getElementById(existingId);

  if (toast) {
    const badge = toast.querySelector('.severity-badge');
    if (badge) badge.textContent = tool.severity.toUpperCase();
    const statusSpan = toast.querySelector('.tool-meta span:last-child');
    if (statusSpan) statusSpan.textContent = tool.status.toUpperCase();
  } else {
    addToolToast(event);
  }
}

function removeToast(id) {
  const toast = document.getElementById(id);
  if (toast) {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 400);
  }
  toolToastTimers.delete(id);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Resize handler ───────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Start ────────────────────────────────────────────────────────────────

animate();
console.log('[shoggoth-observer] core morphology initialized');
