<template>
  <div
    class="ai-core"
    :class="[`core-${core.motion}`, `core-${core.id}`]"
    :style="coreStyle"
  >
    <svg
      viewBox="0 0 260 260"
      xmlns="http://www.w3.org/2000/svg"
      class="ai-core-svg"
    >
      <!-- Ambient outer glow -->
      <defs>
        <radialGradient :id="gradId('glow')" cx="50%" cy="50%" r="50%">
          <stop offset="0%" :stop-color="`rgba(${core.color} / 0.25)`" />
          <stop offset="60%" :stop-color="`rgba(${core.color} / 0.06)`" />
          <stop offset="100%" :stop-color="`rgba(${core.color} / 0)`" />
        </radialGradient>

        <radialGradient :id="gradId('nucleus')" cx="50%" cy="50%" r="50%">
          <stop offset="0%" :stop-color="`rgba(${core.color} / 0.9)`" />
          <stop offset="50%" :stop-color="`rgba(${core.color} / 0.5)`" />
          <stop offset="100%" :stop-color="`rgba(${core.color} / 0.15)`" />
        </radialGradient>

        <filter :id="gradId('blur')">
          <feGaussianBlur stdDeviation="3" />
        </filter>

        <filter :id="gradId('blurHeavy')">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      <!-- Outer glow field -->
      <circle cx="130" cy="130" r="120" :fill="`url(#${gradId('glow')})`" class="core-glow-field" />

      <!-- Outer containment ring -->
      <circle
        cx="130" cy="130" r="100"
        fill="none"
        :stroke="`rgba(${core.color} / 0.3)`"
        stroke-width="1.5"
        stroke-dasharray="4 12"
        class="core-containment-outer"
      />

      <!-- Mid containment ring -->
      <circle
        cx="130" cy="130" r="82"
        fill="none"
        :stroke="`rgba(${core.color} / 0.2)`"
        stroke-width="1"
        class="core-containment-mid"
      />

      <!-- Inner field ring -->
      <circle
        cx="130" cy="130" r="62"
        fill="none"
        :stroke="`rgba(${core.color} / 0.25)`"
        stroke-width="1"
        stroke-dasharray="8 3"
        class="core-field-inner"
      />

      <!-- Orbiting particles -->
      <g class="core-particles">
        <!-- Particle 1: outer orbit -->
        <circle
          r="2.5"
          :fill="`rgba(${core.color} / 0.7)`"
          class="particle particle-outer-1"
        >
          <animateMotion
            dur="8s"
            repeatCount="indefinite"
            path="M130,50 a80,80 0 1,1 0.001,0"
          />
        </circle>

        <!-- Particle 2: outer orbit offset -->
        <circle
          r="2"
          :fill="`rgba(${core.color} / 0.5)`"
          class="particle particle-outer-2"
        >
          <animateMotion
            dur="11s"
            repeatCount="indefinite"
            path="M130,50 a80,80 0 1,1 0.001,0"
            begin="-3s"
          />
        </circle>

        <!-- Particle 3: mid orbit -->
        <circle
          r="2"
          :fill="`rgba(${core.color} / 0.6)`"
          class="particle particle-mid-1"
        >
          <animateMotion
            dur="6s"
            repeatCount="indefinite"
            path="M130,68 a62,62 0 1,1 0.001,0"
            begin="-1s"
          />
        </circle>

        <!-- Particle 4: mid orbit offset -->
        <circle
          r="1.5"
          :fill="`rgba(${core.color} / 0.4)`"
          class="particle particle-mid-2"
        >
          <animateMotion
            dur="9s"
            repeatCount="indefinite"
            path="M130,68 a62,62 0 1,0 -0.001,0"
            begin="-5s"
          />
        </circle>

        <!-- Particle 5: inner orbit -->
        <circle
          r="1.8"
          :fill="`rgba(${core.color} / 0.55)`"
          class="particle particle-inner-1"
        >
          <animateMotion
            dur="4.5s"
            repeatCount="indefinite"
            path="M130,88 a42,42 0 1,1 0.001,0"
            begin="-2s"
          />
        </circle>

        <!-- Qwen-specific lattice dots -->
        <template v-if="core.id === 'qwen'">
          <circle cx="130" cy="70" r="1.5" :fill="`rgba(${core.color} / 0.6)`" class="lattice-dot lattice-1" />
          <circle cx="160" cy="130" r="1.5" :fill="`rgba(${core.color} / 0.6)`" class="lattice-dot lattice-2" />
          <circle cx="100" cy="130" r="1.5" :fill="`rgba(${core.color} / 0.6)`" class="lattice-dot lattice-3" />
          <circle cx="130" cy="190" r="1.5" :fill="`rgba(${core.color} / 0.6)`" class="lattice-dot lattice-4" />
          <circle cx="151" cy="151" r="1.5" :fill="`rgba(${core.color} / 0.45)`" class="lattice-dot lattice-5" />
          <circle cx="109" cy="109" r="1.5" :fill="`rgba(${core.color} / 0.45)`" class="lattice-dot lattice-6" />
        </template>

        <!-- DeepSeek: horizontal scan bars -->
        <template v-if="core.id === 'deepseek'">
          <line x1="100" y1="130" x2="160" y2="130" :stroke="`rgba(${core.color} / 0.3)`" stroke-width="1" class="scan-line scan-h" />
          <line x1="105" y1="122" x2="155" y2="122" :stroke="`rgba(${core.color} / 0.2)`" stroke-width="0.5" class="scan-line scan-h2" />
          <line x1="105" y1="138" x2="155" y2="138" :stroke="`rgba(${core.color} / 0.2)`" stroke-width="0.5" class="scan-line scan-h3" />
        </template>

        <!-- Kimi: wide soft rings -->
        <template v-if="core.id === 'kimi'">
          <circle cx="130" cy="130" r="55" fill="none" :stroke="`rgba(${core.color} / 0.15)`" stroke-width="0.5" class="kimi-ring-wide" />
          <circle cx="130" cy="130" r="72" fill="none" :stroke="`rgba(${core.color} / 0.1)`" stroke-width="0.5" class="kimi-ring-wider" />
        </template>
      </g>

      <!-- Central aperture shape -->
      <g class="core-aperture">
        <!-- Qwen: angular/lattice aperture -->
        <template v-if="core.id === 'qwen'">
          <polygon
            points="130,103 152,118 148,142 130,157 112,142 108,118"
            fill="none"
            :stroke="`rgba(${core.color} / 0.4)`"
            stroke-width="1.2"
            class="aperture-shape"
          />
        </template>

        <!-- DeepSeek: compressed horizontal aperture -->
        <template v-if="core.id === 'deepseek'">
          <ellipse
            cx="130" cy="130" rx="26" ry="18"
            fill="none"
            :stroke="`rgba(${core.color} / 0.35)`"
            stroke-width="1.2"
            class="aperture-shape"
          />
        </template>

        <!-- All others: circular aperture -->
        <template v-if="core.id !== 'qwen' && core.id !== 'deepseek'">
          <circle
            cx="130" cy="130" r="22"
            fill="none"
            :stroke="`rgba(${core.color} / 0.35)`"
            stroke-width="1.2"
            class="aperture-shape"
          />
        </template>
      </g>

      <!-- Nucleus / central pupil -->
      <g class="core-nucleus">
        <!-- Central glow -->
        <circle cx="130" cy="130" r="16" :fill="`url(#${gradId('nucleus')})`" class="nucleus-glow" />

        <!-- Core dot -->
        <circle
          cx="130" cy="130"
          :r="core.id === 'unloaded' ? 3 : core.id === 'deepseek' ? 5 : core.id === 'working' ? 6 : 4.5"
          :fill="`rgba(${core.color} / 0.9)`"
          class="nucleus-core"
        />

        <!-- Outer pupil ring -->
        <circle
          cx="130" cy="130" r="12"
          fill="none"
          :stroke="`rgba(${core.color} / 0.3)`"
          stroke-width="0.8"
          class="nucleus-ring"
        />
      </g>

      <!-- Error state: containment distortion indicators -->
      <template v-if="core.id === 'error'">
        <line x1="108" y1="108" x2="118" y2="118" :stroke="`rgba(${core.color} / 0.5)`" stroke-width="1" class="error-jitter error-j1" />
        <line x1="152" y1="108" x2="142" y2="118" :stroke="`rgba(${core.color} / 0.5)`" stroke-width="1" class="error-jitter error-j2" />
      </template>
    </svg>

    <!-- Runtime label strip below the core -->
    <div class="core-label-strip" v-if="showLabel">
      <span class="core-label-model">{{ core.model }}</span>
      <span class="core-label-sep">·</span>
      <span class="core-label-state">{{ core.state }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface CoreDef {
  id: string
  name: string
  model: string
  provider: string
  state: string
  context: string
  color: string
  headline: string
  subcopy: string
  terminal: [string, string][]
  motion: string
}

const props = withDefaults(defineProps<{
  core: CoreDef
  showLabel?: boolean
}>(), {
  showLabel: true,
})

let uid = 0
function gradId(name: string): string {
  return `gc-${props.core.id}-${name}`
}

const coreStyle = computed(() => ({
  '--core-local-rgb': props.core.color,
  '--core-local-color': `rgb(${props.core.color})`,
}))
</script>

<style scoped>
.ai-core {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
}

.ai-core-svg {
  width: 240px;
  height: 240px;
}

/* ---------- Motion classes ---------- */

/* Still — unloaded */
.core-still .core-glow-field { opacity: 0.4; }
.core-still .core-containment-outer { opacity: 0.5; stroke-dashoffset: 0; }
.core-still .core-particles { opacity: 0.3; }
.core-still .nucleus-glow { opacity: 0.3; }
.core-still .nucleus-ring { opacity: 0.4; }

/* Lattice — qwen: quick, angular, precise */
.core-lattice .core-containment-outer { animation: pulse-ring 2.5s ease-in-out infinite; }
.core-lattice .core-field-inner { animation: rotate-ring 8s linear infinite; }
.core-lattice .particle-outer-1 { animation: blink-particle 1.8s ease-in-out infinite; }
.core-lattice .particle-mid-1 { animation: blink-particle 1.4s ease-in-out infinite 0.4s; }
.core-lattice .lattice-dot { animation: lattice-pulse 2s ease-in-out infinite; }
.core-lattice .lattice-2 { animation-delay: 0.3s; }
.core-lattice .lattice-3 { animation-delay: 0.6s; }
.core-lattice .lattice-4 { animation-delay: 0.9s; }
.core-lattice .lattice-5 { animation-delay: 0.15s; }
.core-lattice .lattice-6 { animation-delay: 0.45s; }
.core-lattice .nucleus-glow { animation: nucleus-breathe-fast 1.8s ease-in-out infinite; }

/* Furnace — deepseek: slow, compressed, heavy */
.core-furnace .core-containment-outer { animation: pulse-ring-heavy 4s ease-in-out infinite; }
.core-furnace .core-field-inner { animation: pulse-ring-heavy 3.5s ease-in-out infinite 0.5s; }
.core-furnace .scan-line { animation: scan-drift 3s ease-in-out infinite; }
.core-furnace .scan-h2 { animation: scan-drift 3s ease-in-out infinite 0.6s; }
.core-furnace .scan-h3 { animation: scan-drift 3s ease-in-out infinite 1.2s; }
.core-furnace .particle-outer-1 { animation: blink-particle 2.4s ease-in-out infinite; }
.core-furnace .particle-outer-2 { animation: blink-particle 2.8s ease-in-out infinite 0.8s; }
.core-furnace .nucleus-glow { animation: nucleus-breathe-slow 3s ease-in-out infinite; }
.core-furnace .nucleus-core { animation: nucleus-compress 3s ease-in-out infinite; }

/* Lens — openai: clean, smooth, centered */
.core-lens .core-containment-outer { animation: pulse-ring 3s ease-in-out infinite; }
.core-lens .core-field-inner { animation: pulse-ring 3.2s ease-in-out infinite 0.3s; }
.core-lens .particle-outer-1 { animation: blink-particle 2s ease-in-out infinite; }
.core-lens .particle-mid-1 { animation: blink-particle 2.2s ease-in-out infinite 0.5s; }
.core-lens .nucleus-glow { animation: nucleus-breathe 2.5s ease-in-out infinite; }

/* Moon — kimi: wide, soft, pale */
.core-moon .core-glow-field { opacity: 0.55; }
.core-moon .core-containment-outer { animation: pulse-ring 5s ease-in-out infinite; }
.core-moon .core-field-inner { animation: pulse-ring 5.5s ease-in-out infinite 0.5s; }
.core-moon .kimi-ring-wide { animation: kimi-bloom 4s ease-in-out infinite; }
.core-moon .kimi-ring-wider { animation: kimi-bloom 4s ease-in-out infinite 0.8s; }
.core-moon .particle-outer-1 { animation: blink-particle 3s ease-in-out infinite; }
.core-moon .nucleus-glow { animation: nucleus-breathe 3.5s ease-in-out infinite; }

/* Breathe — working: active, yellow/green */
.core-breathe .core-containment-outer { animation: pulse-ring-active 1.5s ease-in-out infinite; }
.core-breathe .core-field-inner { animation: pulse-ring-active 1.5s ease-in-out infinite 0.3s; }
.core-breathe .particle-outer-1 { animation: blink-particle-fast 1s ease-in-out infinite; }
.core-breathe .particle-mid-1 { animation: blink-particle-fast 1s ease-in-out infinite 0.3s; }
.core-breathe .particle-inner-1 { animation: blink-particle-fast 0.8s ease-in-out infinite 0.5s; }
.core-breathe .nucleus-glow { animation: nucleus-breathe-fast 1.2s ease-in-out infinite; }
.core-breathe .nucleus-core { animation: nucleus-expand 1.2s ease-in-out infinite; }

/* Jitter — error: contained distortion */
.core-jitter .core-containment-outer { animation: jitter-ring 0.3s ease-in-out infinite; }
.core-jitter .core-field-inner { animation: jitter-ring 0.35s ease-in-out infinite 0.15s; }
.core-jitter .error-jitter { animation: jitter-line 0.5s ease-in-out infinite; }
.core-jitter .error-j1 { animation-delay: 0s; }
.core-jitter .error-j2 { animation-delay: 0.25s; }
.core-jitter .nucleus-glow { animation: nucleus-breathe-fast 2s ease-in-out infinite; }
.core-jitter .nucleus-core { filter: brightness(1.3); }

/* ---------- Keyframes ---------- */

@keyframes pulse-ring {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.55; }
}

@keyframes pulse-ring-active {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 0.7; }
}

@keyframes pulse-ring-heavy {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 0.5; }
}

@keyframes rotate-ring {
  from { transform: rotate(0deg); transform-origin: 130px 130px; }
  to { transform: rotate(360deg); transform-origin: 130px 130px; }
}

@keyframes blink-particle {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.9; }
}

@keyframes blink-particle-fast {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

@keyframes lattice-pulse {
  0%, 100% { opacity: 0.4; r: 1.5px; }
  50% { opacity: 0.8; r: 2.2px; }
}

@keyframes scan-drift {
  0%, 100% { opacity: 0.15; }
  50% { opacity: 0.4; }
}

@keyframes kimi-bloom {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 0.85; }
}

@keyframes nucleus-breathe {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.7; }
}

@keyframes nucleus-breathe-fast {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 0.9; }
}

@keyframes nucleus-breathe-slow {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 0.6; }
}

@keyframes nucleus-compress {
  0%, 100% { r: 5px; }
  50% { r: 4px; fill: rgba(56 189 248 / 0.7); }
}

@keyframes nucleus-expand {
  0%, 100% { r: 5px; }
  50% { r: 7px; }
}

@keyframes jitter-ring {
  0%, 100% { transform: translate(0, 0); }
  25% { transform: translate(0.5px, -0.3px); }
  50% { transform: translate(-0.5px, 0.3px); }
  75% { transform: translate(0.3px, 0.2px); }
}

@keyframes jitter-line {
  0%, 100% { opacity: 0.3; transform: translate(0, 0); }
  25% { opacity: 0.7; transform: translate(0.5px, -0.5px); }
  50% { opacity: 0.3; transform: translate(0, 0); }
  75% { opacity: 0.7; transform: translate(-0.5px, 0.5px); }
}

/* Label strip */
.core-label-strip {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.75rem;
  font-family: var(--synax-font);
  font-size: 0.7rem;
  color: var(--synax-text-muted);
  transition: color 0.6s ease;
}

.core-label-model {
  color: var(--core-local-color);
  font-weight: 500;
}

.core-label-sep {
  opacity: 0.4;
}

.core-label-state {
  opacity: 0.7;
}

@media (prefers-reduced-motion: reduce) {
  .ai-core-svg * {
    animation: none !important;
  }
}
</style>
