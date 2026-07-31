<script setup lang="ts">
/**
 * Animated staged-pipeline schematic for the landing page.
 *
 * All motion is pure CSS keyed to a single master clock (--pl-cycle) so the
 * component renders identically on the server. Base (non-animated) styles are
 * the *completed* diagram, which is what `prefers-reduced-motion` users see.
 * An IntersectionObserver only toggles `animation-play-state` off-screen.
 */
const stages = [
  {
    hit: 0.1,
    name: "Scope merge",
    desc: "Tenant filters merge in before any client filter can run.",
  },
  {
    hit: 0.22,
    name: "Field validation",
    desc: "Sort keys and filter paths are checked against your schema.",
  },
  {
    hit: 0.34,
    name: "ID select",
    desc: "One paginated primary-key query with every filter applied.",
  },
  {
    hit: 0.46,
    name: "Row hydration",
    desc: "Rows load by id with declared relations, order preserved.",
  },
  {
    hit: 0.58,
    name: "Facets",
    desc: "Bucket counts resolve only when the request asks for them.",
  },
];

const facetRows = [
  { label: "pending", width: "100%", count: 12, dh: 0 },
  { label: "paid", width: "64%", count: 8, dh: 0.014 },
  { label: "shipped", width: "40%", count: 5, dh: 0.028 },
];

const root = ref<HTMLElement | null>(null);
const paused = ref(false);

onMounted(() => {
  if (typeof IntersectionObserver === "undefined" || !root.value) return;
  const io = new IntersectionObserver(
    (entries) => {
      paused.value = !entries.some((entry) => entry.isIntersecting);
    },
    { rootMargin: "160px" },
  );
  io.observe(root.value);
  onBeforeUnmount(() => io.disconnect());
});
</script>

<template>
  <section ref="root" class="pl" :class="{ 'pl-paused': paused }">
    <i class="pl-bg" aria-hidden="true"></i>
    <i class="pl-aura" aria-hidden="true"></i>
    <i class="pl-corner pl-corner--tl" aria-hidden="true"></i>
    <i class="pl-corner pl-corner--tr" aria-hidden="true"></i>
    <i class="pl-corner pl-corner--bl" aria-hidden="true"></i>
    <i class="pl-corner pl-corner--br" aria-hidden="true"></i>

    <header class="pl-head">
      <div>
        <p class="pl-eyebrow">Staged pipeline</p>
        <h3 class="pl-title">Not a monolithic query</h3>
        <p class="pl-sub">
          Every request runs five ordered stages — watch one flow through. Any stage can be replaced
          independently.
        </p>
      </div>
      <div class="pl-legend" aria-hidden="true">
        <span><i class="pl-legend-dot pl-legend-dot--req"></i>request</span>
        <span><i class="pl-legend-dot pl-legend-dot--rogue"></i>out-of-scope</span>
      </div>
    </header>

    <div class="pl-progress" aria-hidden="true"><i></i></div>

    <div class="pl-viz">
      <div class="pl-bus" aria-hidden="true">
        <i class="pl-rail"></i>
        <i class="pl-packet"></i>
        <i class="pl-rogue"></i>
        <i class="pl-spark pl-spark--a"></i>
        <i class="pl-spark pl-spark--b"></i>
      </div>

      <div class="pl-endpoint pl-endpoint--in" style="--hit: 0.015" aria-hidden="true">
        <span class="pl-endpoint-pill">Request</span>
        <span class="pl-endpoint-sub">typed payload</span>
      </div>
      <div class="pl-endpoint pl-endpoint--out" style="--hit: 0.64" aria-hidden="true">
        <span class="pl-endpoint-pill">Response</span>
        <span class="pl-endpoint-sub">rows · count · facets</span>
      </div>

      <ol class="pl-stages">
        <li
          v-for="(stage, i) in stages"
          :key="stage.name"
          class="pl-stage"
          :style="{ '--hit': stage.hit }"
        >
          <i class="pl-stub" aria-hidden="true"></i>
          <i class="pl-port" aria-hidden="true"></i>
          <div class="pl-card">
            <div class="pl-card-top">
              <span class="pl-num">0{{ i + 1 }}</span>
              <span class="pl-name">{{ stage.name }}</span>
            </div>

            <div v-if="i === 0" class="pl-micro pl-micro--row" aria-hidden="true">
              <span class="pl-chip pl-anim" style="--dh: 0.006">
                <UIcon name="i-lucide-shield-check" class="pl-chip-icon" />
                <code>orgId = "acme"</code>
              </span>
            </div>

            <div v-else-if="i === 1" class="pl-micro pl-micro--row" aria-hidden="true">
              <span class="pl-field pl-anim" style="--dh: 0.004">status</span>
              <span class="pl-field pl-anim" style="--dh: 0.016">createdAt</span>
              <span class="pl-field pl-anim" style="--dh: 0.028">customer.name</span>
            </div>

            <div v-else-if="i === 2" class="pl-micro pl-micro--row" aria-hidden="true">
              <span
                v-for="n in 6"
                :key="n"
                class="pl-id pl-anim-id"
                :style="{ '--dh': 0.004 + (n - 1) * 0.006 }"
              ></span>
              <span class="pl-tag pl-anim" style="--dh: 0.044"><code>LIMIT 25</code></span>
            </div>

            <div v-else-if="i === 3" class="pl-micro pl-micro--col" aria-hidden="true">
              <span
                v-for="n in 3"
                :key="n"
                class="pl-row pl-anim-slide"
                :style="{ '--dh': 0.004 + (n - 1) * 0.012 }"
              >
                <i class="pl-row-key"></i>
                <i class="pl-row-bar"></i>
                <i class="pl-row-end"></i>
              </span>
            </div>

            <div v-else class="pl-micro pl-micro--col" aria-hidden="true">
              <span v-for="facet in facetRows" :key="facet.label" class="pl-facet">
                <em>{{ facet.label }}</em>
                <i class="pl-facet-track">
                  <b
                    class="pl-facet-bar pl-anim-grow"
                    :style="{ '--dh': 0.006 + facet.dh, width: facet.width }"
                  ></b>
                </i>
                <b class="pl-facet-count pl-anim" :style="{ '--dh': 0.016 + facet.dh }">
                  {{ facet.count }}
                </b>
              </span>
            </div>

            <p class="pl-desc">{{ stage.desc }}</p>
          </div>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
/* ---------------------------------------------------------------- tokens */
.pl {
  --pl-cycle: 14s;
  --pl-amber: var(--ui-primary);
  --pl-glow: color-mix(in oklab, var(--ui-primary) 45%, transparent);
  --pl-glow-soft: color-mix(in oklab, var(--ui-primary) 18%, transparent);
  --pl-line: color-mix(in oklab, var(--ui-border) 90%, transparent);
  --pl-grid: color-mix(in oklab, var(--ui-border) 45%, transparent);
  --pl-rogue-c: color-mix(in oklab, #e11d48 82%, var(--ui-primary) 18%);
  --pl-card-bg: color-mix(in oklab, var(--ui-bg) 97%, white 3%);
  --pl-card-border: color-mix(in oklab, var(--ui-border) 88%, transparent);

  position: relative;
  overflow: hidden;
  border-radius: 1.75rem;
  border: 1px solid color-mix(in oklab, var(--ui-border) 92%, transparent);
  background: color-mix(in oklab, var(--ui-bg) 94%, white 6%);
  box-shadow: 0 24px 60px -50px rgba(0, 0, 0, 0.28);
  padding: clamp(1.4rem, 3vw, 2.4rem);
}

.dark .pl {
  --pl-glow: color-mix(in oklab, var(--ui-primary) 62%, transparent);
  --pl-glow-soft: color-mix(in oklab, var(--ui-primary) 26%, transparent);
  --pl-card-bg: color-mix(in oklab, var(--ui-bg) 90%, white 10%);
  --pl-card-border: color-mix(in oklab, var(--ui-border) 95%, white 5%);
  background: color-mix(in oklab, var(--ui-bg) 97%, white 3%);
}

/* ------------------------------------------------------------ backdrop */
.pl-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(to right, var(--pl-grid) 1px, transparent 1px),
    linear-gradient(to bottom, var(--pl-grid) 1px, transparent 1px);
  background-size: 42px 42px;
  opacity: 0.5;
  -webkit-mask-image: radial-gradient(130% 100% at 50% 0%, black 25%, transparent 78%);
  mask-image: radial-gradient(130% 100% at 50% 0%, black 25%, transparent 78%);
}

.pl-aura {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(
    620px 240px at 72% -4%,
    color-mix(in oklab, var(--ui-primary) 9%, transparent),
    transparent 70%
  );
}

.pl-corner {
  position: absolute;
  width: 11px;
  height: 11px;
  opacity: 0.55;
  border-color: color-mix(in oklab, var(--ui-primary) 55%, var(--ui-border) 45%);
  border-style: solid;
  border-width: 0;
  pointer-events: none;
}

.pl-corner--tl {
  top: 12px;
  left: 12px;
  border-top-width: 1.5px;
  border-left-width: 1.5px;
}

.pl-corner--tr {
  top: 12px;
  right: 12px;
  border-top-width: 1.5px;
  border-right-width: 1.5px;
}

.pl-corner--bl {
  bottom: 12px;
  left: 12px;
  border-bottom-width: 1.5px;
  border-left-width: 1.5px;
}

.pl-corner--br {
  bottom: 12px;
  right: 12px;
  border-bottom-width: 1.5px;
  border-right-width: 1.5px;
}

/* -------------------------------------------------------------- header */
.pl-head {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 0.75rem 1.5rem;
}

.pl-eyebrow {
  margin: 0 0 0.35rem;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ui-primary);
}

.pl-title {
  margin: 0;
  font-size: clamp(1.35rem, 2.4vw, 1.7rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ui-text-highlighted);
}

.pl-sub {
  margin: 0.45rem 0 0;
  max-width: 34rem;
  font-size: 0.9rem;
  line-height: 1.6;
  color: var(--ui-text-toned);
}

.pl-legend {
  display: flex;
  gap: 1rem;
  font-size: 0.7rem;
  color: var(--ui-text-toned);
}

.pl-legend span {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.pl-legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
}

.pl-legend-dot--req {
  background: var(--ui-primary);
  box-shadow: 0 0 8px var(--pl-glow);
}

.pl-legend-dot--rogue {
  background: var(--pl-rogue-c);
  opacity: 0.85;
}

/* ------------------------------------------------------ cycle progress */
.pl-progress {
  position: relative;
  margin-top: 1.1rem;
  height: 2px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--ui-border) 60%, transparent);
  overflow: hidden;
}

.pl-progress > i {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--pl-glow-soft), var(--pl-amber));
  transform-origin: left center;
  transform: scaleX(1);
  opacity: 0.25;
  animation: pl-progress var(--pl-cycle) linear infinite;
}

/* ----------------------------------------------------------- viz frame */
.pl-viz {
  position: relative;
  margin-top: 0.4rem;
  padding: 96px 0 6px;
}

/* bus ------------------------------------------------------------------ */
.pl-bus {
  position: absolute;
  top: 64px;
  left: 0;
  right: 0;
  height: 2px;
  z-index: 1;
}

.pl-rail {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent,
    var(--pl-line) 7%,
    var(--pl-line) 93%,
    transparent
  );
}

.pl-rail::after {
  content: "";
  position: absolute;
  inset: -1px 6%;
  background: linear-gradient(90deg, transparent, var(--pl-glow-soft), transparent);
  filter: blur(1px);
}

/* the hero packet -------------------------------------------------------- */
.pl-packet {
  position: absolute;
  top: 50%;
  left: 0;
  width: 100%;
  height: 0;
  opacity: 0;
  transform: translateX(-100%);
  will-change: transform;
  animation: pl-run-x var(--pl-cycle) linear infinite;
}

.pl-packet::after {
  content: "";
  position: absolute;
  right: -6px;
  top: -6px;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: radial-gradient(circle at 35% 35%, rgba(255, 255, 255, 0.9), var(--pl-amber) 65%);
  box-shadow:
    0 0 10px 2px var(--pl-glow),
    0 0 26px 6px var(--pl-glow-soft);
}

.pl-packet::before {
  content: "";
  position: absolute;
  right: 4px;
  top: -1px;
  width: 74px;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--pl-glow));
  border-radius: 999px;
}

/* the out-of-scope packet, deflected at stage 01 ------------------------- */
.pl-rogue {
  position: absolute;
  top: 50%;
  left: 0;
  width: 100%;
  height: 0;
  opacity: 0;
  transform: translate(-100%, 0);
  will-change: transform;
  animation: pl-rogue-x var(--pl-cycle) linear infinite;
}

.pl-rogue::after {
  content: "";
  position: absolute;
  right: -4px;
  top: -4px;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--pl-rogue-c);
  box-shadow: 0 0 10px 1px color-mix(in oklab, var(--pl-rogue-c) 55%, transparent);
}

/* ambient sparks --------------------------------------------------------- */
.pl-spark {
  position: absolute;
  top: 50%;
  left: 0;
  width: 100%;
  height: 0;
  opacity: 0;
  transform: translateX(-100%);
  animation: pl-spark-x 6.4s linear infinite;
}

.pl-spark::after {
  content: "";
  position: absolute;
  right: -2px;
  top: -2px;
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--ui-primary) 70%, transparent);
}

.pl-spark--b {
  animation-duration: 9.1s;
  animation-delay: -3.4s;
}

/* endpoints -------------------------------------------------------------- */
.pl-endpoint {
  position: absolute;
  top: 64px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  transform: translateY(-50%);
}

.pl-endpoint--in {
  left: 0;
  align-items: flex-start;
}

.pl-endpoint--out {
  right: 0;
  align-items: flex-end;
}

.pl-endpoint-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid color-mix(in oklab, var(--ui-primary) 30%, var(--ui-border) 70%);
  background: color-mix(in oklab, var(--ui-primary) 8%, var(--pl-card-bg) 92%);
  padding: 0.28rem 0.7rem;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: color-mix(in oklab, var(--ui-primary) 75%, var(--ui-text) 25%);
}

.pl-endpoint-pill::after {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  box-shadow:
    0 0 0 1px var(--pl-glow),
    0 0 18px 2px var(--pl-glow-soft);
  opacity: 0;
  animation: pl-glow var(--pl-cycle) linear infinite;
  animation-delay: calc((var(--hit, 0) - 1) * var(--pl-cycle));
}

.pl-endpoint--out .pl-endpoint-pill::after {
  animation-name: pl-glow-long;
}

.pl-endpoint-sub {
  font-size: 0.62rem;
  color: var(--ui-text-toned);
  white-space: nowrap;
}

/* stages ----------------------------------------------------------------- */
.pl-stages {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pl-stage {
  position: relative;
  padding: 0 0.45rem;
  min-width: 0;
}

.pl-stub {
  position: absolute;
  left: calc(50% - 1px);
  top: -32px;
  width: 2px;
  height: 32px;
  background: var(--pl-line);
}

.pl-stub::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, var(--pl-amber), var(--pl-glow-soft));
  opacity: 0;
  animation: pl-glow var(--pl-cycle) linear infinite;
  animation-delay: calc((var(--hit, 0) - 1) * var(--pl-cycle));
}

.pl-port {
  position: absolute;
  left: calc(50% - 3.5px);
  top: -35.5px;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  border: 1.5px solid color-mix(in oklab, var(--ui-primary) 55%, var(--ui-border) 45%);
  background: var(--pl-card-bg);
}

.pl-port::after {
  content: "";
  position: absolute;
  inset: -5px;
  border-radius: 999px;
  background: radial-gradient(circle, var(--pl-glow) 0%, transparent 70%);
  opacity: 0;
  animation: pl-glow var(--pl-cycle) linear infinite;
  animation-delay: calc((var(--hit, 0) - 1) * var(--pl-cycle));
}

/* stage card ------------------------------------------------------------- */
.pl-card {
  position: relative;
  height: 100%;
  border-radius: 1rem;
  border: 1px solid var(--pl-card-border);
  background: var(--pl-card-bg);
  padding: 0.8rem 0.85rem 0.85rem;
  animation: pl-lift var(--pl-cycle) linear infinite;
  animation-delay: calc((var(--hit, 0) - 1) * var(--pl-cycle));
  transition: border-color 160ms ease;
}

.pl-card:hover {
  border-color: color-mix(in oklab, var(--ui-primary) 35%, var(--pl-card-border) 65%);
}

.pl-card::after {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  pointer-events: none;
  box-shadow:
    0 0 0 1px var(--pl-glow),
    0 12px 34px -14px var(--pl-glow);
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--ui-primary) 7%, transparent),
    transparent 55%
  );
  opacity: 0;
  animation: pl-glow var(--pl-cycle) linear infinite;
  animation-delay: calc((var(--hit, 0) - 1) * var(--pl-cycle));
}

.pl-card-top {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  margin-bottom: 0.65rem;
}

.pl-num {
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--ui-primary);
}

.pl-name {
  font-size: 0.78rem;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--ui-text-highlighted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pl-desc {
  margin: 0.65rem 0 0;
  font-size: 0.68rem;
  line-height: 1.55;
  color: var(--ui-text-toned);
}

/* micro-viz zone ---------------------------------------------------------- */
.pl-micro {
  min-height: 3.3rem;
  display: flex;
  align-content: flex-start;
}

.pl-micro--row {
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0.3rem;
}

.pl-micro--col {
  flex-direction: column;
  justify-content: flex-start;
  gap: 0.38rem;
}

/* 01 · scope chip */
.pl-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  border-radius: 0.55rem;
  border: 1px solid color-mix(in oklab, var(--ui-primary) 30%, var(--ui-border) 70%);
  background: color-mix(in oklab, var(--ui-primary) 9%, var(--pl-card-bg) 91%);
  padding: 0.24rem 0.5rem;
  font-size: 0.64rem;
  font-weight: 600;
  color: color-mix(in oklab, var(--ui-primary) 70%, var(--ui-text) 30%);
}

.pl-chip code {
  font-size: 0.62rem;
  background: none;
  padding: 0;
}

.pl-chip-icon {
  width: 0.75rem;
  height: 0.75rem;
  flex: none;
}

/* 02 · validated fields */
.pl-field {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border-radius: 0.45rem;
  border: 1px solid var(--pl-card-border);
  background: color-mix(in oklab, var(--ui-bg) 60%, var(--pl-card-bg) 40%);
  padding: 0.16rem 0.4rem;
  font-size: 0.6rem;
  font-weight: 550;
  color: var(--ui-text-toned);
}

.pl-field::after {
  content: "✓";
  font-size: 0.58rem;
  font-weight: 800;
  color: var(--ui-primary);
}

/* 03 · id keyset */
.pl-id {
  width: 10px;
  height: 10px;
  margin-top: 3px;
  border-radius: 3px;
  border: 1px solid color-mix(in oklab, var(--ui-primary) 45%, var(--ui-border) 55%);
  background: color-mix(in oklab, var(--ui-primary) 16%, var(--pl-card-bg) 84%);
}

.pl-tag {
  display: inline-flex;
  border-radius: 0.4rem;
  border: 1px dashed color-mix(in oklab, var(--ui-primary) 35%, var(--ui-border) 65%);
  padding: 0.1rem 0.36rem;
  margin-left: 0.1rem;
}

.pl-tag code {
  font-size: 0.56rem;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: color-mix(in oklab, var(--ui-primary) 68%, var(--ui-text) 32%);
  background: none;
  padding: 0;
}

/* 04 · hydrated rows */
.pl-row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  width: 100%;
}

.pl-row-key {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 3px;
  background: color-mix(in oklab, var(--ui-primary) 55%, var(--pl-card-bg) 45%);
}

.pl-row-bar {
  height: 5px;
  flex: 1 1 auto;
  border-radius: 999px;
  background: color-mix(in oklab, var(--ui-text-toned) 26%, transparent);
}

.pl-row-end {
  width: 14px;
  height: 5px;
  flex: none;
  border-radius: 999px;
  background: color-mix(in oklab, var(--ui-text-toned) 16%, transparent);
}

/* 05 · facet buckets */
.pl-facet {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
}

.pl-facet em {
  font-style: normal;
  font-size: 0.58rem;
  color: var(--ui-text-toned);
  width: 3.2rem;
  flex: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pl-facet-track {
  position: relative;
  flex: 1 1 auto;
  height: 5px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--ui-border) 55%, transparent);
  overflow: hidden;
}

.pl-facet-bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--pl-glow-soft), var(--pl-amber));
  transform-origin: left center;
}

.pl-facet-count {
  font-size: 0.6rem;
  font-weight: 700;
  color: var(--ui-primary);
  width: 1rem;
  flex: none;
  text-align: right;
}

/* --------------------------------------------------- shared anim wiring */
.pl-anim,
.pl-anim-id,
.pl-anim-slide,
.pl-anim-grow {
  animation-duration: var(--pl-cycle);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  animation-delay: calc((var(--hit, 0) + var(--dh, 0) - 1) * var(--pl-cycle));
}

.pl-anim {
  animation-name: pl-pop-in;
}

.pl-anim-id {
  animation-name: pl-id-pop;
}

.pl-anim-slide {
  animation-name: pl-slide;
}

.pl-anim-grow {
  animation-name: pl-grow;
}

/* ------------------------------------------------------------ keyframes */
@keyframes pl-run-x {
  0%,
  4% {
    transform: translateX(-100%);
    opacity: 0;
  }
  7% {
    opacity: 1;
  }
  61% {
    opacity: 1;
  }
  64%,
  100% {
    transform: translateX(0%);
    opacity: 0;
  }
}

@keyframes pl-rogue-x {
  0%,
  6% {
    transform: translate(-100%, 0px);
    opacity: 0;
  }
  9% {
    opacity: 0.85;
  }
  13.5% {
    transform: translate(-90.5%, 0px);
    opacity: 0.85;
  }
  15% {
    transform: translate(-89.5%, 12px);
    opacity: 0.85;
  }
  22%,
  100% {
    transform: translate(-86%, 52px);
    opacity: 0;
  }
}

@keyframes pl-spark-x {
  0% {
    transform: translateX(-100%);
    opacity: 0;
  }
  8% {
    opacity: 0.5;
  }
  90% {
    opacity: 0.5;
  }
  100% {
    transform: translateX(0%);
    opacity: 0;
  }
}

@keyframes pl-glow {
  0% {
    opacity: 0;
    animation-timing-function: ease-out;
  }
  2.5% {
    opacity: 1;
  }
  11% {
    opacity: 1;
  }
  18%,
  100% {
    opacity: 0;
  }
}

@keyframes pl-glow-long {
  0% {
    opacity: 0;
    animation-timing-function: ease-out;
  }
  2% {
    opacity: 1;
  }
  20% {
    opacity: 1;
  }
  28%,
  100% {
    opacity: 0;
  }
}

@keyframes pl-lift {
  0% {
    transform: translateY(0);
    animation-timing-function: ease-out;
  }
  2.5% {
    transform: translateY(-3px);
  }
  12% {
    transform: translateY(-3px);
    animation-timing-function: ease-in-out;
  }
  19%,
  100% {
    transform: translateY(0);
  }
}

@keyframes pl-pop-in {
  0% {
    opacity: 0;
    transform: translateY(6px) scale(0.95);
    animation-timing-function: cubic-bezier(0.2, 0.7, 0.3, 1);
  }
  2.5% {
    opacity: 1;
    transform: none;
  }
  46% {
    opacity: 1;
    transform: none;
  }
  53%,
  100% {
    opacity: 0;
    transform: translateY(6px) scale(0.95);
  }
}

@keyframes pl-id-pop {
  0% {
    opacity: 0;
    transform: scale(0.3);
    animation-timing-function: cubic-bezier(0.2, 0.7, 0.3, 1);
  }
  1.6% {
    opacity: 1;
    transform: scale(1.18);
  }
  3% {
    transform: scale(1);
  }
  46% {
    opacity: 1;
    transform: scale(1);
  }
  53%,
  100% {
    opacity: 0;
    transform: scale(0.3);
  }
}

@keyframes pl-slide {
  0% {
    opacity: 0;
    transform: translateX(-10px);
    animation-timing-function: cubic-bezier(0.2, 0.7, 0.3, 1);
  }
  3% {
    opacity: 1;
    transform: none;
  }
  46% {
    opacity: 1;
    transform: none;
  }
  53%,
  100% {
    opacity: 0;
    transform: translateX(-10px);
  }
}

@keyframes pl-grow {
  0% {
    opacity: 0;
    transform: scaleX(0);
    animation-timing-function: cubic-bezier(0.2, 0.7, 0.3, 1);
  }
  4% {
    opacity: 1;
    transform: scaleX(1);
  }
  46% {
    opacity: 1;
    transform: scaleX(1);
  }
  53%,
  100% {
    opacity: 0;
    transform: scaleX(0);
  }
}

@keyframes pl-progress {
  0% {
    transform: scaleX(0);
    opacity: 0.9;
  }
  64% {
    transform: scaleX(1);
    opacity: 0.9;
  }
  72%,
  100% {
    transform: scaleX(1);
    opacity: 0;
  }
}

/* ------------------------------------------------- vertical (< 1024px) */
@media (max-width: 1023px) {
  .pl-viz {
    padding: 54px 0 54px 60px;
  }

  .pl-bus {
    top: 54px;
    bottom: 54px;
    left: 25px;
    right: auto;
    width: 2px;
    height: auto;
  }

  .pl-rail {
    background: linear-gradient(
      180deg,
      transparent,
      var(--pl-line) 5%,
      var(--pl-line) 95%,
      transparent
    );
  }

  .pl-rail::after {
    inset: 6% -1px;
    background: linear-gradient(180deg, transparent, var(--pl-glow-soft), transparent);
  }

  .pl-packet {
    top: 0;
    left: 50%;
    width: 0;
    height: 100%;
    transform: translateY(-100%);
    animation-name: pl-run-y;
  }

  .pl-packet::after {
    right: auto;
    top: auto;
    left: -6px;
    bottom: -6px;
  }

  .pl-packet::before {
    right: auto;
    top: auto;
    left: -1px;
    bottom: 4px;
    width: 2px;
    height: 74px;
    background: linear-gradient(180deg, transparent, var(--pl-glow));
  }

  .pl-rogue {
    top: 0;
    left: 50%;
    width: 0;
    height: 100%;
    transform: translate(0, -100%);
    animation-name: pl-rogue-y;
  }

  .pl-rogue::after {
    right: auto;
    top: auto;
    left: -4px;
    bottom: -4px;
  }

  .pl-spark {
    top: 0;
    left: 50%;
    width: 0;
    height: 100%;
    transform: translateY(-100%);
    animation-name: pl-spark-y;
  }

  .pl-spark::after {
    right: auto;
    top: auto;
    left: -2px;
    bottom: -2px;
  }

  .pl-endpoint {
    transform: none;
  }

  .pl-endpoint--in {
    top: 0;
    left: 0;
    flex-direction: row;
    align-items: center;
    gap: 0.6rem;
  }

  .pl-endpoint--out {
    top: auto;
    bottom: 0;
    left: 0;
    right: auto;
    flex-direction: row;
    align-items: center;
    gap: 0.6rem;
  }

  .pl-stages {
    grid-template-columns: 1fr;
  }

  .pl-stage {
    padding: 0.45rem 0;
  }

  .pl-stub {
    left: -35px;
    top: 50%;
    width: 35px;
    height: 2px;
  }

  .pl-stub::after {
    background: linear-gradient(90deg, var(--pl-amber), var(--pl-glow-soft));
  }

  .pl-port {
    left: -38.5px;
    top: calc(50% - 2.5px);
  }

  .pl-micro {
    min-height: 2.4rem;
    margin-top: 0.1rem;
  }

  .pl-desc {
    max-width: 30rem;
  }
}

@keyframes pl-run-y {
  0%,
  4% {
    transform: translateY(-100%);
    opacity: 0;
  }
  7% {
    opacity: 1;
  }
  61% {
    opacity: 1;
  }
  64%,
  100% {
    transform: translateY(0%);
    opacity: 0;
  }
}

@keyframes pl-rogue-y {
  0%,
  6% {
    transform: translate(0px, -100%);
    opacity: 0;
  }
  9% {
    opacity: 0.85;
  }
  13.5% {
    transform: translate(0px, -90.5%);
    opacity: 0.85;
  }
  15% {
    transform: translate(-12px, -89.5%);
    opacity: 0.85;
  }
  22%,
  100% {
    transform: translate(-30px, -86%);
    opacity: 0;
  }
}

@keyframes pl-spark-y {
  0% {
    transform: translateY(-100%);
    opacity: 0;
  }
  8% {
    opacity: 0.5;
  }
  90% {
    opacity: 0.5;
  }
  100% {
    transform: translateY(0%);
    opacity: 0;
  }
}

/* ------------------------------------------------------- motion guards */
.pl-paused *,
.pl-paused *::before,
.pl-paused *::after {
  animation-play-state: paused !important;
}

@media (prefers-reduced-motion: reduce) {
  .pl *,
  .pl *::before,
  .pl *::after {
    animation: none !important;
  }

  /* keep the transient actors hidden in the static diagram */
  .pl-packet,
  .pl-rogue,
  .pl-spark {
    display: none;
  }
}
</style>
