<template>
  <div
    class="ai-core"
    :class="[`model-${core.modelProfile}`, `state-${core.runtimeState}`]"
  >
    <svg
      viewBox="0 0 300 320"
      xmlns="http://www.w3.org/2000/svg"
      class="ai-core-svg"
    >
      <defs>
        <!-- Chamber glass fill gradient -->
        <linearGradient id="chamber-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="rgba(12, 16, 24, 0.65)" />
          <stop offset="50%" stop-color="rgba(8, 12, 18, 0.75)" />
          <stop offset="100%" stop-color="rgba(10, 14, 20, 0.6)" />
        </linearGradient>

        <!-- Chamber inner bevel (top highlight) -->
        <linearGradient id="chamber-bevel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(86, 141, 208, 0.12)" />
          <stop offset="15%" stop-color="rgba(86, 141, 208, 0.0)" />
          <stop offset="100%" stop-color="rgba(58, 109, 176, 0.06)" />
        </linearGradient>

        <!-- Nucleus glow radial -->
        <radialGradient id="nucleus-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="rgba(140, 180, 230, 0.9)" />
          <stop offset="30%" stop-color="rgba(86, 141, 208, 0.5)" />
          <stop offset="60%" stop-color="rgba(58, 109, 176, 0.15)" />
          <stop offset="100%" stop-color="rgba(58, 109, 176, 0)" />
        </radialGradient>

        <!-- Outer field ambient glow -->
        <radialGradient id="field-ambient" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stop-color="rgba(58, 109, 176, 0.12)" />
          <stop offset="60%" stop-color="rgba(58, 109, 176, 0.03)" />
          <stop offset="100%" stop-color="rgba(58, 109, 176, 0)" />
        </radialGradient>

        <!-- Scanline pattern -->
        <pattern id="scanlines" width="300" height="6" patternUnits="userSpaceOnUse">
          <rect width="300" height="3" fill="rgba(58, 109, 176, 0.04)" />
        </pattern>

        <!-- Blur filters -->
        <filter id="glow-soft">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <filter id="glow-med">
          <feGaussianBlur stdDeviation="6" />
        </filter>

        <!-- Chamber clip for internal elements -->
        <clipPath id="chamber-clip">
          <rect x="55" y="58" width="190" height="174" rx="18" />
        </clipPath>
      </defs>

      <!-- ===== Layer 0: Outer procedural field ===== -->
      <rect width="300" height="320" fill="transparent" />

      <!-- Ambient field glow -->
      <ellipse cx="150" cy="145" rx="140" ry="135" fill="url(#field-ambient)" class="field-ambient" />

      <!-- Outer delicate field ring 1 -->
      <ellipse
        cx="150" cy="145" rx="118" ry="113"
        fill="none"
        stroke="rgba(58, 109, 176, 0.12)"
        stroke-width="0.7"
        stroke-dasharray="3 18"
        class="field-ring-outer"
      />

      <!-- Outer field ring 2 -->
      <ellipse
        cx="150" cy="145" rx="112" ry="107"
        fill="none"
        stroke="rgba(58, 109, 176, 0.08)"
        stroke-width="0.5"
        stroke-dasharray="2 24"
        class="field-ring-mid"
      />

      <!-- Procedural field particles (restrained) -->
      <g class="field-particles" opacity="0.4">
        <circle cx="75" cy="80" r="1.2" fill="rgba(86, 141, 208, 0.5)" class="fp-1" />
        <circle cx="225" cy="90" r="1" fill="rgba(58, 109, 176, 0.4)" class="fp-2" />
        <circle cx="60" cy="170" r="0.8" fill="rgba(86, 141, 208, 0.35)" class="fp-3" />
        <circle cx="240" cy="160" r="1.1" fill="rgba(58, 109, 176, 0.45)" class="fp-4" />
        <circle cx="90" cy="230" r="0.9" fill="rgba(58, 109, 176, 0.3)" class="fp-5" />
        <circle cx="210" cy="220" r="0.8" fill="rgba(86, 141, 208, 0.3)" class="fp-6" />
        <circle cx="150" cy="58" r="1" fill="rgba(86, 141, 208, 0.4)" class="fp-7" />
        <circle cx="150" cy="250" r="0.7" fill="rgba(58, 109, 176, 0.3)" class="fp-8" />
      </g>

      <!-- ===== Layer 1: Chamber outer glow ===== -->
      <rect
        x="53" y="56" width="194" height="178" rx="19"
        fill="none"
        stroke="rgba(58, 109, 176, 0.15)"
        stroke-width="4"
        filter="url(#glow-med)"
        class="chamber-outer-glow"
      />

      <!-- ===== Layer 2: Chamber frame (the Synax brand object) ===== -->
      <!-- Main chamber stroke: blue-steel, visible in ALL states -->
      <rect
        x="55" y="58" width="190" height="174" rx="18"
        fill="url(#chamber-glass)"
        stroke="rgba(58, 109, 176, 0.45)"
        stroke-width="1.8"
        class="chamber-frame"
      />

      <!-- Chamber inner bevel highlight (glass panel edge) -->
      <rect
        x="56" y="59" width="188" height="172" rx="17"
        fill="url(#chamber-bevel)"
        stroke="none"
        class="chamber-bevel"
      />

      <!-- Chamber corner accents (╭╮╰╯ DNA) -->
      <g class="chamber-corners" opacity="0.5">
        <!-- Top-left ╭ -->
        <path d="M73,58 L55,58 L55,76" fill="none" stroke="rgba(86, 141, 208, 0.55)" stroke-width="1.2" />
        <!-- Top-right ╮ -->
        <path d="M227,58 L245,58 L245,76" fill="none" stroke="rgba(86, 141, 208, 0.55)" stroke-width="1.2" />
        <!-- Bottom-left ╰ -->
        <path d="M73,232 L55,232 L55,214" fill="none" stroke="rgba(86, 141, 208, 0.55)" stroke-width="1.2" />
        <!-- Bottom-right ╯ -->
        <path d="M227,232 L245,232 L245,214" fill="none" stroke="rgba(86, 141, 208, 0.55)" stroke-width="1.2" />
      </g>

      <!-- ===== Layer 3: Chamber interior (clipped) ===== -->
      <g clip-path="url(#chamber-clip)">
        <!-- Scanlines across chamber -->
        <rect x="55" y="58" width="190" height="174" fill="url(#scanlines)" class="chamber-scanlines" />

        <!-- Vertical center divider (subtle) -->
        <line x1="150" y1="58" x2="150" y2="232" stroke="rgba(58, 109, 176, 0.08)" stroke-width="0.5" class="chamber-divider-v" />

        <!-- Horizontal center line (subtle) -->
        <line x1="55" y1="145" x2="245" y2="145" stroke="rgba(58, 109, 176, 0.06)" stroke-width="0.5" class="chamber-divider-h" />

        <!-- ===== Layer 4: Model-specific morphology ===== -->

        <!-- LOCAL / DEFAULT: balanced contained geometry -->
        <g class="morph-local">
          <circle cx="150" cy="145" r="52" fill="none" stroke="rgba(58, 109, 176, 0.1)" stroke-width="0.7" />
          <circle cx="150" cy="145" r="36" fill="none" stroke="rgba(58, 109, 176, 0.08)" stroke-width="0.5" stroke-dasharray="4 6" />
        </g>

        <!-- QWEN: lattice diagonal structure -->
        <g class="morph-qwen">
          <!-- Lattice diagonals -->
          <line x1="80" y1="85" x2="140" y2="145" stroke="rgba(96, 136, 188, 0.18)" stroke-width="0.7" />
          <line x1="160" y1="145" x2="220" y2="85" stroke="rgba(96, 136, 188, 0.18)" stroke-width="0.7" />
          <line x1="80" y1="205" x2="140" y2="145" stroke="rgba(96, 136, 188, 0.18)" stroke-width="0.7" />
          <line x1="160" y1="145" x2="220" y2="205" stroke="rgba(96, 136, 188, 0.18)" stroke-width="0.7" />
          <!-- Lattice cross points -->
          <circle cx="110" cy="115" r="1.5" fill="rgba(96, 136, 188, 0.35)" class="lattice-node lattice-n1" />
          <circle cx="190" cy="115" r="1.5" fill="rgba(96, 136, 188, 0.35)" class="lattice-node lattice-n2" />
          <circle cx="110" cy="175" r="1.5" fill="rgba(96, 136, 188, 0.35)" class="lattice-node lattice-n3" />
          <circle cx="190" cy="175" r="1.5" fill="rgba(96, 136, 188, 0.35)" class="lattice-node lattice-n4" />
          <!-- Angular inner ring -->
          <polygon points="150,105 178,128 170,162 150,185 130,162 122,128"
            fill="none" stroke="rgba(96, 136, 188, 0.2)" stroke-width="0.8" />
        </g>

        <!-- DEEPSEEK: compressed furnace band -->
        <g class="morph-deepseek">
          <!-- Heavy horizontal scan bands -->
          <rect x="70" y="130" width="160" height="3" fill="rgba(75, 111, 166, 0.25)" class="furnace-band fb-1" />
          <rect x="75" y="137" width="150" height="2" fill="rgba(75, 111, 166, 0.18)" class="furnace-band fb-2" />
          <rect x="70" y="155" width="160" height="3" fill="rgba(75, 111, 166, 0.22)" class="furnace-band fb-3" />
          <rect x="80" y="162" width="140" height="1.5" fill="rgba(75, 111, 166, 0.14)" class="furnace-band fb-4" />
          <!-- Compressed inner ellipse -->
          <ellipse cx="150" cy="145" rx="28" ry="20" fill="none" stroke="rgba(75, 111, 166, 0.2)" stroke-width="0.8" />
        </g>

        <!-- OPENAI: clean centered lens -->
        <g class="morph-openai">
          <circle cx="150" cy="145" r="48" fill="none" stroke="rgba(112, 151, 178, 0.1)" stroke-width="0.7" />
          <circle cx="150" cy="145" r="32" fill="none" stroke="rgba(112, 151, 178, 0.12)" stroke-width="0.6" />
          <circle cx="150" cy="145" r="20" fill="none" stroke="rgba(112, 151, 178, 0.15)" stroke-width="0.5" />
        </g>

        <!-- CLAUDE: soft organic aperture -->
        <g class="morph-claude">
          <circle cx="150" cy="145" r="50" fill="none" stroke="rgba(172, 126, 88, 0.1)" stroke-width="0.8" />
          <circle cx="150" cy="145" r="38" fill="none" stroke="rgba(172, 126, 88, 0.12)" stroke-width="0.6" stroke-dasharray="5 8" />
          <!-- Soft bloom dots -->
          <circle cx="118" cy="130" r="1.2" fill="rgba(172, 126, 88, 0.2)" class="bloom-dot bd-1" />
          <circle cx="182" cy="130" r="1.2" fill="rgba(172, 126, 88, 0.2)" class="bloom-dot bd-2" />
          <circle cx="118" cy="160" r="1.2" fill="rgba(172, 126, 88, 0.2)" class="bloom-dot bd-3" />
          <circle cx="182" cy="160" r="1.2" fill="rgba(172, 126, 88, 0.2)" class="bloom-dot bd-4" />
        </g>

        <!-- GEMINI: twin nucleus field -->
        <g class="morph-gemini">
          <!-- Mirror line -->
          <line x1="150" y1="80" x2="150" y2="210" stroke="rgba(86, 129, 184, 0.08)" stroke-width="0.5" />
          <!-- Twin orbits -->
          <circle cx="135" cy="145" r="18" fill="none" stroke="rgba(86, 129, 184, 0.12)" stroke-width="0.6" class="twin-orbit-left" />
          <circle cx="165" cy="145" r="18" fill="none" stroke="rgba(86, 129, 184, 0.12)" stroke-width="0.6" class="twin-orbit-right" />
        </g>
      </g>

      <!-- ===== Layer 5: Nucleus ===== -->
      <g class="nucleus-group">
        <!-- Outer nucleus glow -->
        <circle cx="150" cy="145" r="22" fill="url(#nucleus-glow)" class="nucleus-outer-glow" />

        <!-- Nucleus ring -->
        <circle cx="150" cy="145" r="13" fill="none" stroke="rgba(86, 141, 208, 0.35)" stroke-width="0.8" class="nucleus-ring" />

        <!-- Nucleus core -->
        <circle cx="150" cy="145" r="5" fill="rgba(140, 180, 230, 0.85)" class="nucleus-core" />

        <!-- Twin nucleus (Gemini) -->
        <g class="nucleus-twin">
          <circle cx="140" cy="145" r="3.5" fill="rgba(120, 165, 220, 0.8)" class="twin-nuc-left" />
          <circle cx="160" cy="145" r="3.5" fill="rgba(120, 165, 220, 0.8)" class="twin-nuc-right" />
          <line x1="144" y1="145" x2="156" y2="145" stroke="rgba(86, 141, 208, 0.2)" stroke-width="0.5" />
        </g>
      </g>

      <!-- ===== Layer 6: State overlay effects ===== -->

      <!-- Working: active scanline sweep -->
      <g class="state-working-overlay" clip-path="url(#chamber-clip)">
        <rect x="55" y="58" width="190" height="3" fill="rgba(140, 200, 240, 0.15)" class="working-scan" />
      </g>

      <!-- Error: containment fracture marks -->
      <g class="state-error-overlay">
        <!-- Edge fractures near chamber walls -->
        <line x1="80" y1="62" x2="92" y2="74" stroke="rgba(239, 68, 68, 0.45)" stroke-width="1" class="error-fracture ef-1" />
        <line x1="220" y1="62" x2="208" y2="74" stroke="rgba(239, 68, 68, 0.4)" stroke-width="1" class="error-fracture ef-2" />
        <line x1="80" y1="228" x2="92" y2="216" stroke="rgba(239, 68, 68, 0.38)" stroke-width="1" class="error-fracture ef-3" />
        <line x1="220" y1="228" x2="208" y2="216" stroke="rgba(239, 68, 68, 0.35)" stroke-width="1" class="error-fracture ef-4" />
        <!-- Nucleus red tinge -->
        <circle cx="150" cy="145" r="8" fill="none" stroke="rgba(239, 68, 68, 0.2)" stroke-width="1.5" class="error-nucleus-ring" />
      </g>

      <!-- Succeeded: calm resolve pulse -->
      <g class="state-succeeded-overlay">
        <circle cx="150" cy="145" r="30" fill="none" stroke="rgba(86, 180, 140, 0.12)" stroke-width="1.5" class="succeeded-ring" />
      </g>
    </svg>

    <!-- Runtime label strip -->
    <div class="core-label-strip" v-if="showLabel">
      <span class="core-label-model">{{ core.name }}</span>
      <span class="core-label-sep">·</span>
      <span class="core-label-state">{{ core.state }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
interface CoreDef {
  id: string
  name: string
  model: string
  provider: string
  state: string
  context: string
  headline: string
  subcopy: string
  terminal: [string, string][]
  modelProfile: string
  runtimeState: string
}

withDefaults(defineProps<{
  core: CoreDef
  showLabel?: boolean
}>(), {
  showLabel: true,
})
</script>

<style scoped>
.ai-core {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
}

.ai-core-svg {
  width: 260px;
  height: 280px;
}

/* ===== Base: all elements start at rest ===== */
.chamber-frame {
  transition: stroke 0.8s ease, opacity 0.8s ease;
}
.chamber-corners {
  transition: opacity 0.8s ease;
}
.chamber-scanlines {
  transition: opacity 0.8s ease;
}

/* ===== MODEL: unloaded ===== */
.model-unloaded .chamber-frame {
  stroke: rgba(90, 90, 90, 0.3);
}
.model-unloaded .chamber-outer-glow {
  opacity: 0.3;
}
.model-unloaded .chamber-corners {
  opacity: 0.15;
}
.model-unloaded .chamber-bevel {
  opacity: 0.3;
}
.model-unloaded .field-ambient {
  opacity: 0.25;
}
.model-unloaded .field-particles {
  opacity: 0.12;
}
.model-unloaded .field-ring-outer,
.model-unloaded .field-ring-mid {
  opacity: 0.2;
}
.model-unloaded .nucleus-outer-glow {
  opacity: 0.15;
}
.model-unloaded .nucleus-ring {
  opacity: 0.2;
}
.model-unloaded .nucleus-core {
  opacity: 0.3;
  r: 3px;
}
.model-unloaded .nucleus-twin {
  display: none;
}
.model-unloaded .morph-qwen,
.model-unloaded .morph-deepseek,
.model-unloaded .morph-openai,
.model-unloaded .morph-claude,
.model-unloaded .morph-gemini {
  display: none;
}
.model-unloaded .morph-local {
  display: none;
}
.model-unloaded .chamber-scanlines {
  opacity: 0.3;
}

/* ===== MODEL: local (default contained) ===== */
.model-local .chamber-frame {
  stroke: rgba(58, 109, 176, 0.42);
}
.model-local .morph-qwen,
.model-local .morph-deepseek,
.model-local .morph-openai,
.model-local .morph-claude,
.model-local .morph-gemini {
  display: none;
}
.model-local .morph-local {
  display: block;
}
.model-local .nucleus-twin {
  display: none;
}

/* ===== MODEL: qwen (lattice) ===== */
.model-qwen .chamber-frame {
  stroke: rgba(58, 109, 176, 0.44);
}
.model-qwen .morph-local,
.model-qwen .morph-deepseek,
.model-qwen .morph-openai,
.model-qwen .morph-claude,
.model-qwen .morph-gemini {
  display: none;
}
.model-qwen .morph-qwen {
  display: block;
}
.model-qwen .nucleus-twin {
  display: none;
}

/* ===== MODEL: deepseek (furnace) ===== */
.model-deepseek .chamber-frame {
  stroke: rgba(58, 109, 176, 0.43);
}
.model-deepseek .morph-local,
.model-deepseek .morph-qwen,
.model-deepseek .morph-openai,
.model-deepseek .morph-claude,
.model-deepseek .morph-gemini {
  display: none;
}
.model-deepseek .morph-deepseek {
  display: block;
}
.model-deepseek .nucleus-twin {
  display: none;
}

/* ===== MODEL: openai (lens) ===== */
.model-openai .chamber-frame {
  stroke: rgba(58, 109, 176, 0.42);
}
.model-openai .morph-local,
.model-openai .morph-qwen,
.model-openai .morph-deepseek,
.model-openai .morph-claude,
.model-openai .morph-gemini {
  display: none;
}
.model-openai .morph-openai {
  display: block;
}
.model-openai .nucleus-twin {
  display: none;
}

/* ===== MODEL: claude (organic aperture) ===== */
.model-claude .chamber-frame {
  stroke: rgba(58, 109, 176, 0.42);
}
.model-claude .morph-local,
.model-claude .morph-qwen,
.model-claude .morph-deepseek,
.model-claude .morph-openai,
.model-claude .morph-gemini {
  display: none;
}
.model-claude .morph-claude {
  display: block;
}
.model-claude .nucleus-twin {
  display: none;
}

/* ===== MODEL: gemini (twin) ===== */
.model-gemini .chamber-frame {
  stroke: rgba(58, 109, 176, 0.43);
}
.model-gemini .morph-local,
.model-gemini .morph-qwen,
.model-gemini .morph-deepseek,
.model-gemini .morph-openai,
.model-gemini .morph-claude {
  display: none;
}
.model-gemini .morph-gemini {
  display: block;
}
.model-gemini .nucleus-twin {
  display: block;
}
.model-gemini .nucleus-core {
  display: none;
}
.model-gemini .nucleus-ring {
  display: none;
}

/* ===== STATE: unloaded (dead) ===== */
.state-unloaded .field-particles {
  animation: none;
}
.state-unloaded .nucleus-outer-glow {
  animation: none;
}

/* ===== STATE: idle (breathing) ===== */
.state-idle .nucleus-outer-glow {
  animation: nucleus-breathe 3s ease-in-out infinite;
}
.state-idle .field-particles {
  animation: field-drift 6s ease-in-out infinite;
}
.state-idle .field-ring-outer {
  animation: ring-breathe 4s ease-in-out infinite;
}

/* ===== STATE: working (active pulse) ===== */
.state-working .nucleus-outer-glow {
  animation: nucleus-pulse-active 1.2s ease-in-out infinite;
}
.state-working .nucleus-core {
  animation: nucleus-expand 1.2s ease-in-out infinite;
}
.state-working .nucleus-ring {
  animation: ring-pulse-active 1.2s ease-in-out infinite;
}
.state-working .chamber-scanlines {
  opacity: 0.7;
}
.state-working .field-particles {
  animation: field-drift-fast 3s ease-in-out infinite;
  opacity: 0.6;
}
.state-working .working-scan {
  animation: scan-sweep 2s ease-in-out infinite;
}
.state-working .state-working-overlay {
  display: block;
}

/* ===== STATE: succeeded (resolved calm) ===== */
.state-succeeded .nucleus-outer-glow {
  animation: nucleus-breathe 2.5s ease-in-out infinite;
}
.state-succeeded .succeeded-ring {
  animation: succeeded-pulse 2s ease-in-out infinite;
}
.state-succeeded .state-succeeded-overlay {
  display: block;
}

/* ===== STATE: error (fracture) ===== */
.state-error .chamber-frame {
  animation: chamber-jitter 0.4s ease-in-out infinite;
}
.state-error .chamber-corners {
  animation: corner-flicker 0.6s ease-in-out infinite;
}
.state-error .nucleus-outer-glow {
  animation: nucleus-error-pulse 1.5s ease-in-out infinite;
}
.state-error .error-fracture {
  animation: fracture-flicker 0.8s ease-in-out infinite;
}
.state-error .ef-2 { animation-delay: 0.15s; }
.state-error .ef-3 { animation-delay: 0.3s; }
.state-error .ef-4 { animation-delay: 0.45s; }
.state-error .error-nucleus-ring {
  animation: error-ring-pulse 1s ease-in-out infinite;
}
.state-error .state-error-overlay {
  display: block;
}
.state-error .field-particles {
  animation: field-jitter 0.5s ease-in-out infinite;
}

/* Hide state overlays by default */
.state-working-overlay,
.state-error-overlay,
.state-succeeded-overlay {
  display: none;
}

/* ===== Model-specific animations ===== */

/* Qwen lattice node pulse */
.model-qwen.state-idle .lattice-node,
.model-qwen.state-working .lattice-node {
  animation: lattice-node-pulse 2s ease-in-out infinite;
}
.model-qwen .lattice-n2 { animation-delay: 0.3s !important; }
.model-qwen .lattice-n3 { animation-delay: 0.6s !important; }
.model-qwen .lattice-n4 { animation-delay: 0.9s !important; }

/* DeepSeek furnace band pulse */
.model-deepseek.state-idle .furnace-band,
.model-deepseek.state-working .furnace-band {
  animation: furnace-pulse 3s ease-in-out infinite;
}
.model-deepseek .fb-2 { animation-delay: 0.5s !important; }
.model-deepseek .fb-3 { animation-delay: 1s !important; }
.model-deepseek .fb-4 { animation-delay: 1.5s !important; }

/* Claude bloom dots */
.model-claude.state-idle .bloom-dot {
  animation: bloom-breathe 3.5s ease-in-out infinite;
}
.model-claude .bd-2 { animation-delay: 0.5s; }
.model-claude .bd-3 { animation-delay: 1s; }
.model-claude .bd-4 { animation-delay: 1.5s; }

/* Gemini twin phase */
.model-gemini.state-idle .twin-nuc-left,
.model-gemini.state-working .twin-nuc-left {
  animation: twin-phase 2.5s ease-in-out infinite;
}
.model-gemini.state-idle .twin-nuc-right,
.model-gemini.state-working .twin-nuc-right {
  animation: twin-phase 2.5s ease-in-out infinite 1.25s;
}
.model-gemini.state-idle .twin-orbit-left {
  animation: twin-orbit-breathe 2.5s ease-in-out infinite;
}
.model-gemini.state-idle .twin-orbit-right {
  animation: twin-orbit-breathe 2.5s ease-in-out infinite 1.25s;
}

/* ===== Keyframes ===== */

@keyframes nucleus-breathe {
  0%, 100% { opacity: 0.5; r: 22px; }
  50% { opacity: 0.8; r: 25px; }
}

@keyframes nucleus-pulse-active {
  0%, 100% { opacity: 0.6; r: 22px; }
  50% { opacity: 1; r: 28px; }
}

@keyframes nucleus-expand {
  0%, 100% { r: 5px; opacity: 0.85; }
  50% { r: 7px; opacity: 1; }
}

@keyframes nucleus-error-pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 0.8; }
}

@keyframes ring-breathe {
  0%, 100% { opacity: 0.1; }
  50% { opacity: 0.2; }
}

@keyframes ring-pulse-active {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 0.65; }
}

@keyframes field-drift {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 0.5; }
}

@keyframes field-drift-fast {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 0.7; }
}

@keyframes field-jitter {
  0%, 100% { transform: translate(0, 0); opacity: 0.4; }
  25% { transform: translate(0.5px, -0.3px); opacity: 0.6; }
  50% { transform: translate(-0.3px, 0.2px); opacity: 0.35; }
  75% { transform: translate(0.2px, 0.4px); opacity: 0.55; }
}

@keyframes scan-sweep {
  0% { transform: translateY(0); }
  50% { transform: translateY(170px); }
  100% { transform: translateY(0); }
}

@keyframes succeeded-pulse {
  0%, 100% { opacity: 0.08; r: 28px; }
  50% { opacity: 0.2; r: 34px; }
}

@keyframes chamber-jitter {
  0%, 100% { transform: translate(0, 0); }
  15% { transform: translate(0.4px, -0.2px); }
  30% { transform: translate(-0.3px, 0.3px); }
  45% { transform: translate(0.2px, -0.1px); }
  60% { transform: translate(-0.2px, 0.2px); }
  75% { transform: translate(0.1px, -0.3px); }
  90% { transform: translate(0, 0); }
}

@keyframes corner-flicker {
  0%, 100% { opacity: 0.4; }
  25% { opacity: 0.7; }
  50% { opacity: 0.3; }
  75% { opacity: 0.65; }
}

@keyframes fracture-flicker {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.65; }
}

@keyframes error-ring-pulse {
  0%, 100% { opacity: 0.15; r: 7px; }
  50% { opacity: 0.4; r: 10px; }
}

@keyframes lattice-node-pulse {
  0%, 100% { opacity: 0.3; r: 1.5px; }
  50% { opacity: 0.6; r: 2.2px; }
}

@keyframes furnace-pulse {
  0%, 100% { opacity: 0.15; }
  50% { opacity: 0.35; }
}

@keyframes bloom-breathe {
  0%, 100% { opacity: 0.15; r: 1.2px; }
  50% { opacity: 0.3; r: 1.8px; }
}

@keyframes twin-phase {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}

@keyframes twin-orbit-breathe {
  0%, 100% { opacity: 0.1; }
  50% { opacity: 0.22; }
}

/* ===== Label strip ===== */
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
  color: rgb(86, 141, 208);
  font-weight: 500;
}

.core-label-sep {
  opacity: 0.4;
}

.core-label-state {
  opacity: 0.7;
}

/* State-specific label colors */
.state-error .core-label-state {
  color: rgba(239, 68, 68, 0.8);
}
.state-working .core-label-state {
  color: rgba(140, 200, 240, 0.8);
}
.state-succeeded .core-label-state {
  color: rgba(86, 180, 140, 0.7);
}
.state-unloaded .core-label-model {
  color: rgba(90, 90, 90, 0.6);
}

/* ===== Reduced motion ===== */
@media (prefers-reduced-motion: reduce) {
  .ai-core-svg * {
    animation: none !important;
  }
}
</style>
