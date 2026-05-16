<template>
  <div class="landing-page" :style="pageStyle">
    <!-- Minimal top nav -->
    <nav class="landing-nav">
      <a href="/" class="landing-nav-brand">Synax</a>
      <div class="landing-nav-links">
        <a href="/guide/getting-started">Docs</a>
        <a href="https://github.com/achuthanmukundan00/synax" target="_blank" rel="noopener">GitHub</a>
      </div>
    </nav>

    <!-- Ambient glow -->
    <div class="landing-ambient"></div>

    <!-- Hero -->
    <section class="landing-hero">
      <!-- AI Core -->
      <div class="landing-core-wrap">
        <AiCore :core="currentCore" />
      </div>

      <!-- Headline -->
      <h1 class="landing-headline">{{ currentCore.headline }}</h1>

      <!-- Subcopy -->
      <p class="landing-subcopy">{{ currentCore.subheadline }}</p>

      <!-- CTAs -->
      <div class="landing-ctas">
        <a href="/guide/getting-started" class="cta-primary">Get started</a>
        <a href="/guide/getting-started" class="cta-secondary">Read the docs</a>
        <a href="https://github.com/achuthanmukundan00/synax" class="cta-secondary" target="_blank" rel="noopener"
          >GitHub</a
        >
      </div>

      <!-- Runtime status strip -->
      <div class="landing-runtime">
        <RuntimePanel :core="currentCore" />
      </div>

      <!-- Measured transcript hero -->
      <div class="landing-transcript">
        <CoreTranscriptHero :core="currentCore" />
      </div>
    </section>

    <!-- Principle cards -->
    <section class="landing-principles">
      <div class="principle-card">
        <h3>Multi-provider routing.</h3>
        <p>
          Local Relay. Cloud APIs. Anthropic Messages. OpenRouter. One agent loop routes reads, edits, and tool calls
          through any OpenAI-compatible endpoint.
        </p>
      </div>
      <div class="principle-card">
        <h3>Native tool-call parsers.</h3>
        <p>
          26 model families parsed natively. Qwen XML, Hermes JSON, Llama Pythonic, DeepSeek, Mistral — Synax extracts
          tool calls from raw model output without vLLM normalization.
        </p>
      </div>
      <div class="principle-card">
        <h3>Contained, not chaotic.</h3>
        <p>
          Budget-aware context compaction. Observable runtime states. Verification lifecycle tracking. Failures are
          surfaced, not buried in noise.
        </p>
      </div>
    </section>

    <!-- Docs entry -->
    <section class="landing-docs-entry">
      <h2>Local models, real work.</h2>
      <p>
        Synax is a local-first coding agent built for developers running open-weight models on consumer GPUs. It gives
        local, open, and low-cost models a stateful runtime — containment, tool execution, verification, and failure
        handling — plus native tool-call parsers that keep you independent of server-side normalization.
        Provider-compatible when you need a fallback, local-first by default.
      </p>
      <a href="/guide/getting-started">→ Read the docs</a>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AiCore from './AiCore.vue';
import RuntimePanel from './RuntimePanel.vue';
import CoreTranscriptHero from './CoreTranscriptHero.vue';
import { buildRuntimeScene, runtimeScenes } from '../runtime-core';

const currentIndex = ref(0);
const currentCore = computed(() => buildRuntimeScene(runtimeScenes[currentIndex.value]));
const prefersReducedMotion = ref(false);

let intervalId: ReturnType<typeof setInterval> | null = null;

const pageStyle = computed(() => {
  const rgb = currentCore.value.palette.stateRgb;
  const hotRgb = currentCore.value.palette.hotRgb;
  const shellRgb = currentCore.value.palette.shellRgb;
  const lowRgb = currentCore.value.palette.lowRgb;
  const profileRgb = currentCore.value.profile.accentRgb;

  return {
    '--state-rgb': rgb,
    '--state-hot-rgb': hotRgb,
    '--state-shell-rgb': shellRgb,
    '--state-low-rgb': lowRgb,
    '--profile-rgb': profileRgb,
    '--scene-intensity': String(currentCore.value.intensity),
    '--core-rgb': rgb,
    '--core-color': `rgb(${rgb})`,
    '--core-glow': `0 0 40px rgba(${rgb} / 0.3), 0 0 80px rgba(${rgb} / 0.1)`,
    '--core-glow-soft': `0 0 25px rgba(${rgb} / 0.2)`,
    '--core-border': `rgba(${rgb} / 0.4)`,
  };
});

function nextCore() {
  currentIndex.value = (currentIndex.value + 1) % runtimeScenes.length;
}

onMounted(() => {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  prefersReducedMotion.value = mq.matches;

  if (!mq.matches) {
    intervalId = setInterval(nextCore, 5000);
  }

  const handler = (e: MediaQueryListEvent) => {
    prefersReducedMotion.value = e.matches;
    if (e.matches && intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    } else if (!e.matches && !intervalId) {
      intervalId = setInterval(nextCore, 5000);
    }
  };
  mq.addEventListener('change', handler);
});

onUnmounted(() => {
  if (intervalId) {
    clearInterval(intervalId);
  }
});
</script>
