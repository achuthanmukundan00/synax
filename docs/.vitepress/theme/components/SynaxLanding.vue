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
      <p class="landing-subcopy">{{ currentCore.subcopy }}</p>

      <!-- CTAs -->
      <div class="landing-ctas">
        <a href="/guide/getting-started" class="cta-primary">Get started</a>
        <a href="/guide/getting-started" class="cta-secondary">Read the docs</a>
        <a href="https://github.com/achuthanmukundan00/synax" class="cta-secondary" target="_blank" rel="noopener">GitHub</a>
      </div>

      <!-- Runtime status strip -->
      <div class="landing-runtime">
        <RuntimePanel :core="currentCore" />
      </div>

      <!-- Terminal preview -->
      <div class="landing-terminal">
        <TerminalPreview :core="currentCore" />
      </div>
    </section>

    <!-- Principle cards -->
    <section class="landing-principles">
      <div class="principle-card">
        <h3>Observable runtime.</h3>
        <p>See when the model is loaded. See when it is working. See when tools are active. See when the run succeeds or fails.</p>
      </div>
      <div class="principle-card">
        <h3>Local models, real work.</h3>
        <p>Run agent workflows on open-weight models and consumer GPUs. No cloud required. Compatible with any OpenAI-compatible endpoint.</p>
      </div>
      <div class="principle-card">
        <h3>Contained, not chaotic.</h3>
        <p>Failures are surfaced as runtime states, not buried in noise. The chamber holds &mdash; the model thinks &mdash; the state shows.</p>
      </div>
    </section>

    <!-- Docs entry -->
    <section class="landing-docs-entry">
      <h2>Make local models useful.</h2>
      <p>Synax is a local-first coding agent that gives local, open, and low-cost models a stateful runtime: containment, tool execution, verification, and failure handling. Provider-compatible when you need a fallback, local-first by default.</p>
      <a href="/guide/getting-started">→ Read the docs</a>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import AiCore from './AiCore.vue'
import RuntimePanel from './RuntimePanel.vue'
import TerminalPreview from './TerminalPreview.vue'

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
  chamberColor: string
}

const cores: CoreDef[] = [
  {
    id: 'unloaded',
    name: 'Synax',
    model: 'none',
    provider: '—',
    state: 'unloaded',
    context: '—',
    headline: 'No model loaded.',
    subcopy: 'Configure a local, open, or compatible model to activate the runtime.',
    terminal: [
      ['core', 'unloaded'],
      ['state', 'unloaded'],
      ['action', 'synax config'],
    ],
    modelProfile: 'unloaded',
    runtimeState: 'unloaded',
    chamberColor: '90 90 90',
  },
  {
    id: 'local-idle',
    name: 'Synax',
    model: 'local-model',
    provider: 'relay (local)',
    state: 'idle',
    context: '0 / 32768',
    headline: 'Local models, real work.',
    subcopy: 'Open-weight models running on consumer GPUs. No cloud required. Practical, unfancy, effective.',
    terminal: [
      ['core', 'local-model'],
      ['provider', 'relay (local)'],
      ['state', 'idle'],
      ['ctx', '0 / 32768'],
    ],
    modelProfile: 'local',
    runtimeState: 'idle',
    chamberColor: '58 109 176',
  },
  {
    id: 'qwen-idle',
    name: 'Qwen',
    model: 'qwen-coder',
    provider: 'relay (local)',
    state: 'idle',
    context: '0 / 32768',
    headline: 'Sharp, lattice-like cognition.',
    subcopy: 'Qwen feels nimble and surgical inside the Synax containment runtime.',
    terminal: [
      ['core', 'qwen-coder'],
      ['provider', 'relay (local)'],
      ['state', 'idle'],
      ['ctx', '0 / 32768'],
    ],
    modelProfile: 'qwen',
    runtimeState: 'idle',
    chamberColor: '58 109 176',
  },
  {
    id: 'qwen-working',
    name: 'Qwen',
    model: 'qwen-coder',
    provider: 'relay (local)',
    state: 'working',
    context: '12420 / 32768',
    headline: 'The runtime is working.',
    subcopy: 'Tools are active. Watch the agent read, edit, and verify. Local models need observability.',
    terminal: [
      ['core', 'qwen-coder'],
      ['state', 'working'],
      ['phase', 'tool.read → tool.edit'],
      ['ctx', '12420 / 32768'],
    ],
    modelProfile: 'qwen',
    runtimeState: 'working',
    chamberColor: '58 109 176',
  },
  {
    id: 'deepseek-idle',
    name: 'DeepSeek',
    model: 'deepseek-coder',
    provider: 'relay (local)',
    state: 'idle',
    context: '0 / 65536',
    headline: 'Dense, compressed reasoning.',
    subcopy: 'DeepSeek brings deeper inference pressure under the Synax containment chamber.',
    terminal: [
      ['core', 'deepseek-coder'],
      ['provider', 'relay (local)'],
      ['state', 'idle'],
      ['ctx', '0 / 65536'],
    ],
    modelProfile: 'deepseek',
    runtimeState: 'idle',
    chamberColor: '58 109 176',
  },
  {
    id: 'openai-idle',
    name: 'OpenAI',
    model: 'gpt-4o',
    provider: 'openai',
    state: 'idle',
    context: '0 / 128000',
    headline: 'Clean, centered, compatible.',
    subcopy: 'OpenAI models work inside Synax when you need cloud-grade fallback. The chamber stays Synax.',
    terminal: [
      ['core', 'gpt-4o'],
      ['provider', 'openai'],
      ['state', 'idle'],
      ['ctx', '0 / 128000'],
    ],
    modelProfile: 'openai',
    runtimeState: 'idle',
    chamberColor: '58 109 176',
  },
  {
    id: 'qwen-error',
    name: 'Qwen',
    model: 'qwen-coder',
    provider: 'relay (local)',
    state: 'error',
    context: '12420 / 32768',
    headline: 'Failure is surfaced, not hidden.',
    subcopy: 'Synax keeps errors visible, contained, and actionable. The chamber holds even when the model faults.',
    terminal: [
      ['core', 'qwen-coder'],
      ['state', 'error'],
      ['error', 'tool.parse_failure'],
      ['action', 'retry / inspect'],
    ],
    modelProfile: 'qwen',
    runtimeState: 'error',
    chamberColor: '58 109 176',
  },
  {
    id: 'local-working',
    name: 'Synax',
    model: 'local-model',
    provider: 'relay (local)',
    state: 'working',
    context: '8420 / 32768',
    headline: 'Consumer GPU. Real agent. Real work.',
    subcopy: 'Local models are powerful, but you need observability. Synax shows you what your agent is doing.',
    terminal: [
      ['core', 'local-model'],
      ['state', 'working'],
      ['tool', 'bash → verify'],
      ['ctx', '8420 / 32768'],
    ],
    modelProfile: 'local',
    runtimeState: 'working',
    chamberColor: '58 109 176',
  },
  {
    id: 'qwen-succeeded',
    name: 'Qwen',
    model: 'qwen-coder',
    provider: 'relay (local)',
    state: 'succeeded',
    context: '31200 / 32768',
    headline: 'Run complete. Resolved.',
    subcopy: 'The agent finished cleanly. Verification passed. The chamber returns to idle.',
    terminal: [
      ['core', 'qwen-coder'],
      ['state', 'succeeded'],
      ['result', 'verification passed'],
      ['ctx', '31200 / 32768'],
    ],
    modelProfile: 'qwen',
    runtimeState: 'succeeded',
    chamberColor: '58 109 176',
  },
]

const currentIndex = ref(0)
const currentCore = computed(() => cores[currentIndex.value])
const prefersReducedMotion = ref(false)

let intervalId: ReturnType<typeof setInterval> | null = null

const pageStyle = computed(() => {
  const rgb = currentCore.value.chamberColor
  return {
    '--core-rgb': rgb,
    '--core-color': `rgb(${rgb})`,
    '--core-glow': `0 0 40px rgba(${rgb} / 0.3), 0 0 80px rgba(${rgb} / 0.1)`,
    '--core-glow-soft': `0 0 25px rgba(${rgb} / 0.2)`,
    '--core-border': `rgba(${rgb} / 0.4)`,
  }
})

function nextCore() {
  currentIndex.value = (currentIndex.value + 1) % cores.length
}

onMounted(() => {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  prefersReducedMotion.value = mq.matches

  if (!mq.matches) {
    intervalId = setInterval(nextCore, 5000)
  }

  const handler = (e: MediaQueryListEvent) => {
    prefersReducedMotion.value = e.matches
    if (e.matches && intervalId) {
      clearInterval(intervalId)
      intervalId = null
    } else if (!e.matches && !intervalId) {
      intervalId = setInterval(nextCore, 5000)
    }
  }
  mq.addEventListener('change', handler)
})

onUnmounted(() => {
  if (intervalId) {
    clearInterval(intervalId)
  }
})
</script>
