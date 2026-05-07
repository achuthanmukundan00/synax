<template>
  <div class="runtime-panel" :style="panelStyle">
    <div class="runtime-row">
      <div class="runtime-item">
        <span class="runtime-label">CORE</span>
        <span class="runtime-value value-core">{{ core.coreName }}</span>
      </div>
      <span class="runtime-separator">|</span>
      <div class="runtime-item">
        <span class="runtime-label">PROVIDER</span>
        <span class="runtime-value">{{ core.provider }}</span>
      </div>
      <span class="runtime-separator">|</span>
      <div class="runtime-item">
        <span class="runtime-label">STATE</span>
        <span class="runtime-value state-value">{{ core.state }}</span>
      </div>
      <span class="runtime-separator">|</span>
      <div class="runtime-item">
        <span class="runtime-label">CTX</span>
        <span class="runtime-value" :class="{ 'ctx-pressure': core.contextPressure }">{{ core.context }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { RuntimeScene } from '../runtime-core'

const props = defineProps<{ core: RuntimeScene }>()

const panelStyle = computed(() => ({
  '--state-rgb': props.core.palette.stateRgb,
  '--state-hot-rgb': props.core.palette.hotRgb,
  '--profile-rgb': props.core.profile.accentRgb,
}))
</script>

<style scoped>
.runtime-panel {
  display: inline-flex;
  background: rgb(17 17 21 / 0.92);
  border: 1px solid rgb(var(--state-rgb) / 0.34);
  border-radius: 6px;
  padding: 0.52rem 0.95rem;
  box-shadow: 0 0 24px rgb(var(--state-rgb) / 0.08);
  transition:
    border-color 0.7s ease,
    box-shadow 0.7s ease;
}

.runtime-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
}

.runtime-item {
  display: inline-flex;
  gap: 0.35rem;
  align-items: baseline;
  white-space: nowrap;
}

.runtime-label {
  font-family: var(--synax-font);
  font-size: 0.65rem;
  color: var(--synax-text-dim);
  letter-spacing: 0.05em;
}

.runtime-value {
  font-family: var(--synax-font);
  font-size: 0.72rem;
  color: var(--synax-text);
  transition: color 0.7s ease;
}

.runtime-separator {
  color: rgb(var(--state-rgb) / 0.32);
  font-family: var(--synax-font);
  font-size: 0.65rem;
}

.value-core,
.state-value {
  color: rgb(var(--state-hot-rgb));
  font-weight: 500;
}

.ctx-pressure {
  color: rgb(253 224 71);
}

@media (max-width: 640px) {
  .runtime-row {
    gap: 0.55rem;
  }

  .runtime-separator {
    display: none;
  }

  .runtime-item {
    flex-direction: column;
    gap: 0.08rem;
    align-items: center;
  }
}
</style>
