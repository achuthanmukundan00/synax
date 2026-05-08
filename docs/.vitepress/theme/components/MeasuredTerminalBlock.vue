<template>
  <div
    class="measured-terminal"
    :style="terminalStyle"
    :aria-label="ariaLabel || 'Terminal code block'"
  >
    <!-- Hidden accessible text for screen readers -->
    <span class="sr-only">{{ accessibleText }}</span>

    <!-- Header bar -->
    <div class="mt-header" aria-hidden="true">
      <span class="mt-dot dot-close"></span>
      <span class="mt-dot dot-min"></span>
      <span class="mt-dot dot-max"></span>
      <span class="mt-title">{{ title || 'terminal' }}</span>
    </div>

    <!-- Content lines laid out with measured widths -->
    <div class="mt-body" ref="bodyRef">
      <div v-for="(line, i) in measuredLines" :key="i" class="mt-line">
        <span v-if="showPrompt && !line.isEmpty" class="mt-prompt" aria-hidden="true">{{ prompt }}</span>
        <span
          class="mt-text"
          :class="{ 'mt-dim': line.dim }"
          :style="line.width > 0 ? { width: line.measuredWidth + 'px' } : {}"
        >{{ line.text }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import {
  prepareMeasuredTextWithSegments,
  layoutMeasuredLines,
  type LayoutLine,
} from '../measured-text'

const props = withDefaults(
  defineProps<{
    lines?: string[]
    content?: string
    title?: string
    prompt?: string
    showPrompt?: boolean
    ariaLabel?: string
    font?: string
    maxWidth?: number
    lineHeight?: number
    stateRgb?: string
    dimLines?: number[]
  }>(),
  {
    lines: () => [],
    content: '',
    title: 'terminal',
    prompt: '$',
    showPrompt: true,
    ariaLabel: '',
    font: '13px "JetBrains Mono", "Fira Code", ui-monospace, monospace',
    maxWidth: 620,
    lineHeight: 20,
    stateRgb: '86 141 208',
    dimLines: () => [],
  },
)

interface MeasuredLine {
  text: string
  width: number
  measuredWidth: number
  isEmpty: boolean
  dim: boolean
}

const measuredLines = ref<MeasuredLine[]>([])
const bodyRef = ref<HTMLElement | null>(null)

// Build the text lines from props
const sourceLines = computed(() => {
  if (props.lines.length > 0) return props.lines
  if (props.content) return props.content.split('\n')
  return []
})

const accessibleText = computed(() => sourceLines.value.join('\n'))

function computeLines(): void {
  const result: MeasuredLine[] = []
  const dimSet = new Set(props.dimLines ?? [])

  for (let i = 0; i < sourceLines.value.length; i++) {
    const text = sourceLines.value[i]
    if (text === '' || text === undefined) {
      result.push({ text: '', width: 0, measuredWidth: 0, isEmpty: true, dim: dimSet.has(i) })
      continue
    }
    const prepared = prepareMeasuredTextWithSegments(text, props.font, {
      whiteSpace: 'pre-wrap',
    })
    if (!prepared) {
      result.push({
        text,
        width: 0,
        measuredWidth: 0,
        isEmpty: false,
        dim: dimSet.has(i),
      })
      continue
    }
    const layoutResult = layoutMeasuredLines(prepared, props.maxWidth, props.lineHeight)
    // For single-line input, find the measured width
    let maxW = 0
    for (const l of layoutResult.lines) {
      if (l.width > maxW) maxW = l.width
    }
    result.push({
      text,
      width: maxW,
      measuredWidth: Math.ceil(maxW) + 4,
      isEmpty: false,
      dim: dimSet.has(i),
    })
  }
  measuredLines.value = result
}

const terminalStyle = computed(() => ({
  '--mt-rgb': props.stateRgb,
}))

watch(
  () => [props.lines, props.content, props.font, props.maxWidth],
  () => computeLines(),
  { immediate: true },
)

onMounted(() => computeLines())
</script>

<style scoped>
/* Screen reader only */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.measured-terminal {
  background: #08080b;
  border: 1px solid rgb(var(--mt-rgb) / 0.18);
  border-radius: 8px;
  overflow: hidden;
  font-family: var(--synax-font);
  margin: 1.25rem 0;
  box-shadow: 0 0 20px rgb(var(--mt-rgb) / 0.05);
  width: auto;
  max-width: 100%;
}

.mt-header {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.45rem 0.75rem;
  background: #0d0d12;
  border-bottom: 1px solid #1a1a20;
}

.mt-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-close {
  background: #ef4444;
}

.dot-min {
  background: #eab308;
}

.dot-max {
  background: #22c55e;
}

.mt-title {
  margin-left: 0.4rem;
  font-size: 0.6rem;
  color: #52525b;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.mt-body {
  padding: 0.75rem 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.18rem;
}

.mt-line {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  min-height: 1.15rem;
}

.mt-prompt {
  color: rgb(var(--mt-rgb) / 0.7);
  font-size: 0.78rem;
  flex-shrink: 0;
  user-select: none;
}

.mt-text {
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--synax-text);
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

.mt-dim {
  opacity: 0.45;
  color: #71717a;
}

/* Trim trailing whitespace visual */
.mt-text:empty::after {
  content: '\200b';
}

@media (max-width: 640px) {
  .measured-terminal {
    max-width: 100%;
    border-radius: 6px;
  }

  .mt-text {
    font-size: 0.72rem;
  }

  .mt-body {
    padding: 0.6rem 0.65rem;
  }
}
</style>
