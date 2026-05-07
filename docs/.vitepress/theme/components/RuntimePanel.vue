<template>
  <div class="runtime-panel" :style="panelStyle">
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
  color: string
  headline: string
  subcopy: string
  terminal: [string, string][]
  motion: string
}

const props = defineProps<{ core: CoreDef }>()

const panelStyle = computed(() => ({
  '--panel-rgb': props.core.color,
  '--panel-color': `rgb(${props.core.color})`,
}))

const valueClass = computed(() => `value-${props.core.id}`)

const stateClass = computed(() => {
  if (props.core.state === 'blocked') return 'state-blocked'
  if (props.core.state === 'active') return 'state-active'
  if (props.core.state === 'fault') return 'state-fault'
  return 'state-ready'
})
</script>

<style scoped>
.runtime-panel {
  display: inline-flex;
  background: var(--synax-surface);
  border: 1px solid var(--synax-border);
  border-radius: 6px;
  padding: 0.5rem 1rem;
  transition: border-color 0.6s ease;
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
.value-qwen { color: var(--panel-color); }
.value-deepseek { color: var(--panel-color); }
.value-openai { color: var(--panel-color); }
.value-kimi { color: var(--panel-color); }
.value-working { color: var(--panel-color); }
.value-error { color: var(--panel-color); }

.state-value { font-weight: 500; }
.state-blocked { color: #f87171; }
.state-active { color: #a3e635; }
.state-fault { color: #f87171; }
.state-ready { color: var(--synax-text-muted); }

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
