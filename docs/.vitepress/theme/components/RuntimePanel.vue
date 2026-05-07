<template>
  <div class="runtime-panel">
    <div class="runtime-row">
      <div class="runtime-item">
        <span class="runtime-label">core</span>
        <span class="runtime-value" :class="valueClass">{{ core.name }}</span>
      </div>
      <div class="runtime-item">
        <span class="runtime-label">provider</span>
        <span class="runtime-value">{{ core.provider }}</span>
      </div>
      <div class="runtime-item">
        <span class="runtime-label">state</span>
        <span class="runtime-value state-value" :class="stateClass">{{ core.state }}</span>
      </div>
      <div class="runtime-item">
        <span class="runtime-label">ctx</span>
        <span class="runtime-value">{{ core.context }}</span>
      </div>
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
  headline: string
  subcopy: string
  terminal: [string, string][]
  modelProfile: string
  runtimeState: string
  chamberColor: string
}

const props = defineProps<{ core: CoreDef }>()

const valueClass = computed(() => `value-${props.core.modelProfile}`)

const stateClass = computed(() => {
  const s = props.core.runtimeState
  if (s === 'unloaded') return 'state-unloaded'
  if (s === 'working') return 'state-working'
  if (s === 'error') return 'state-error'
  if (s === 'succeeded') return 'state-succeeded'
  return 'state-idle'
})
</script>

<style scoped>
.runtime-panel {
  display: inline-flex;
  background: var(--synax-surface);
  border: 1px solid var(--synax-border);
  border-radius: 6px;
  padding: 0.5rem 1rem;
  transition: border-color 0.8s ease;
}

.runtime-row {
  display: flex;
  gap: 1.5rem;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
}

.runtime-item {
  display: flex;
  gap: 0.35rem;
  align-items: baseline;
}

.runtime-label {
  font-family: var(--synax-font);
  font-size: 0.65rem;
  color: var(--synax-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.runtime-value {
  font-family: var(--synax-font);
  font-size: 0.72rem;
  color: var(--synax-text);
  transition: color 0.6s ease;
}

.value-unloaded { color: var(--synax-text-dim); }
.value-local,
.value-qwen,
.value-deepseek,
.value-openai,
.value-claude,
.value-gemini {
  color: rgb(86, 141, 208);
}

.state-value { font-weight: 500; }
.state-unloaded { color: var(--synax-text-dim); }
.state-working { color: rgba(140, 200, 240, 0.9); }
.state-error { color: #f87171; }
.state-succeeded { color: rgba(86, 180, 140, 0.8); }
.state-idle { color: var(--synax-text-muted); }

@media (max-width: 640px) {
  .runtime-row {
    gap: 0.8rem;
  }

  .runtime-item {
    flex-direction: column;
    gap: 0.1rem;
    align-items: center;
  }
}
</style>
