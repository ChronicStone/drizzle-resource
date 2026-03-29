<script setup lang="ts">
import { shallowRef, watch } from "vue";
import { Codemirror } from "vue-codemirror";
import { json } from "@codemirror/lang-json";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";

const props = defineProps<{
  modelValue: string;
  invalid?: boolean;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const editorView = shallowRef<EditorView | null>(null);
const isApplyingFormat = shallowRef(false);
let formatTimer: ReturnType<typeof setTimeout> | undefined;

const lightTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "transparent",
    color: "var(--ui-text-highlighted)",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: "1.7",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "16px",
    caretColor: "var(--ui-primary)",
  },
  ".cm-gutters": {
    minHeight: "100%",
    border: "none",
    backgroundColor: "color-mix(in oklab, var(--ui-bg-muted) 75%, transparent)",
    color: "var(--ui-text-dimmed)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklab, var(--ui-bg-elevated) 85%, transparent)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--ui-primary) 6%, transparent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, var(--ui-primary) 18%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--ui-primary)",
  },
  ".cm-focused": {
    outline: "none",
  },
});

const invalidTheme = EditorView.theme({
  ".cm-content": {
    backgroundColor: "color-mix(in oklab, var(--ui-error) 5%, transparent)",
  },
});

const extensions = computed<Extension[]>(() => [
  json(),
  EditorState.tabSize.of(2),
  EditorView.lineWrapping,
  drawSelection(),
  highlightActiveLine(),
  lightTheme,
  oneDark,
  ...(props.invalid ? [invalidTheme] : []),
]);

function applyFormattedDocument(nextValue: string) {
  const view = editorView.value;
  if (!view || view.state.doc.toString() === nextValue) return;

  isApplyingFormat.value = true;
  const currentSelection = view.state.selection.main;
  const selectionAnchor = Math.min(currentSelection.anchor, nextValue.length);
  const selectionHead = Math.min(currentSelection.head, nextValue.length);

  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: nextValue,
    },
    selection: {
      anchor: selectionAnchor,
      head: selectionHead,
    },
  });

  emit("update:modelValue", nextValue);
  queueMicrotask(() => {
    isApplyingFormat.value = false;
  });
}

function scheduleAutoFormat(value: string) {
  clearTimeout(formatTimer);

  formatTimer = setTimeout(() => {
    try {
      const formatted = `${JSON.stringify(JSON.parse(value), null, 2)}\n`;
      if (formatted !== value) {
        applyFormattedDocument(formatted);
      }
    } catch {
      // Keep partial JSON as-is while the user is editing.
    }
  }, 450);
}

function handleChange(value: string) {
  if (isApplyingFormat.value) return;
  emit("update:modelValue", value);
  scheduleAutoFormat(value);
}

function handleReady(payload: { view: EditorView }) {
  editorView.value = payload.view;
}

watch(
  () => props.modelValue,
  (value) => {
    const view = editorView.value;
    if (!view || isApplyingFormat.value) return;

    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      applyFormattedDocument(value);
    }
  },
);

onBeforeUnmount(() => {
  clearTimeout(formatTimer);
});
</script>

<template>
  <div class="playground-json-editor h-full min-h-0 w-full">
    <ClientOnly>
      <Codemirror
        :model-value="modelValue"
        :extensions="extensions"
        :placeholder="placeholder"
        :indent-with-tab="false"
        :tab-size="2"
        class="h-full"
        @update:model-value="handleChange"
        @ready="handleReady"
      />

      <template #fallback>
        <textarea
          :value="modelValue"
          :placeholder="placeholder"
          spellcheck="false"
          class="h-full min-h-0 w-full resize-none border-0 bg-transparent p-4 font-mono text-sm text-highlighted outline-none"
          @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        />
      </template>
    </ClientOnly>
  </div>
</template>

<style scoped>
.playground-json-editor :deep(.cm-editor) {
  height: 100%;
  border: 0;
  background: transparent;
}

.playground-json-editor :deep(.cm-theme) {
  height: 100%;
}

.playground-json-editor :deep(.cm-focused) {
  outline: none;
}

.playground-json-editor :deep(.cm-gutters) {
  border-right: 1px solid var(--ui-border);
}
</style>
