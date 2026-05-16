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
          :key="`${core.id}-${i}-${row.value}`"
          class="terminal-row"
          :class="[`tone-${row.tone ?? 'default'}`, { 'terminal-command': row.kind === 'command' }]"
          :style="{ transitionDelay: `${i * 0.08}s` }"
        >
          <template v-if="row.kind === 'command'">
            <span class="terminal-prompt">$</span>
            <span class="terminal-command-text">{{ row.value }}</span>
          </template>
          <template v-else>
            <span class="terminal-key">{{ row.key }}</span>
            <span class="terminal-sep">:</span>
            <span class="terminal-val">{{ row.value }}</span>
          </template>
        </div>
      </TransitionGroup>
      <div class="terminal-cursor">▊</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RuntimeScene } from '../runtime-core';

const props = defineProps<{ core: RuntimeScene }>();

const terminalStyle = computed(() => ({
  '--state-rgb': props.core.palette.stateRgb,
  '--state-hot-rgb': props.core.palette.hotRgb,
}));
</script>

<style scoped>
.terminal-preview {
  background: #08080b;
  border: 1px solid rgb(var(--state-rgb) / 0.25);
  border-radius: 8px;
  overflow: hidden;
  font-family: var(--synax-font);
  box-shadow: 0 0 30px rgb(var(--state-rgb) / 0.07);
  transition:
    border-color 0.7s ease,
    box-shadow 0.7s ease;
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

.dot-red {
  background: #ef4444;
}

.dot-yellow {
  background: #eab308;
}

.dot-green {
  background: #22c55e;
}

.terminal-title {
  margin-left: 0.5rem;
  font-size: 0.65rem;
  color: #52525b;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.terminal-body {
  min-height: 128px;
  padding: 0.85rem;
  position: relative;
}

.terminal-rows {
  display: flex;
  flex-direction: column;
  gap: 0.31rem;
}

.terminal-row {
  display: flex;
  gap: 0.3rem;
  min-height: 1.05rem;
  font-size: 0.72rem;
  line-height: 1.45;
}

.terminal-key {
  color: #52525b;
  min-width: 52px;
  transition: color 0.6s ease;
}

.terminal-sep {
  color: #3f3f46;
  margin-right: 0.3rem;
}

.terminal-val,
.terminal-command-text {
  color: var(--synax-text);
  overflow-wrap: anywhere;
  transition: color 0.6s ease;
}

.terminal-prompt {
  color: rgb(var(--state-rgb) / 0.86);
  min-width: 0.8rem;
}

.tone-dim .terminal-val,
.tone-dim .terminal-command-text {
  color: #52525b;
}

.tone-model .terminal-val,
.tone-model .terminal-command-text {
  color: rgb(var(--state-hot-rgb));
}

.tone-working .terminal-val,
.tone-working .terminal-command-text {
  color: rgb(var(--state-hot-rgb));
}

.tone-succeeded .terminal-val,
.tone-succeeded .terminal-command-text {
  color: rgb(134 239 172);
}

.tone-warning .terminal-val,
.tone-warning .terminal-command-text {
  color: rgb(253 224 71);
}

.tone-error .terminal-val,
.tone-error .terminal-command-text {
  color: rgb(248 113 113);
}

.tone-action .terminal-val,
.tone-action .terminal-command-text {
  color: rgb(var(--state-hot-rgb) / 0.9);
}

.terminal-cursor {
  color: rgb(var(--state-hot-rgb));
  font-size: 0.75rem;
  margin-top: 0.35rem;
  animation: cursor-blink 1s step-end infinite;
}

@keyframes cursor-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

.row-fade-enter-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.row-fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.row-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.row-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (prefers-reduced-motion: reduce) {
  .terminal-cursor {
    animation: none;
  }
}

@media (max-width: 640px) {
  .terminal-preview {
    max-width: 100%;
  }

  .terminal-row {
    font-size: 0.68rem;
  }
}
</style>
