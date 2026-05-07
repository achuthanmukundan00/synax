<template>
  <div class="terminal-preview" :style="terminalStyle">
    <div class="terminal-header">
      <span class="terminal-dot dot-red"></span>
      <span class="terminal-dot dot-yellow"></span>
      <span class="terminal-dot dot-green"></span>
      <span class="terminal-title">synax runtime</span>
    </div>
    <div class="terminal-body">
      <TransitionGroup name="row-fade" tag="div" class="terminal-rows">
        <div
          v-for="(row, i) in core.terminal"
          :key="`${core.id}-${i}`"
          class="terminal-row"
          :style="{ transitionDelay: `${i * 0.08}s` }"
        >
          <span class="terminal-key">{{ row[0] }}</span>
          <span class="terminal-sep">:</span>
          <span class="terminal-val" :class="valClass(row[0], row[1])">{{ row[1] }}</span>
        </div>
      </TransitionGroup>
      <div class="terminal-cursor">▊</div>
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

const terminalStyle = computed(() => ({
  '--term-rgb': props.core.color,
}))

function valClass(key: string, _val: string): string {
  if (key === 'state' && _val === 'blocked') return 'val-blocked'
  if (key === 'state' && _val === 'fault') return 'val-fault'
  if (key === 'state' && _val === 'active') return 'val-active'
  if (key === 'core') return 'val-core'
  if (key === 'reason') return 'val-reason'
  if (key === 'next') return 'val-next'
  return ''
}
</script>

<style scoped>
.terminal-preview {
  background: #08080b;
  border: 1px solid #1a1a20;
  border-radius: 8px;
  overflow: hidden;
  font-family: var(--synax-font);
  transition: border-color 0.6s ease;
}

.terminal-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.8rem;
  background: #0d0d12;
  border-bottom: 1px solid #1a1a20;
}

.terminal-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot-red { background: #ef4444; }
.dot-yellow { background: #eab308; }
.dot-green { background: #22c55e; }

.terminal-title {
  margin-left: 0.5rem;
  font-size: 0.65rem;
  color: #52525b;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.terminal-body {
  padding: 0.8rem;
  position: relative;
  min-height: 100px;
}

.terminal-rows {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.terminal-row {
  display: flex;
  gap: 0.3rem;
  font-size: 0.72rem;
}

.terminal-key {
  color: #52525b;
  min-width: 50px;
  transition: color 0.6s ease;
}

.terminal-sep {
  color: #3f3f46;
  margin-right: 0.3rem;
}

.terminal-val {
  color: var(--synax-text);
  transition: color 0.6s ease;
}

.val-core { color: rgb(var(--term-rgb)); }
.val-blocked { color: #f87171; }
.val-fault { color: #f87171; }
.val-active { color: #a3e635; }
.val-reason { color: #fbbf24; }
.val-next { color: #34d399; }

.terminal-cursor {
  color: rgb(var(--term-rgb));
  font-size: 0.75rem;
  margin-top: 0.3rem;
  animation: cursor-blink 1s step-end infinite;
}

@keyframes cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* Transition for row changes */
.row-fade-enter-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.row-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.row-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.row-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (max-width: 640px) {
  .terminal-preview {
    max-width: 100%;
  }
}
</style>
