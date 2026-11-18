<script setup lang="ts">
import { computed, ref } from "vue";

defineProps<{ bare?: boolean }>();

/* Pick an audience: fields outside its view collapse away and the row type follows. */
const AUDIENCES = [
  {
    name: "publicList",
    who: "Anyone with the link",
    fields: ["id", "reference", "status", "createdAt"],
  },
  {
    name: "clientList",
    who: "Your customer's portal",
    fields: ["id", "reference", "status", "totalAmount", "createdAt", "customer.name"],
  },
  {
    name: "list",
    who: "Your back office",
    fields: [
      "id",
      "reference",
      "status",
      "totalAmount",
      "createdAt",
      "customer.name",
      "customer.displayName",
    ],
  },
  {
    name: "internal",
    who: "Support and audits",
    fields: [
      "id",
      "reference",
      "status",
      "totalAmount",
      "createdAt",
      "customer.id",
      "customer.name",
      "customer.displayName",
      "customer.orgId",
    ],
  },
];
const ROOT = [
  ["id", '"ord_8f2c"'],
  ["reference", '"ORD-29812"'],
  ["status", '"shipped"'],
  ["totalAmount", "4820"],
  ["createdAt", '"2026-11-17"'],
] as const;
const CUSTOMER = [
  ["customer.id", '"cus_31"', ""],
  ["customer.name", '"Halvorsen Freight"', ""],
  ["customer.displayName", '"HALVORSEN FREIGHT"', "virtual"],
  ["customer.orgId", '"acme"', "hidden"],
] as const;

const current = ref(2);
const isString = (v: string) => v.charCodeAt(0) === 34;
const fields = computed(() => new Set(AUDIENCES[current.value]!.fields));
const anyCustomer = computed(() =>
  AUDIENCES[current.value]!.fields.some((f) => f.startsWith("customer.")),
);
</script>

<template>
  <section class="px-blk" :class="{ 'px-bare': bare }">
    <div v-if="!bare" class="px-head">
      <h2>A view <span class="px-acc">per audience</span></h2>
      <p class="px-lede">
        A view lists the exact fields a response includes, and its row type is inferred from that
        list. Fields marked private on the engine are never selected, in any view.
      </p>
    </div>
    <div class="px-views">
      <div class="px-aud" role="tablist">
        <button
          v-for="(a, i) in AUDIENCES"
          :key="a.name"
          type="button"
          role="tab"
          :aria-selected="i === current"
          :class="{ on: i === current }"
          @click="current = i"
        >
          <b>{{ a.name }}</b><span>{{ a.who }}</span><em class="px-pix">{{ a.fields.length }}</em>
        </button>
      </div>
      <div class="px-resp">
        <div class="px-win-h">
          <i />Response row<small
            >orders.$infer.views.{{ AUDIENCES[current]!.name }} ·
            {{ AUDIENCES[current]!.fields.length }} fields</small
          >
        </div>
        <span class="fl">{</span>
        <span v-for="[k, v] in ROOT" :key="k" class="fl i1" :class="{ gone: !fields.has(k) }"
          ><span class="t-k">{{ k }}</span>:
          <span :class="isString(v) ? 't-s' : 't-n'">{{ v }}</span>,</span
        >
        <span class="fl i1" :class="{ gone: !anyCustomer }"
          ><span class="t-k">customer</span>: {</span
        >
        <span
          v-for="[k, v, tag] in CUSTOMER"
          :key="k"
          class="fl i2"
          :class="{ gone: !fields.has(k) }"
          ><span class="t-k">{{ k.split(".")[1] }}</span>: <span class="t-s">{{ v }}</span>,<span
            v-if="tag"
            class="tg"
            >{{ tag }}</span
          ></span
        >
        <span class="fl i1" :class="{ gone: !anyCustomer }">},</span>
        <span class="fl">}</span>
        <div class="never">never selected, in any view: <s>deletedAt</s> (private)</div>
      </div>
    </div>
  </section>
</template>
