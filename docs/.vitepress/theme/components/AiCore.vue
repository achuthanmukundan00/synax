<template>
  <div class="ai-core" :class="coreClasses" :style="coreStyle">
    <svg viewBox="0 0 300 320" xmlns="http://www.w3.org/2000/svg" class="ai-core-svg" aria-hidden="true">
      <defs>
        <linearGradient id="chamber-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="rgb(14 18 25 / 0.76)" />
          <stop offset="54%" stop-color="rgb(7 10 15 / 0.88)" />
          <stop offset="100%" stop-color="rgb(13 17 24 / 0.7)" />
        </linearGradient>

        <linearGradient id="chamber-bevel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgb(var(--state-hot-rgb) / 0.22)" />
          <stop offset="22%" stop-color="rgb(var(--state-rgb) / 0.02)" />
          <stop offset="100%" stop-color="rgb(var(--state-low-rgb) / 0.18)" />
        </linearGradient>

        <radialGradient id="field-ambient" cx="50%" cy="45%" r="58%">
          <stop offset="0%" stop-color="rgb(var(--state-rgb) / 0.24)" />
          <stop offset="58%" stop-color="rgb(var(--state-rgb) / 0.065)" />
          <stop offset="100%" stop-color="rgb(var(--state-rgb) / 0)" />
        </radialGradient>

        <radialGradient id="nucleus-glow" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stop-color="rgb(var(--state-hot-rgb) / 0.96)" />
          <stop offset="28%" stop-color="rgb(var(--state-rgb) / 0.58)" />
          <stop offset="64%" stop-color="rgb(var(--state-rgb) / 0.16)" />
          <stop offset="100%" stop-color="rgb(var(--state-rgb) / 0)" />
        </radialGradient>

        <pattern id="terminal-scanlines" width="300" height="8" patternUnits="userSpaceOnUse">
          <rect width="300" height="1" fill="rgb(var(--state-rgb) / 0.105)" />
        </pattern>

        <filter id="glow-soft">
          <feGaussianBlur stdDeviation="3" />
        </filter>

        <filter id="glow-med">
          <feGaussianBlur stdDeviation="6" />
        </filter>

        <clipPath id="chamber-clip">
          <rect x="55" y="58" width="190" height="174" rx="18" />
        </clipPath>
      </defs>

      <rect width="300" height="320" fill="transparent" />

      <ellipse cx="150" cy="145" rx="140" ry="136" fill="url(#field-ambient)" class="field-ambient" />

      <g class="outer-field">
        <ellipse
          cx="150"
          cy="145"
          rx="120"
          ry="113"
          fill="none"
          stroke="rgb(var(--state-rgb) / 0.2)"
          stroke-width="0.7"
          stroke-dasharray="2 16"
          class="field-ring field-ring-outer"
        />
        <ellipse
          cx="150"
          cy="145"
          rx="109"
          ry="102"
          fill="none"
          stroke="rgb(var(--state-rgb) / 0.12)"
          stroke-width="0.5"
          stroke-dasharray="2 22"
          class="field-ring field-ring-mid"
        />
      </g>

      <g class="dot-field">
        <circle cx="74" cy="78" r="1.15" class="dot dot-far d1" />
        <circle cx="104" cy="65" r="0.8" class="dot dot-rear d2" />
        <circle cx="150" cy="56" r="1.05" class="dot dot-hot d3" />
        <circle cx="196" cy="66" r="0.8" class="dot dot-rear d4" />
        <circle cx="226" cy="84" r="1.1" class="dot dot-far d5" />
        <circle cx="57" cy="143" r="0.75" class="dot dot-rear d6" />
        <circle cx="78" cy="178" r="1" class="dot dot-far d7" />
        <circle cx="222" cy="176" r="1" class="dot dot-far d8" />
        <circle cx="244" cy="145" r="0.75" class="dot dot-rear d9" />
        <circle cx="92" cy="224" r="0.85" class="dot dot-rear d10" />
        <circle cx="130" cy="236" r="0.7" class="dot dot-rear d11" />
        <circle cx="170" cy="236" r="0.7" class="dot dot-rear d12" />
        <circle cx="208" cy="224" r="0.85" class="dot dot-rear d13" />
      </g>

      <rect
        x="52"
        y="55"
        width="196"
        height="180"
        rx="20"
        fill="none"
        stroke="rgb(var(--state-rgb) / 0.22)"
        stroke-width="5"
        filter="url(#glow-med)"
        class="chamber-outer-glow"
      />

      <rect
        x="55"
        y="58"
        width="190"
        height="174"
        rx="18"
        fill="url(#chamber-glass)"
        stroke="rgb(var(--state-rgb) / 0.62)"
        stroke-width="1.8"
        class="chamber-frame"
      />

      <rect x="56" y="59" width="188" height="172" rx="17" fill="url(#chamber-bevel)" class="chamber-bevel" />

      <g class="chamber-corners">
        <path d="M75,58 L55,58 L55,78" class="corner corner-tl" />
        <path d="M225,58 L245,58 L245,78" class="corner corner-tr" />
        <path d="M75,232 L55,232 L55,212" class="corner corner-bl" />
        <path d="M225,232 L245,232 L245,212" class="corner corner-br" />
      </g>

      <g clip-path="url(#chamber-clip)" class="chamber-interior">
        <rect x="55" y="58" width="190" height="174" fill="url(#terminal-scanlines)" class="scanline-field" />
        <line x1="150" y1="58" x2="150" y2="232" class="containment-axis axis-vertical" />
        <line x1="55" y1="145" x2="245" y2="145" class="containment-axis axis-horizontal" />

        <g class="morph morph-default">
          <ellipse cx="150" cy="145" rx="51" ry="46" class="morph-line" />
          <ellipse cx="150" cy="145" rx="36" ry="31" class="morph-line morph-dashed" />
          <line x1="112" y1="145" x2="188" y2="145" class="morph-faint" />
          <line x1="150" y1="111" x2="150" y2="179" class="morph-faint" />
          <circle cx="124" cy="126" r="1" class="inner-dot" />
          <circle cx="176" cy="126" r="1" class="inner-dot" />
          <circle cx="124" cy="164" r="1" class="inner-dot rear" />
          <circle cx="176" cy="164" r="1" class="inner-dot rear" />
        </g>

        <g class="morph morph-qwen">
          <path d="M83,91 L132,140 M168,140 L217,91 M83,199 L132,150 M168,150 L217,199" class="lattice-line" />
          <path d="M150,104 L182,128 L171,165 L150,187 L129,165 L118,128 Z" class="lattice-shell" />
          <path d="M118,128 L182,128 M129,165 L171,165 M150,104 L150,187" class="lattice-line faint" />
          <circle cx="110" cy="116" r="1.45" class="lattice-node n1" />
          <circle cx="190" cy="116" r="1.45" class="lattice-node n2" />
          <circle cx="110" cy="174" r="1.45" class="lattice-node n3" />
          <circle cx="190" cy="174" r="1.45" class="lattice-node n4" />
          <circle cx="150" cy="105" r="1.1" class="lattice-node n5" />
          <circle cx="150" cy="185" r="1.1" class="lattice-node n6" />
        </g>

        <g class="morph morph-deepseek">
          <rect x="69" y="128" width="162" height="3" rx="1.5" class="furnace-band b1" />
          <rect x="76" y="137" width="148" height="2" rx="1" class="furnace-band b2" />
          <rect x="63" y="145" width="174" height="1" rx="0.5" class="furnace-line" />
          <rect x="70" y="154" width="160" height="3" rx="1.5" class="furnace-band b3" />
          <rect x="81" y="163" width="138" height="2" rx="1" class="furnace-band b4" />
          <ellipse cx="150" cy="145" rx="34" ry="19" class="morph-line dense" />
          <circle cx="111" cy="181" r="0.95" class="inner-dot rear" />
          <circle cx="130" cy="187" r="0.95" class="inner-dot rear" />
          <circle cx="170" cy="187" r="0.95" class="inner-dot rear" />
          <circle cx="189" cy="181" r="0.95" class="inner-dot rear" />
        </g>

        <g class="morph morph-openai">
          <circle cx="150" cy="145" r="49" class="morph-line optic" />
          <circle cx="150" cy="145" r="34" class="morph-line optic medium" />
          <circle cx="150" cy="145" r="20" class="morph-line optic hot" />
          <line x1="101" y1="145" x2="121" y2="145" class="morph-faint" />
          <line x1="179" y1="145" x2="199" y2="145" class="morph-faint" />
        </g>

        <g class="morph morph-claude">
          <path
            d="M107,146 C107,119 128,104 150,107 C172,104 193,119 193,146 C193,171 171,185 150,182 C129,185 107,171 107,146 Z"
            class="aperture-line"
          />
          <path
            d="M95,145 C112,116 135,100 150,106 C165,100 188,116 205,145 C188,174 165,190 150,184 C135,190 112,174 95,145 Z"
            class="aperture-line soft"
          />
          <circle cx="116" cy="129" r="1.25" class="bloom-dot b1" />
          <circle cx="184" cy="129" r="1.25" class="bloom-dot b2" />
          <circle cx="116" cy="162" r="1.25" class="bloom-dot b3" />
          <circle cx="184" cy="162" r="1.25" class="bloom-dot b4" />
        </g>

        <g class="morph morph-gemini">
          <line x1="150" y1="84" x2="150" y2="207" class="mirror-axis" />
          <path d="M118,122 C132,109 149,112 150,145 C151,178 132,181 118,168" class="twin-field left" />
          <path d="M182,122 C168,109 151,112 150,145 C149,178 168,181 182,168" class="twin-field right" />
          <circle cx="135" cy="145" r="19" class="twin-orbit left" />
          <circle cx="165" cy="145" r="19" class="twin-orbit right" />
          <circle cx="125" cy="121" r="0.95" class="inner-dot" />
          <circle cx="175" cy="169" r="0.95" class="inner-dot rear" />
        </g>
      </g>

      <g class="nucleus-group">
        <circle cx="150" cy="145" r="23" fill="url(#nucleus-glow)" class="nucleus-glow" />
        <g class="single-nucleus">
          <circle cx="150" cy="145" r="13" class="nucleus-ring" />
          <circle cx="150" cy="145" r="5" class="nucleus-core" />
        </g>
        <g class="twin-nucleus">
          <circle cx="140" cy="145" r="4" class="twin-core left" />
          <circle cx="160" cy="145" r="4" class="twin-core right" />
          <line x1="144" y1="145" x2="156" y2="145" class="twin-link" />
        </g>
      </g>

      <g class="state-overlay state-working-overlay" clip-path="url(#chamber-clip)">
        <rect x="55" y="58" width="190" height="3" rx="1.5" class="working-scan" />
      </g>

      <g class="state-overlay state-tool-overlay" clip-path="url(#chamber-clip)">
        <path d="M68,183 C102,151 121,158 150,145 C179,132 199,139 232,106" class="route-path" />
        <circle cx="68" cy="183" r="2" class="route-node route-a" />
        <circle cx="150" cy="145" r="2.4" class="route-node route-b" />
        <circle cx="232" cy="106" r="2" class="route-node route-c" />
      </g>

      <g class="state-overlay state-success-overlay">
        <circle cx="150" cy="145" r="32" class="success-ring r1" />
        <circle cx="150" cy="145" r="58" class="success-ring r2" />
      </g>

      <g class="state-overlay state-warning-overlay">
        <rect x="50" y="53" width="200" height="184" rx="23" class="pressure-shell" />
        <path d="M64,104 H236 M64,188 H236" class="pressure-line" />
      </g>

      <g class="state-overlay state-error-overlay">
        <rect x="50" y="53" width="200" height="184" rx="23" class="sealed-shell" />
        <path d="M72,63 L88,79 M228,63 L212,79 M72,227 L88,211 M228,227 L212,211" class="sealed-corner" />
        <circle cx="150" cy="145" r="35" class="error-containment" />
      </g>
    </svg>

    <div class="core-label-strip" v-if="showLabel">
      <span class="core-label-model">{{ core.profile.label }}</span>
      <span class="core-label-sep">·</span>
      <span class="core-label-state">{{ core.state }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RuntimeScene } from '../runtime-core';

const props = withDefaults(
  defineProps<{
    core: RuntimeScene;
    showLabel?: boolean;
  }>(),
  {
    showLabel: true,
  },
);

const coreClasses = computed(() => [
  `profile-${props.core.profile.id}`,
  `state-${props.core.state}`,
  `geometry-${props.core.profile.geometry}`,
  `phase-${props.core.profile.motion.phaseStyle}`,
  `scan-${props.core.profile.motion.scanStyle}`,
]);

const coreStyle = computed(() => ({
  '--state-rgb': props.core.palette.stateRgb,
  '--state-hot-rgb': props.core.palette.hotRgb,
  '--state-shell-rgb': props.core.palette.shellRgb,
  '--state-low-rgb': props.core.palette.lowRgb,
  '--profile-rgb': props.core.profile.accentRgb,
  '--breath-rate': `${props.core.profile.motion.breathRate}s`,
  '--breath-rate-shell': `${props.core.profile.motion.breathRate * 1.2}s`,
  '--breath-rate-field': `${props.core.profile.motion.breathRate * 1.5}s`,
  '--scene-intensity': String(props.core.intensity),
}));
</script>

<style scoped>
.ai-core {
  --state-rgb: 86 141 208;
  --state-hot-rgb: 124 179 246;
  --state-shell-rgb: 86 141 208;
  --state-low-rgb: 38 62 91;
  --profile-rgb: 86 141 208;
  --breath-rate: 4s;
  --breath-rate-shell: 4.8s;
  --breath-rate-field: 6s;
  --scene-intensity: 0.5;
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
}

.ai-core-svg {
  width: min(270px, 78vw);
  height: auto;
  overflow: visible;
}

.ai-core-svg * {
  transform-box: fill-box;
  transform-origin: center;
}

.field-ambient,
.field-ring,
.dot,
.chamber-outer-glow,
.chamber-frame,
.chamber-bevel,
.corner,
.scanline-field,
.containment-axis,
.morph,
.nucleus-glow,
.nucleus-ring,
.nucleus-core,
.twin-core,
.twin-link,
.state-overlay {
  transition:
    opacity 0.7s ease,
    stroke 0.7s ease,
    fill 0.7s ease,
    transform 0.7s ease;
}

.dot {
  fill: rgb(var(--state-rgb) / 0.48);
}

.dot-rear {
  fill: rgb(var(--state-rgb) / 0.28);
}

.dot-hot {
  fill: rgb(var(--state-hot-rgb) / 0.62);
}

.corner {
  fill: none;
  stroke: rgb(var(--state-hot-rgb) / 0.68);
  stroke-width: 1.25;
  stroke-linecap: square;
}

.scanline-field {
  opacity: 0.34;
}

.containment-axis {
  stroke: rgb(var(--state-rgb) / 0.13);
  stroke-width: 0.65;
}

.morph {
  display: none;
}

.profile-default .morph-default,
.profile-qwen .morph-qwen,
.profile-deepseek .morph-deepseek,
.profile-openai .morph-openai,
.profile-claude .morph-claude,
.profile-gemini .morph-gemini {
  display: block;
}

.morph-line,
.morph-faint,
.lattice-line,
.lattice-shell,
.aperture-line,
.twin-field,
.twin-orbit,
.mirror-axis {
  fill: none;
  stroke: rgb(var(--state-rgb) / 0.24);
  stroke-width: 0.9;
}

.morph-dashed {
  stroke-dasharray: 4 7;
}

.morph-faint,
.lattice-line.faint,
.mirror-axis {
  stroke: rgb(var(--state-rgb) / 0.14);
  stroke-width: 0.65;
}

.inner-dot,
.lattice-node,
.bloom-dot {
  fill: rgb(var(--state-hot-rgb) / 0.44);
}

.inner-dot.rear {
  fill: rgb(var(--state-rgb) / 0.26);
}

.lattice-line {
  stroke: rgb(var(--state-rgb) / 0.31);
}

.lattice-shell {
  stroke: rgb(var(--state-hot-rgb) / 0.38);
  stroke-width: 1;
}

.furnace-band,
.furnace-line {
  fill: rgb(var(--state-rgb) / 0.25);
}

.furnace-line {
  opacity: 0.45;
}

.morph-line.dense {
  stroke: rgb(var(--state-hot-rgb) / 0.34);
}

.optic {
  stroke: rgb(var(--state-rgb) / 0.18);
}

.optic.medium {
  stroke: rgb(var(--state-hot-rgb) / 0.21);
}

.optic.hot {
  stroke: rgb(var(--state-hot-rgb) / 0.28);
}

.aperture-line {
  stroke: rgb(var(--state-rgb) / 0.26);
}

.aperture-line.soft {
  stroke: rgb(var(--state-hot-rgb) / 0.18);
  stroke-width: 0.8;
}

.twin-field,
.twin-orbit {
  stroke: rgb(var(--state-rgb) / 0.24);
}

.nucleus-ring {
  fill: none;
  stroke: rgb(var(--state-hot-rgb) / 0.52);
  stroke-width: 0.9;
}

.nucleus-core,
.twin-core {
  fill: rgb(var(--state-hot-rgb) / 0.9);
}

.twin-link {
  stroke: rgb(var(--state-rgb) / 0.28);
  stroke-width: 0.6;
}

.twin-nucleus {
  display: none;
}

.profile-gemini .single-nucleus {
  display: none;
}

.profile-gemini .twin-nucleus {
  display: block;
}

.state-overlay {
  display: none;
}

.working-scan {
  fill: rgb(var(--state-hot-rgb) / 0.32);
}

.route-path {
  fill: none;
  stroke: rgb(var(--state-hot-rgb) / 0.42);
  stroke-width: 1.15;
  stroke-dasharray: 8 10;
}

.route-node {
  fill: rgb(var(--state-hot-rgb) / 0.75);
}

.success-ring,
.pressure-shell,
.sealed-shell,
.error-containment {
  fill: none;
  stroke: rgb(var(--state-hot-rgb) / 0.38);
}

.pressure-line {
  fill: none;
  stroke: rgb(var(--state-hot-rgb) / 0.2);
  stroke-width: 1;
  stroke-dasharray: 10 14;
}

.sealed-corner {
  fill: none;
  stroke: rgb(var(--state-hot-rgb) / 0.55);
  stroke-width: 1.1;
}

.state-unloaded .ai-core-svg {
  filter: grayscale(0.75) saturate(0.35);
}

.state-unloaded .field-ambient,
.state-unloaded .field-ring,
.state-unloaded .dot-field,
.state-unloaded .morph,
.state-unloaded .nucleus-glow {
  opacity: 0.26;
}

.state-unloaded .chamber-outer-glow {
  opacity: 0.18;
}

.state-unloaded .chamber-frame {
  stroke: rgb(var(--state-rgb) / 0.34);
}

.state-unloaded .chamber-corners {
  opacity: 0.22;
}

.state-unloaded .nucleus-core {
  opacity: 0.42;
  r: 3px;
}

.state-unloaded .scanline-field {
  opacity: 0.2;
}

.state-idle .nucleus-glow {
  animation: nucleus-breathe var(--breath-rate) ease-in-out infinite;
}

.state-idle .field-ring-outer {
  animation: shell-breathe var(--breath-rate-shell) ease-in-out infinite;
}

.state-idle .dot-field {
  animation: dot-breathe var(--breath-rate-field) ease-in-out infinite;
}

.state-working .nucleus-glow,
.state-tool-running .nucleus-glow {
  animation: nucleus-active 1.45s ease-in-out infinite;
}

.state-working .nucleus-core,
.state-tool-running .nucleus-core {
  animation: core-active 1.45s ease-in-out infinite;
}

.state-working .field-ring,
.state-tool-running .field-ring {
  animation: shell-phase 2s ease-in-out infinite;
}

.state-working .dot-field,
.state-tool-running .dot-field {
  opacity: calc(0.42 + (var(--scene-intensity) * 0.34));
  animation: dot-phase 2.6s ease-in-out infinite;
}

.state-working .state-working-overlay {
  display: block;
}

.state-working .working-scan {
  animation: scan-sweep 1.9s ease-in-out infinite;
}

.state-tool-running .state-tool-overlay {
  display: block;
}

.state-tool-running .route-path {
  animation: route-dash 1.35s linear infinite;
}

.state-tool-running .route-node {
  animation: route-pulse 1.35s ease-in-out infinite;
}

.state-succeeded .state-success-overlay {
  display: block;
}

.state-succeeded .nucleus-glow {
  animation: success-settle 2.4s ease-in-out infinite;
}

.state-succeeded .success-ring.r1 {
  animation: success-resolve 2.4s ease-out infinite;
}

.state-succeeded .success-ring.r2 {
  animation: success-resolve 2.4s ease-out infinite 0.35s;
}

.state-warning .state-warning-overlay {
  display: block;
}

.state-warning .chamber-frame {
  animation: pressure-frame 1.8s ease-in-out infinite;
}

.state-warning .pressure-shell {
  animation: pressure-shell 1.8s ease-in-out infinite;
}

.state-warning .dot-field {
  animation: pressure-dots 1.9s ease-in-out infinite;
}

.state-error .state-error-overlay {
  display: block;
}

.state-error .chamber-frame {
  animation: contained-distortion 1.8s ease-in-out infinite;
}

.state-error .nucleus-glow {
  animation: error-pulse 1.9s ease-in-out infinite;
}

.state-error .sealed-shell,
.state-error .error-containment {
  animation: sealed-hold 2s ease-in-out infinite;
}

.phase-snap.state-idle .morph-qwen,
.phase-snap.state-working .morph-qwen,
.phase-snap.state-tool-running .morph-qwen {
  animation: lattice-snap 2.7s steps(2, end) infinite;
}

.profile-qwen .lattice-node {
  animation: lattice-node 2.2s ease-in-out infinite;
}

.profile-qwen .n2,
.profile-qwen .n5 {
  animation-delay: 0.25s;
}

.profile-qwen .n3,
.profile-qwen .n6 {
  animation-delay: 0.5s;
}

.phase-compressed.state-working .morph-deepseek,
.phase-compressed.state-tool-running .morph-deepseek {
  animation: furnace-compress 1.8s ease-in-out infinite;
}

.profile-deepseek .furnace-band {
  animation: furnace-pulse 3.2s ease-in-out infinite;
}

.profile-deepseek .b2 {
  animation-delay: 0.35s;
}

.profile-deepseek .b3 {
  animation-delay: 0.7s;
}

.profile-deepseek .b4 {
  animation-delay: 1.05s;
}

.phase-elastic.state-idle .morph-claude,
.phase-elastic.state-warning .morph-claude {
  animation: aperture-breathe 4.8s ease-in-out infinite;
}

.profile-claude .bloom-dot {
  animation: bloom-breathe 4.4s ease-in-out infinite;
}

.profile-claude .b2,
.profile-claude .b3 {
  animation-delay: 0.55s;
}

.profile-claude .b4 {
  animation-delay: 1.1s;
}

.phase-mirrored .twin-core.left,
.phase-mirrored .twin-orbit.left {
  animation: twin-phase 3.2s ease-in-out infinite;
}

.phase-mirrored .twin-core.right,
.phase-mirrored .twin-orbit.right {
  animation: twin-phase 3.2s ease-in-out infinite 1.6s;
}

.core-label-strip {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.5rem;
  font-family: var(--synax-font);
  font-size: 0.68rem;
  color: var(--synax-text-muted);
}

.core-label-model {
  color: rgb(var(--state-rgb));
  font-weight: 500;
}

.core-label-sep {
  opacity: 0.42;
}

.core-label-state {
  color: rgb(var(--state-hot-rgb) / 0.82);
}

@keyframes nucleus-breathe {
  0%,
  100% {
    opacity: 0.46;
    transform: scale(0.96);
  }
  50% {
    opacity: 0.74;
    transform: scale(1.08);
  }
}

@keyframes shell-breathe {
  0%,
  100% {
    opacity: 0.42;
    transform: scale(0.99);
  }
  50% {
    opacity: 0.68;
    transform: scale(1.015);
  }
}

@keyframes dot-breathe {
  0%,
  100% {
    opacity: 0.36;
  }
  50% {
    opacity: 0.56;
  }
}

@keyframes nucleus-active {
  0%,
  100% {
    opacity: 0.64;
    transform: scale(1);
  }
  50% {
    opacity: 0.95;
    transform: scale(1.18);
  }
}

@keyframes core-active {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.28);
  }
}

@keyframes shell-phase {
  0%,
  100% {
    opacity: 0.36;
    transform: scale(0.995);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.025);
  }
}

@keyframes dot-phase {
  0%,
  100% {
    transform: translate(0, 0);
  }
  50% {
    transform: translate(0.5px, -0.8px);
  }
}

@keyframes scan-sweep {
  0% {
    transform: translateY(0);
    opacity: 0;
  }
  15% {
    opacity: 0.75;
  }
  70% {
    opacity: 0.75;
  }
  100% {
    transform: translateY(171px);
    opacity: 0;
  }
}

@keyframes route-dash {
  to {
    stroke-dashoffset: -36;
  }
}

@keyframes route-pulse {
  0%,
  100% {
    opacity: 0.36;
    transform: scale(0.85);
  }
  50% {
    opacity: 0.9;
    transform: scale(1.18);
  }
}

@keyframes success-settle {
  0%,
  100% {
    opacity: 0.52;
    transform: scale(1);
  }
  50% {
    opacity: 0.78;
    transform: scale(1.08);
  }
}

@keyframes success-resolve {
  0% {
    opacity: 0.34;
    transform: scale(0.75);
  }
  70% {
    opacity: 0.08;
  }
  100% {
    opacity: 0;
    transform: scale(1.55);
  }
}

@keyframes pressure-frame {
  0%,
  100% {
    stroke-width: 1.8;
    transform: scale(1);
  }
  50% {
    stroke-width: 2.4;
    transform: scale(1.006);
  }
}

@keyframes pressure-shell {
  0%,
  100% {
    opacity: 0.16;
    transform: scale(1);
  }
  50% {
    opacity: 0.42;
    transform: scale(1.018);
  }
}

@keyframes pressure-dots {
  0%,
  100% {
    opacity: 0.36;
    transform: translate(0, 0);
  }
  50% {
    opacity: 0.62;
    transform: translate(0.6px, 0.2px);
  }
}

@keyframes contained-distortion {
  0%,
  100% {
    transform: skewX(0deg) scale(1);
  }
  35% {
    transform: skewX(0.35deg) scale(1.004);
  }
  60% {
    transform: skewX(-0.25deg) scale(0.998);
  }
}

@keyframes error-pulse {
  0%,
  100% {
    opacity: 0.46;
    transform: scale(0.98);
  }
  50% {
    opacity: 0.82;
    transform: scale(1.14);
  }
}

@keyframes sealed-hold {
  0%,
  100% {
    opacity: 0.24;
  }
  50% {
    opacity: 0.52;
  }
}

@keyframes lattice-snap {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.025);
  }
}

@keyframes lattice-node {
  0%,
  100% {
    opacity: 0.34;
    transform: scale(0.9);
  }
  50% {
    opacity: 0.75;
    transform: scale(1.25);
  }
}

@keyframes furnace-compress {
  0%,
  100% {
    transform: scaleX(1) scaleY(1);
  }
  50% {
    transform: scaleX(1.05) scaleY(0.86);
  }
}

@keyframes furnace-pulse {
  0%,
  100% {
    opacity: 0.32;
  }
  50% {
    opacity: 0.72;
  }
}

@keyframes aperture-breathe {
  0%,
  100% {
    transform: scale(0.985);
  }
  50% {
    transform: scale(1.045);
  }
}

@keyframes bloom-breathe {
  0%,
  100% {
    opacity: 0.26;
    transform: scale(0.85);
  }
  50% {
    opacity: 0.58;
    transform: scale(1.28);
  }
}

@keyframes twin-phase {
  0%,
  100% {
    opacity: 0.46;
    transform: translateX(0) scale(0.94);
  }
  50% {
    opacity: 0.88;
    transform: translateX(1px) scale(1.12);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-core-svg * {
    animation: none !important;
  }
}
</style>
