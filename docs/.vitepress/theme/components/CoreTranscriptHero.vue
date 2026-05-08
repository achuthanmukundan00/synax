<template>
  <div class="transcript-hero" :style="heroStyle" aria-label="Synax runtime transcript preview">
    <!-- Reasoning preview — dim measured text showing model thinking -->
    <div class="transcript-reasoning" :style="reasoningStyle" aria-hidden="true">
      <div class="reasoning-label">reasoning</div>
      <div class="reasoning-text" ref="reasoningRef">
        <span
          v-for="(line, i) in measuredReasoning"
          :key="i"
          class="reasoning-line"
          :style="{ width: line.width + 'px' }"
        >{{ line.text }}</span>
      </div>
    </div>

    <!-- Tool / command rows — measured terminal lines -->
    <div class="transcript-commands" aria-label="Agent commands">
      <div
        v-for="(row, i) in measuredCommands"
        :key="`cmd-${core.id}-${i}`"
        class="transcript-row"
        :class="[`tone-${row.tone ?? 'default'}`, { 'cmd-row': row.kind === 'command' }]"
        :style="{ width: row.measuredWidth ? row.measuredWidth + 'px' : 'auto' }"
      >
        <template v-if="row.kind === 'command'">
          <span class="row-prompt">$</span>
          <span class="row-text">{{ row.value }}</span>
        </template>
        <template v-else>
          <span class="row-key">{{ row.key }}</span>
          <span class="row-sep">:</span>
          <span class="row-val">{{ row.value }}</span>
        </template>
      </div>
      <div class="transcript-cursor">▊</div>
    </div>

    <!-- Identity strip — provider/model/state with measured widths -->
    <div class="transcript-identity" :style="identityStyle" aria-label="Model identity">
      <span class="identity-chip model-chip">{{ core.profile.label }}</span>
      <span class="identity-sep">·</span>
      <span class="identity-chip provider-chip">{{ core.provider }}</span>
      <span class="identity-sep">·</span>
      <span class="identity-chip state-chip">{{ core.state }}</span>
      <span class="identity-sep">·</span>
      <span class="identity-chip ctx-chip" :class="{ 'ctx-pressure': core.contextPressure }">{{ core.context }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { RuntimeScene, TerminalLine } from '../runtime-core'
import {
  prepareMeasuredTextWithSegments,
  layoutMeasuredLines,
  type LayoutLine,
} from '../measured-text'

const props = defineProps<{
  core: RuntimeScene
}>()

// ---------------------------------------------------------------------------
// Font setup — must match CSS declarations
// ---------------------------------------------------------------------------

const TERMINAL_FONT = '12px "JetBrains Mono", "Fira Code", ui-monospace, monospace'
const REASONING_MAX_WIDTH = 420
const COMMAND_MAX_WIDTH = 480
const REASONING_LINE_HEIGHT = 18
const COMMAND_LINE_HEIGHT = 19

// ---------------------------------------------------------------------------
// Measured reasoning lines
// ---------------------------------------------------------------------------

interface MeasuredLine {
  text: string
  width: number
}

const measuredReasoning = ref<MeasuredLine[]>([])

function computeReasoning(): void {
  // Build a dim "reasoning preview" from the scene's subheadline
  const text = `> ${props.core.subheadline}  ${props.core.headline}`
  const prepared = prepareMeasuredTextWithSegments(text, TERMINAL_FONT, {
    whiteSpace: 'pre-wrap',
  })
  if (!prepared) {
    measuredReasoning.value = []
    return
  }
  const result = layoutMeasuredLines(prepared, REASONING_MAX_WIDTH, REASONING_LINE_HEIGHT)
  measuredReasoning.value = result.lines.map((l: LayoutLine) => ({
    text: l.text,
    width: Math.ceil(l.width),
  }))
}

// ---------------------------------------------------------------------------
// Measured command rows
// ---------------------------------------------------------------------------

interface MeasuredCommand extends TerminalLine {
  measuredWidth: number
}

const measuredCommands = ref<MeasuredCommand[]>([])

function computeCommands(): void {
  const result: MeasuredCommand[] = []
  for (const row of props.core.terminal) {
    const text = row.kind === 'command' ? `$ ${row.value}` : `${row.key ?? ''}: ${row.value}`
    const prepared = prepareMeasuredTextWithSegments(text, TERMINAL_FONT, {
      whiteSpace: 'pre-wrap',
    })
    if (!prepared) {
      result.push({ ...row, measuredWidth: 0 })
      continue
    }
    const layoutResult = layoutMeasuredLines(prepared, COMMAND_MAX_WIDTH, COMMAND_LINE_HEIGHT)
    // Use the widest line as the row's measured width
    let maxW = 0
    for (const l of layoutResult.lines) {
      if (l.width > maxW) maxW = l.width
    }
    result.push({ ...row, measuredWidth: Math.ceil(maxW) + 4 })
  }
  measuredCommands.value = result
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const reasoningStyle = computed(() => ({
  '--state-dim-rgb': dimRgb(props.core.palette.stateRgb),
}))

const heroStyle = computed(() => ({
  '--state-rgb': props.core.palette.stateRgb,
  '--state-hot-rgb': props.core.palette.hotRgb,
}))
const identityStyle = computed(() => ({
  '--state-rgb': props.core.palette.stateRgb,
  '--state-hot-rgb': props.core.palette.hotRgb,
}))

function dimRgb(rgb: string): string {
  return rgb
    .split(' ')
    .map((c) => Math.max(0, Math.round(Number(c) * 0.45)))
    .join(' ')
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

const reasoningRef = ref<HTMLElement | null>(null)

watch(
  () => props.core,
  () => {
    computeReasoning()
    computeCommands()
  },
  { immediate: true },
)

onMounted(() => {
  computeReasoning()
  computeCommands()
})
</script>

<style scoped>
.transcript-hero {
  max-width: 520px;
  width: 100%;
  margin: 0 auto;
  font-family: var(--synax-font);
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

/* ---- Reasoning preview ---- */

.transcript-reasoning {
  background: rgb(8 8 11 / 0.7);
  border: 1px solid rgb(var(--state-rgb) / 0.12);
  border-left: 2px solid rgb(var(--state-dim-rgb) / 0.4);
  border-radius: 4px;
  padding: 0.55rem 0.75rem;
  transition:
    border-color 0.7s ease,
    background 0.7s ease;
}

.reasoning-label {
  font-size: 0.56rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgb(var(--state-rgb) / 0.32);
  margin-bottom: 0.25rem;
}

.reasoning-text {
  display: flex;
  flex-direction: column;
  gap: 0.08rem;
}

.reasoning-line {
  font-size: 0.64rem;
  line-height: 1.45;
  color: rgb(var(--state-rgb) / 0.28);
  white-space: pre-wrap;
  overflow-wrap: break-word;
  transition: color 0.7s ease;
}

/* ---- Command rows ---- */

.transcript-commands {
  background: #08080b;
  border: 1px solid rgb(var(--state-rgb) / 0.22);
  border-radius: 8px;
  padding: 0.7rem 0.85rem;
  transition:
    border-color 0.7s ease,
    box-shadow 0.7s ease;
  box-shadow: 0 0 24px rgb(var(--state-rgb) / 0.06);
  min-height: 100px;
}

.transcript-row {
  display: flex;
  gap: 0.3rem;
  font-size: 0.7rem;
  line-height: 1.45;
  min-height: 1.1rem;
  align-items: baseline;
}

.row-prompt {
  color: rgb(var(--state-rgb) / 0.78);
  min-width: 0.7rem;
  flex-shrink: 0;
}

.row-text {
  color: var(--synax-text);
  white-space: pre-wrap;
  overflow-wrap: break-word;
  transition: color 0.6s ease;
}

.row-key {
  color: #52525b;
  min-width: 48px;
  flex-shrink: 0;
  transition: color 0.6s ease;
}

.row-sep {
  color: #3f3f46;
  flex-shrink: 0;
}

.row-val {
  color: var(--synax-text);
  white-space: pre-wrap;
  overflow-wrap: break-word;
  transition: color 0.6s ease;
}

/* Tones */
.tone-dim .row-text,
.tone-dim .row-val {
  color: #52525b;
}

.tone-model .row-text,
.tone-model .row-val {
  color: rgb(var(--state-hot-rgb));
}

.tone-working .row-text,
.tone-working .row-val {
  color: rgb(var(--state-hot-rgb));
}

.tone-succeeded .row-text,
.tone-succeeded .row-val {
  color: rgb(134 239 172);
}

.tone-warning .row-text,
.tone-warning .row-val {
  color: rgb(253 224 71);
}

.tone-error .row-text,
.tone-error .row-val {
  color: rgb(248 113 113);
}

.tone-action .row-text,
.tone-action .row-val {
  color: rgb(var(--state-hot-rgb) / 0.9);
}

.transcript-cursor {
  color: rgb(var(--state-hot-rgb));
  font-size: 0.72rem;
  margin-top: 0.3rem;
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

/* ---- Identity strip ---- */

.transcript-identity {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  font-size: 0.65rem;
  flex-wrap: wrap;
}

.identity-chip {
  padding: 0.18rem 0.48rem;
  border-radius: 3px;
  font-family: var(--synax-font);
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.model-chip {
  background: rgb(var(--state-rgb) / 0.12);
  color: rgb(var(--state-hot-rgb));
  border: 1px solid rgb(var(--state-rgb) / 0.18);
}

.provider-chip {
  background: transparent;
  color: var(--synax-text-muted);
  border: 1px solid rgb(var(--state-rgb) / 0.1);
}

.state-chip {
  background: rgb(var(--state-rgb) / 0.1);
  color: rgb(var(--state-hot-rgb) / 0.85);
  border: 1px solid rgb(var(--state-rgb) / 0.15);
}

.ctx-chip {
  background: transparent;
  color: var(--synax-text-muted);
  border: 1px solid rgb(var(--state-rgb) / 0.08);
}

.ctx-pressure {
  color: rgb(253 224 71);
  border-color: rgb(234 179 8 / 0.35);
  background: rgb(234 179 8 / 0.06);
}

.identity-sep {
  color: rgb(var(--state-rgb) / 0.2);
}

/* ---- Reduced motion ---- */

@media (prefers-reduced-motion: reduce) {
  .transcript-cursor {
    animation: none;
  }
}

/* ---- Mobile ---- */

@media (max-width: 640px) {
  .transcript-hero {
    max-width: 100%;
  }

  .transcript-row {
    font-size: 0.66rem;
  }

  .transcript-commands {
    padding: 0.55rem 0.65rem;
  }
}
</style>
