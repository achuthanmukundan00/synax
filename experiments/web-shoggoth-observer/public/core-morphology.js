/**
 * Shoggoth Core Morphology — Transformer Architecture Observer.
 *
 * V5: OrbitControls, model-specific profiles, activation cascades,
 * zoom-dependent neuron-cluster LOD, phase-color sync with telemetry.
 *
 * Layout (X-axis stack):
 *  - Central residual-stream spine (brightest)
 *  - Layer rings stacked along spine
 *  - Attention-head fiber bundles radiating per layer
 *  - MLP/FFN slabs offset from attention fibers
 *  - KV cache lattice: planar grid behind stack
 *  - Output/logit surface at output end
 *  - Token pulses traveling along residual spine
 *  - Neuron clusters (visible when zoomed in)
 */

import { resolveProfile, ROLE_PALETTES } from './core-profiles.js';
import { buildScene } from './core-scene.js';
import { startAnimationLoop, setPhase, setSeverity, setModelId } from './core-animation.js';

// ─── Detect model from SSE events (best-effort) ──────────────────────────

let detectedModelId = 'default';
let currentProfile = resolveProfile(detectedModelId);

// ─── Build the scene ─────────────────────────────────────────────────────

const { scene, camera, renderer, composer, controls, bloomPass, refs } = buildScene(currentProfile);

// ─── Start animation ─────────────────────────────────────────────────────

startAnimationLoop(refs, currentProfile, composer, bloomPass, controls, camera);

// ─── SSE Connection ──────────────────────────────────────────────────────

const eventSource = new EventSource('/events');
const transcriptEl = document.getElementById('transcript-overlay');
const toolNotificationsEl = document.getElementById('tool-notifications');
const statusDot = document.getElementById('status-dot');
const phaseLabel = document.getElementById('phase-label');
const budgetBar = document.getElementById('budget-bar');
const clearBtn = document.getElementById('clear-btn');
let transcriptLines = [];
const toolToastTimers = new Map();

// Profile HUD elements (dynamically created)
let profileHud = null;
function ensureProfileHud() {
  if (profileHud) return;
  profileHud = document.createElement('div');
  profileHud.id = 'profile-hud';
  profileHud.style.cssText =
    'position:fixed;top:48px;left:20px;z-index:20;font-family:monospace;font-size:10px;' +
    'color:rgba(120,140,160,0.5);pointer-events:none;line-height:1.4;';
  document.body.appendChild(profileHud);
}

function updateProfileHud() {
  ensureProfileHud();
  const p = ROLE_PALETTES[currentProfile.colorRole] || ROLE_PALETTES.neutral;
  profileHud.innerHTML =
    `<span style="color:${p.pulse};opacity:0.7">${currentProfile.label}</span><br>` +
    `<span style="opacity:0.4">layers: ${currentProfile.layerCount} · heads: ${currentProfile.attentionHeads}</span>`;
}

updateProfileHud();

// Safety: verify required DOM elements exist
if (!transcriptEl || !statusDot || !phaseLabel) {
  console.error('[shoggoth-observer] missing required DOM elements — observer may not render correctly');
}

clearBtn.addEventListener('click', () => {
  transcriptLines = [];
  transcriptEl.innerHTML = '';
  toolNotificationsEl.innerHTML = '';
});

eventSource.addEventListener('message', (event) => {
  try {
    const data = JSON.parse(event.data);
    handleObserverEvent(data);
  } catch { /* ignore */ }
});

eventSource.addEventListener('error', () => {
  if (statusDot) statusDot.className = 'idle';
  if (phaseLabel) phaseLabel.textContent = 'DISCONNECTED';
});

function handleObserverEvent(event) {
  // Model detection
  if (event.modelId && event.modelId !== detectedModelId) {
    detectedModelId = event.modelId;
    const newProfile = resolveProfile(detectedModelId);
    if (newProfile.id !== currentProfile.id) {
      currentProfile = newProfile;
      setModelId(detectedModelId);
      updateProfileHud();
    }
  }

  // Phase update
  if (event.phase) {
    setPhase(event.phase);
    if (statusDot) statusDot.className = event.phase;
    let label = event.phase.toUpperCase();
    if (event.tool?.severity === 'suspicious') label = '⚠ ' + label;
    if (event.tool?.severity === 'attention') label = '⚡ ' + label;
    if (phaseLabel) phaseLabel.textContent = label;
  }

  // Severity
  if (event.severity === 'suspicious') setSeverity(0.8);
  else if (event.severity === 'attention') setSeverity(0.35);
  else if (event.phase === 'error') setSeverity(0.6);
  else setSeverity(0);

  // Tool toasts
  if (event.tool) {
    if (event.type === 'tool_call_started') addToolToast(event);
    else if (event.type === 'tool_call_finished' || event.type === 'tool_call_failed') updateToolToast(event);
  }

  // Transcript
  if (event.text && (
    event.type === 'model_note' || event.type === 'assistant_delta' ||
    event.type === 'session_started' || event.type === 'session_finished' || event.type === 'error'
  )) appendTranscript(event);

  // Budget bar
  if (event.contextUsedTokens != null && event.contextWindowTokens != null && event.contextWindowTokens > 0) {
    const pct = Math.min(100, (event.contextUsedTokens / event.contextWindowTokens) * 100);
    if (budgetBar) {
      budgetBar.style.width = pct + '%';
      if (pct > 80) budgetBar.style.background = 'rgba(183,65,52,0.5)';
      else if (pct > 60) budgetBar.style.background = 'rgba(190,133,54,0.5)';
      else budgetBar.style.background = 'rgba(58,109,176,0.5)';
    }
  }

  if (event.type === 'session_finished') setSeverity(0);
}

// ─── Transcript ──────────────────────────────────────────────────────────

const MAX_TRANSCRIPT_LINES = 50;

function appendTranscript(event) {
  let text = (event.text ?? '').slice(0, 300);
  if (!text.trim()) return;
  text = text.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '').trim();
  if (!text) return;
  const line = document.createElement('div');
  line.className = 'note-line';
  if (event.type === 'session_started' || event.type === 'session_finished') {
    line.classList.add('session');
    line.innerHTML = `<span class="glyph">\u25C6</span>${escapeHtml(text)}`;
  } else {
    line.innerHTML = `<span class="glyph">\u273D</span>${escapeHtml(text)}`;
  }
  transcriptEl.appendChild(line);
  transcriptLines.push(line);
  while (transcriptLines.length > MAX_TRANSCRIPT_LINES) {
    const old = transcriptLines.shift();
    if (old) old.remove();
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ─── Tool Toasts ─────────────────────────────────────────────────────────

function addToolToast(event) {
  const tool = event.tool;
  const id = 'tool-' + event.id + '-' + tool.name;
  const toast = document.createElement('div');
  toast.className = `tool-toast severity-${tool.severity}`;
  toast.id = id;
  toast.innerHTML = `
    <div class="tool-name">${escapeHtml(tool.name)}</div>
    <div class="tool-summary">${escapeHtml((tool.summary ?? '').slice(0, 100))}</div>
    <div class="tool-meta">
      <span class="severity-badge">${(tool.severity ?? 'normal').toUpperCase()}</span>
      <span>${new Date(tool.timestamp ?? Date.now()).toLocaleTimeString()}</span>
      <span>${(tool.status ?? 'running').toUpperCase()}</span>
    </div>`;
  toolNotificationsEl.appendChild(toast);
  const timer = setTimeout(() => removeToast(id), tool.severity === 'normal' ? 8000 : 15000);
  toolToastTimers.set(id, timer);
}

function updateToolToast(event) {
  const tool = event.tool;
  const existingId = 'tool-' + event.id + '-' + tool.name;
  const toast = document.getElementById(existingId);
  if (toast) {
    const badge = toast.querySelector('.severity-badge');
    if (badge) badge.textContent = (tool.severity ?? 'normal').toUpperCase();
    const statusSpan = toast.querySelector('.tool-meta span:last-child');
    if (statusSpan) statusSpan.textContent = (tool.status ?? 'done').toUpperCase();
  } else { addToolToast(event); }
}

function removeToast(id) {
  const toast = document.getElementById(id);
  if (toast) { toast.classList.add('removing'); setTimeout(() => toast.remove(), 400); }
  toolToastTimers.delete(id);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Resize ──────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Ready ───────────────────────────────────────────────────────────────

console.log('[shoggoth-observer] transformer morphology V5 initialized');
console.log(`[shoggoth-observer] profile: ${currentProfile.label} (${currentProfile.layerCount}L × ${currentProfile.attentionHeads}H)`);
console.log('[shoggoth-observer] mouse: drag to orbit · scroll to zoom · right-drag to pan');
