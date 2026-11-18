<script setup lang="ts">
import {
  FIELDS,
  FIELD_GROUPS,
  KIND_ICON,
  OPERATORS,
  OP_LABEL,
  draftFor,
  emptyValue,
  isComplete,
  kindOf,
} from "../../utils/playground-ui";
import type { Condition } from "../../utils/playground-ui";

const props = defineProps<{ initial: Condition; editing: boolean }>();
const emit = defineEmits<{ apply: [Condition]; remove: []; cancel: [] }>();

const draft = ref<Condition>(JSON.parse(JSON.stringify(props.initial)));
const kind = computed(() => kindOf(draft.value.key));
const values = computed(() => FIELDS[draft.value.key]?.values ?? []);
const range = computed(() => (draft.value.value ?? {}) as { from?: unknown; to?: unknown });

/* field menu: grouped by where the field lives, the path's last part as the label */
const fieldItems = FIELD_GROUPS.map((g) => [
  { type: "label" as const, label: g.label },
  ...g.keys.map((key) => ({
    label: key,
    value: key,
    icon: KIND_ICON[kindOf(key)],
  })),
]);
const field = computed({
  get: () => draft.value.key,
  set: (key: string) => {
    if (key && key !== draft.value.key) draft.value = draftFor(key);
  },
});

const operatorItems = computed(() =>
  OPERATORS[kind.value].map((op) => ({ label: OP_LABEL[op] ?? op, value: op })),
);
const operator = computed({
  get: () => draft.value.operator,
  set: (op: string) => {
    const was = draft.value.operator;
    draft.value.operator = op;
    const shape = (o: string) => (o === "isAnyOf" ? "list" : o === "between" ? "range" : "one");
    if (shape(was) !== shape(op)) draft.value.value = emptyValue(kind.value, op);
  },
});

const list = computed({
  get: () => (draft.value.value as string[]) ?? [],
  set: (v: string[]) => (draft.value.value = v),
});
const one = computed({
  get: () => (draft.value.value ?? "") as string | number,
  set: (v: string | number) => (draft.value.value = scalar(v)),
});
function scalar(v: unknown) {
  if (kind.value !== "number") return v;
  return v === "" || v === null || v === undefined ? null : Number(v);
}
function setRange(end: "from" | "to", v: unknown) {
  const next = { ...range.value };
  const x = scalar(v);
  if (x === "" || x === null) delete next[end];
  else next[end] = x;
  draft.value.value = next;
}
const inputType = computed(() =>
  kind.value === "number" ? "number" : kind.value === "date" ? "date" : "text",
);
const money = computed(() => draft.value.key === "totalAmount");
function submit() {
  if (isComplete(draft.value)) emit("apply", draft.value);
}
</script>

<template>
  <form class="pg-fe" @submit.prevent="submit" @keydown.esc.stop="emit('cancel')">
    <div class="pg-fe-sec">
      <span class="pg-fe-l">Field</span>
      <USelectMenu
        v-model="field"
        aria-label="Field"
        :items="fieldItems"
        value-key="value"
        :icon="KIND_ICON[kind]"
        :search-input="{ placeholder: 'Find a field', icon: 'i-lucide-search' }"
        :content="{ align: 'start' }"
        color="neutral"
        variant="outline"
        class="w-full"
        :ui="{ base: 'font-mono text-[13px]', item: 'font-mono text-[13px]' }"
      />
    </div>

    <div class="pg-fe-sec">
      <span class="pg-fe-l">Operator</span>
      <UTabs
        v-model="operator"
        :items="operatorItems"
        :content="false"
        size="xs"
        color="neutral"
        class="w-full"
        :ui="{ list: 'w-full', trigger: 'flex-auto justify-center px-2 min-w-0' }"
      />
    </div>

    <div class="pg-fe-sec">
      <span class="pg-fe-l">{{ draft.operator === "isAnyOf" ? "Values" : "Value" }}</span>

      <UCheckboxGroup
        v-if="values.length && draft.operator === 'isAnyOf'"
        v-model="list"
        :items="values"
        variant="card"
        size="sm"
        :ui="{ fieldset: 'grid grid-cols-2 gap-1.5', item: 'py-1.5 px-2.5', base: 'rounded-[4px]' }"
      />
      <USelect
        v-else-if="values.length"
        v-model="one"
        :items="values"
        placeholder="Choose a value"
        color="neutral"
        class="w-full"
      />
      <div v-else-if="draft.operator === 'between'" class="pg-fe-range">
        <UInput
          :model-value="(range.from as string) ?? ''"
          :type="inputType"
          placeholder="From"
          aria-label="From"
          :icon="money ? 'i-lucide-dollar-sign' : undefined"
          color="neutral"
          @update:model-value="setRange('from', $event)"
        />
        <span>and</span>
        <UInput
          :model-value="(range.to as string) ?? ''"
          :type="inputType"
          placeholder="To"
          aria-label="To"
          :icon="money ? 'i-lucide-dollar-sign' : undefined"
          color="neutral"
          @update:model-value="setRange('to', $event)"
        />
      </div>
      <UInputTags
        v-else-if="draft.operator === 'isAnyOf'"
        v-model="list"
        placeholder="Type a value, press Enter"
        color="neutral"
        class="w-full"
      />
      <UInput
        v-else
        v-model="one"
        :type="inputType"
        :placeholder="kind === 'number' ? '20000' : 'Value'"
        aria-label="Value"
        :icon="money ? 'i-lucide-dollar-sign' : undefined"
        color="neutral"
        class="w-full"
        autofocus
      />
    </div>

    <div class="pg-fe-foot">
      <UButton
        v-if="editing"
        color="error"
        variant="ghost"
        size="sm"
        icon="i-lucide-trash-2"
        label="Remove"
        @click="emit('remove')"
      />
      <span />
      <UButton color="neutral" variant="ghost" size="sm" label="Cancel" @click="emit('cancel')" />
      <UButton
        type="submit"
        size="sm"
        :disabled="!isComplete(draft)"
        :label="editing ? 'Update' : 'Add filter'"
      />
    </div>
  </form>
</template>
