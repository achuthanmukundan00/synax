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
        <a href="/guide/getting-started" class="cta-primary">Install</a>
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
        <h3>Stateful, not chatty.</h3>
        <p>Synax shows what the agent is doing without turning the interface into log sludge.</p>
      </div>
      <div class="principle-card">
        <h3>Contained, not chaotic.</h3>
        <p>Failures are surfaced as runtime states, not buried in noise.</p>
      </div>
      <div class="principle-card">
        <h3>Local-first, cloud-compatible.</h3>
        <p>Use Qwen, DeepSeek, OpenAI, Kimi, or anything behind a compatible endpoint.</p>
      </div>
    </section>

    <!-- Docs entry -->
    <section class="landing-docs-entry">
      <h2>Contained intelligence runtime.</h2>
      <p>Synax gives coding agents a stateful shell: model identity, tool execution, verification, and failure containment.</p>
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
  color: string
  headline: string
  subcopy: string
  terminal: [string, string][]
  motion: string
}

const cores: CoreDef[] = [
  {
    id: 'unloaded',
    name: 'Core unloaded',
    model: 'none',
    provider: 'none',
    state: 'blocked',
    context: '0 / 0',
    color: '120 120 120',
    headline: 'No core loaded.',
    subcopy: 'Synax does not pretend to be ready before a model is configured.',
    terminal: [
      ['core', 'unloaded'],
      ['state', 'blocked'],
      ['reason', 'provider.model is required'],
      ['next', 'configure synax.toml'],
    ],
    motion: 'still',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    model: 'qwen-coder',
    provider: 'relay',
    state: 'ready',
    context: '0 / 32768',
    color: '236 72 153',
    headline: 'Fast local cognition.',
    subcopy: 'Qwen feels nimble, surgical, and close to the metal.',
    terminal: [
      ['core', 'qwen-coder'],
      ['provider', 'relay (local)'],
      ['state', 'ready'],
      ['ctx', '0 / 32768'],
    ],
    motion: 'lattice',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    model: 'deepseek-coder',
    provider: 'relay',
    state: 'ready',
    context: '0 / 65536',
    color: '56 189 248',
    headline: 'Deep reasoning under containment.',
    subcopy: 'DeepSeek feels heavier, deeper, and more deliberate.',
    terminal: [
      ['core', 'deepseek-coder'],
      ['provider', 'relay (local)'],
      ['state', 'ready'],
      ['ctx', '0 / 65536'],
    ],
    motion: 'furnace',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    model: 'gpt-4o',
    provider: 'openai',
    state: 'ready',
    context: '0 / 128000',
    color: '212 212 216',
    headline: 'Cloud-grade reasoning, locally orchestrated.',
    subcopy: 'OpenAI feels clean, stable, and precise inside Synax.',
    terminal: [
      ['core', 'gpt-4o'],
      ['provider', 'openai'],
      ['state', 'ready'],
      ['ctx', '0 / 128000'],
    ],
    motion: 'lens',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    model: 'kimi-k2',
    provider: 'moonshot',
    state: 'ready',
    context: '0 / 131072',
    color: '180 180 200',
    headline: 'Wide-context intelligence.',
    subcopy: 'Kimi feels like a long-range scanner for large codebases and dense docs.',
    terminal: [
      ['core', 'kimi-k2'],
      ['provider', 'moonshot'],
      ['state', 'ready'],
      ['ctx', '0 / 131072'],
    ],
    motion: 'moon',
  },
  {
    id: 'working',
    name: 'Synax',
    model: 'qwen-coder',
    provider: 'relay',
    state: 'active',
    context: '12420 / 32768',
    color: '163 230 53',
    headline: 'The runtime is alive.',
    subcopy: 'Watch the system move through planning, tool use, edits, and verification.',
    terminal: [
      ['core', 'qwen-coder'],
      ['state', 'active'],
      ['phase', 'tool.run'],
      ['tool', 'read / verify'],
    ],
    motion: 'breathe',
  },
  {
    id: 'error',
    name: 'Synax',
    model: 'qwen-coder',
    provider: 'relay',
    state: 'fault',
    context: '12420 / 32768',
    color: '239 68 68',
    headline: 'Failure is surfaced, not hidden.',
    subcopy: 'Synax keeps faults visible, contained, and actionable.',
    terminal: [
      ['core', 'qwen-coder'],
      ['state', 'fault'],
      ['error', 'tool.parse_failure'],
      ['action', 'retry / inspect'],
    ],
    motion: 'jitter',
  },
]

const currentIndex = ref(0)
const currentCore = computed(() => cores[currentIndex.value])
const prefersReducedMotion = ref(false)

let intervalId: ReturnType<typeof setInterval> | null = null

const pageStyle = computed(() => ({
  '--core-rgb': currentCore.value.color,
  '--core-color': `rgb(${currentCore.value.color})`,
  '--core-glow': `0 0 40px rgba(${currentCore.value.color} / 0.4), 0 0 80px rgba(${currentCore.value.color} / 0.15)`,
  '--core-glow-soft': `0 0 25px rgba(${currentCore.value.color} / 0.25)`,
  '--core-border': `rgba(${currentCore.value.color} / 0.5)`,
}))

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
