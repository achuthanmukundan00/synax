<template>
  <div class="terminal-preview">
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

function valClass(key: string, val: string): string {
  if (key === 'state' && val === 'unloaded') return 'val-dim'
  if (key === 'state' && val === 'error') return 'val-error'
  if (key === 'state' && val === 'working') return 'val-working'
  if (key === 'state' && val === 'succeeded') return 'val-succeeded'
  if (key === 'core') return 'val-core'
  if (key === 'error') return 'val-error'
  if (key === 'action') return 'val-action'
  if (key === 'result') return 'val-succeeded'
  if (key === 'phase') return 'val-working'
  if (key === 'tool') return 'val-working'
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

.val-core { color: rgb(86, 141, 208); }
.val-dim { color: #52525b; }
.val-error { color: #f87171; }
.val-working { color: rgba(140, 200, 240, 0.9); }
.val-succeeded { color: rgba(86, 180, 140, 0.8); }
.val-action { color: rgba(140, 200, 240, 0.8); }

.terminal-cursor {
  color: rgb(86, 141, 208);
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
