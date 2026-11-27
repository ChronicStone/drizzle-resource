<script setup lang="ts">
/*
 * One illustration per feature tile. All share one drawing style: a 280×112 canvas,
 * thin strokes, the graphite ink scale and one yellow accent. Every loop is 6s or 9s and
 * pauses while the tile is off screen.
 */
defineProps<{ id: string; playing: boolean }>();
</script>

<template>
  <svg class="art" :class="[`a-${id}`, { play: playing }]" viewBox="0 0 280 112" aria-hidden="true">
    <!-- FILTERS: a logic tree grows from AND into an OR group -->
    <g v-if="id === 'filters'">
      <path class="wire w1" pathLength="1" d="M60 56 C 84 56, 84 28, 106 28" />
      <path class="wire w2" pathLength="1" d="M60 56 C 84 56, 84 84, 106 84" />
      <path class="wire w3" pathLength="1" d="M130 84 C 148 84, 148 70, 164 70" />
      <path class="wire w4" pathLength="1" d="M130 84 C 148 84, 148 98, 164 98" />
      <g class="pop p0">
        <rect class="hit" x="22" y="43" width="38" height="26" rx="5" />
        <text class="t-ink-dark" x="41" y="60" text-anchor="middle">AND</text>
      </g>
      <g class="pop p1">
        <rect class="card" x="106" y="17" width="152" height="22" rx="6" />
        <text class="t" x="116" y="31">
          <tspan class="k">status</tspan>
          is
          <tspan class="v">shipped</tspan>
        </text>
      </g>
      <g class="pop p2">
        <rect class="ring" x="106" y="72" width="24" height="24" rx="5" />
        <text class="t-hit" x="118" y="87" text-anchor="middle">OR</text>
      </g>
      <g class="pop p3">
        <rect class="card" x="164" y="59" width="104" height="22" rx="6" />
        <text class="t" x="173" y="73">
          <tspan class="k">total</tspan>
          ≥
          <tspan class="v">20k</tspan>
        </text>
      </g>
      <g class="pop p4">
        <rect class="card" x="164" y="87" width="104" height="22" rx="6" />
        <text class="t" x="173" y="101">
          <tspan class="k">date</tspan>
          &gt;
          <tspan class="v">Jan 1</tspan>
        </text>
      </g>
    </g>

    <!-- SEARCH: a lens passes over rows from two tables, matches light up -->
    <g v-else-if="id === 'search'">
      <g
        v-for="(r, i) in [
          [24, 120, 'orders'],
          [46, 96, 'customer'],
          [68, 132, 'orders'],
          [90, 84, 'product'],
        ]"
        :key="i"
      >
        <rect class="bar" x="22" :y="Number(r[0]) - 4" :width="Number(r[1])" height="8" rx="4" />
        <text class="t-dim" x="258" :y="Number(r[0]) + 3" text-anchor="end">{{ r[2] }}</text>
      </g>
      <rect class="match m1" x="50" y="38" width="34" height="16" rx="4" />
      <rect class="match m2" x="70" y="82" width="34" height="16" rx="4" />
      <g class="lens">
        <circle class="glass" cx="0" cy="0" r="17" />
        <path class="handle" d="M12 12 L 22 22" />
      </g>
    </g>

    <!-- SORTING: bars reorder by height -->
    <g v-else-if="id === 'sort'">
      <line class="axis" x1="30" y1="96" x2="250" y2="96" />
      <rect
        v-for="(b, i) in [
          [40, 3],
          [74, 0],
          [22, 5],
          [62, 1],
          [50, 2],
          [30, 4],
        ]"
        :key="i"
        class="sbar"
        :class="{ top: i === 1 }"
        :x="44 + i * 34"
        :y="96 - b[0]!"
        width="24"
        :height="b[0]"
        rx="3"
        :style="{ '--dx': `${(b[1]! - i) * 34}px` }"
      />
      <g class="keys">
        <rect class="hit" x="30" y="10" width="16" height="14" rx="3" />
        <text class="t-ink-dark" x="38" y="20.5" text-anchor="middle">1</text>
        <text class="t" x="52" y="20.5">total ↓</text>
        <rect class="ring" x="104" y="10" width="16" height="14" rx="3" />
        <text class="t-hit" x="112" y="20.5" text-anchor="middle">2</text>
        <text class="t" x="126" y="20.5">date ↓</text>
      </g>
    </g>

    <!-- PAGINATION: a page window steps along the result, a cursor marks where the next starts -->
    <g v-else-if="id === 'pages'">
      <rect
        v-for="n in 24"
        :key="n"
        class="tick"
        :x="22 + (n - 1) * 10"
        y="40"
        width="6"
        :height="34 - ((n * 7) % 11)"
        rx="2"
      />
      <g class="window">
        <rect class="ring wide" x="17" y="32" width="66" height="50" rx="7" />
        <path class="cursor" d="M86 44 l8 6 l-8 6 z" />
      </g>
      <text class="t-dim" x="22" y="100">page</text>
      <text class="t-hit pageno" x="50" y="100">1 → 2 → 3</text>
      <text class="t-dim" x="258" y="100" text-anchor="end">cursor or offset</text>
    </g>

    <!-- FACETS: buckets with counts -->
    <g v-else-if="id === 'facets'">
      <g
        v-for="(f, i) in [
          ['shipped', 1240, 168],
          ['processing', 526, 72],
          ['pending', 459, 62],
          ['cancelled', 187, 26],
        ]"
        :key="i"
        :style="{ '--i': i }"
      >
        <rect
          :class="i === 0 ? 'hit' : 'box'"
          x="22"
          :y="14 + i * 23"
          width="10"
          height="10"
          rx="2"
        />
        <text :class="i === 0 ? 't-strong' : 't'" x="40" :y="23 + i * 23">{{ f[0] }}</text>
        <text class="t-dim" x="258" :y="23 + i * 23" text-anchor="end">
          {{ Number(f[1]).toLocaleString("en-US") }}
        </text>
        <rect class="track" x="40" :y="27 + i * 23" width="218" height="3" rx="1.5" />
        <rect
          class="fbar"
          :class="{ on: i === 0 }"
          x="40"
          :y="27 + i * 23"
          :width="f[2]"
          height="3"
          rx="1.5"
        />
      </g>
    </g>

    <!-- TOTALS: rows flow into one sum -->
    <g v-else-if="id === 'summary'">
      <g v-for="n in 7" :key="n" :style="{ '--i': n }">
        <rect
          class="row"
          x="22"
          :y="10 + (n - 1) * 14"
          :width="44 + ((n * 13) % 30)"
          height="7"
          rx="3.5"
        />
        <path
          class="flow"
          pathLength="1"
          :d="`M${70 + ((n * 13) % 30)} ${13.5 + (n - 1) * 14} C 130 ${13.5 + (n - 1) * 14}, 120 56, 152 56`"
        />
      </g>
      <circle class="sigma-ring" cx="166" cy="56" r="15" />
      <text class="t-hit sigma" x="166" y="61" text-anchor="middle">Σ</text>
      <g class="result">
        <text class="pix" x="192" y="52">4.53M</text>
        <text class="t-dim" x="193" y="68">sum(total)</text>
      </g>
    </g>

    <!-- TENANT SCOPE: the query only reaches acme's tiles -->
    <g v-else-if="id === 'scope'">
      <text class="t-hit" x="22" y="18">acme</text>
      <text class="t-dim" x="160" y="18">globex</text>
      <rect
        v-for="n in 12"
        :key="`a${n}`"
        class="tile on"
        :x="22 + ((n - 1) % 4) * 26"
        :y="28 + Math.floor((n - 1) / 4) * 26"
        width="20"
        height="20"
        rx="3"
        :style="{ '--i': n }"
      />
      <rect
        v-for="n in 12"
        :key="`g${n}`"
        class="tile off"
        :x="160 + ((n - 1) % 4) * 26"
        :y="28 + Math.floor((n - 1) / 4) * 26"
        width="20"
        height="20"
        rx="3"
      />
      <line class="wall" x1="139" y1="22" x2="139" y2="104" />
      <g class="lock" transform="translate(131 52)">
        <rect class="lock-body" x="0" y="7" width="16" height="12" rx="2" />
        <path class="lock-arc" d="M4 7 V 4 a4 4 0 0 1 8 0 V 7" />
      </g>
      <rect class="beam" x="18" y="24" width="104" height="26" rx="4" />
    </g>

    <!-- FIELD POLICY: visible, private, not filterable -->
    <g v-else-if="id === 'policy'">
      <g v-for="(f, i) in ['reference', 'email', 'deletedAt']" :key="f">
        <rect class="card" x="22" :y="10 + i * 32" width="236" height="26" rx="6" />
        <text :class="i === 1 ? 't-dim' : 't-strong'" x="34" :y="27 + i * 32">{{ f }}</text>
      </g>
      <!-- row 1: eye + funnel, both on -->
      <g transform="translate(206 15)" class="ico">
        <path d="M0 8 C 4 1, 12 1, 16 8 C 12 15, 4 15, 0 8 Z" />
        <circle cx="8" cy="8" r="2.5" />
      </g>
      <g transform="translate(232 16)" class="ico">
        <path d="M0 1 H 14 L 9 7 V 13 L 5 11 V 7 Z" />
      </g>
      <!-- row 2: eye struck -->
      <g transform="translate(206 47)" class="ico">
        <path d="M0 8 C 4 1, 12 1, 16 8 C 12 15, 4 15, 0 8 Z" />
        <circle cx="8" cy="8" r="2.5" />
      </g>
      <path class="strike s1" pathLength="1" d="M203 64 L 225 46" />
      <text class="t-warn tag1" x="170" y="59" text-anchor="end">private</text>
      <!-- row 3: funnel struck -->
      <g transform="translate(206 79)" class="ico">
        <path d="M0 8 C 4 1, 12 1, 16 8 C 12 15, 4 15, 0 8 Z" />
        <circle cx="8" cy="8" r="2.5" />
      </g>
      <g transform="translate(232 80)" class="ico">
        <path d="M0 1 H 14 L 9 7 V 13 L 5 11 V 7 Z" />
      </g>
      <path class="strike s2" pathLength="1" d="M229 96 L 249 78" />
      <text class="t-warn tag2" x="170" y="91" text-anchor="end">no filter</text>
    </g>

    <!-- VIEWS: one source, three shapes -->
    <g v-else-if="id === 'views'">
      <rect class="card" x="22" y="10" width="72" height="92" rx="7" />
      <rect
        v-for="n in 6"
        :key="n"
        class="field"
        :class="`f${n}`"
        x="32"
        :y="20 + (n - 1) * 13.5"
        :width="40 + ((n * 7) % 14)"
        height="6"
        rx="3"
      />
      <g
        v-for="(v, i) in [
          ['list', 3, 14],
          ['export', 5, 46],
          ['client', 2, 80],
        ]"
        :key="v[0]"
        class="out"
        :class="`o${i}`"
      >
        <path
          class="flow"
          pathLength="1"
          :d="`M94 56 C 124 56, 124 ${Number(v[2]) + 10}, 150 ${Number(v[2]) + 10}`"
        />
        <rect class="card" x="150" :y="v[2]" width="108" height="20" rx="5" />
        <rect
          v-for="k in Number(v[1])"
          :key="k"
          class="chip"
          :x="157 + (k - 1) * (46 / Number(v[1]) + 3)"
          :y="Number(v[2]) + 7"
          :width="46 / Number(v[1])"
          height="6"
          rx="3"
        />
        <text class="t-dim" x="252" :y="Number(v[2]) + 13.5" text-anchor="end">{{ v[0] }}</text>
      </g>
    </g>

    <!-- RELATIONS: three tables joined, a dot travels the path -->
    <g v-else-if="id === 'relations'">
      <g v-for="(t, i) in ['orders', 'orderLines', 'product']" :key="t">
        <rect class="card" :x="22 + i * 88" y="16" width="68" height="62" rx="6" />
        <rect
          :class="i === 2 ? 'hit' : 'head'"
          :x="22 + i * 88"
          y="16"
          width="68"
          height="14"
          rx="6"
        />
        <rect :class="i === 2 ? 'hit' : 'head'" :x="22 + i * 88" y="24" width="68" height="6" />
        <rect
          v-for="r in 3"
          :key="r"
          class="bar"
          :x="30 + i * 88"
          :y="34 + (r - 1) * 13"
          :width="40 - r * 5"
          height="6"
          rx="3"
        />
        <text class="t-dim" :x="56 + i * 88" y="96" text-anchor="middle">{{ t }}</text>
      </g>
      <path class="join" pathLength="1" d="M90 50 C 100 50, 100 37, 110 37" />
      <path class="join" pathLength="1" d="M178 50 C 188 50, 188 37, 198 37" />
      <circle v-if="playing" class="dot" r="3.5">
        <animateMotion
          dur="3s"
          repeatCount="indefinite"
          path="M56 50 L 90 50 C 100 50, 100 37, 110 37 L 144 37 L 144 50 L 178 50 C 188 50, 188 37, 198 37 L 232 37"
        />
      </circle>
    </g>

    <!-- TYPED PATHS: segments snap together, the editor suggests the next -->
    <g v-else-if="id === 'types'">
      <rect class="card" x="22" y="12" width="236" height="26" rx="6" />
      <text class="t" x="32" y="29">
        <tspan class="k">key: "</tspan>
        <tspan class="seg s1">orderLines</tspan>
        <tspan class="seg s1">.</tspan>
        <tspan class="seg s2">product</tspan>
        <tspan class="seg s2">.</tspan>
        <tspan class="seg s3 v">category</tspan>
        <tspan class="k">"</tspan>
      </text>
      <g class="menu">
        <rect class="card" x="96" y="44" width="150" height="58" rx="6" />
        <rect class="sel" x="99" y="47" width="144" height="16" rx="4" />
        <text class="t" x="106" y="58">product.name</text>
        <text class="t" x="106" y="76">product.sku</text>
        <text class="t" x="106" y="94">product.category</text>
        <text class="t-dim" x="238" y="58" text-anchor="end">text</text>
        <text class="t-dim" x="238" y="76" text-anchor="end">text</text>
        <text class="t-dim" x="238" y="94" text-anchor="end">enum</text>
      </g>
    </g>

    <!-- BULK SCANS: one cursor reads the matching rows in batches -->
    <g v-else-if="id === 'scan'">
      <rect
        v-for="n in 9"
        :key="n"
        class="row"
        x="22"
        :y="12 + (n - 1) * 10"
        :width="52 + ((n * 17) % 34)"
        height="6"
        rx="3"
      />
      <rect class="batch" x="16" y="8" width="118" height="34" rx="5" />
      <path class="flow" pathLength="1" d="M136 52 C 150 52, 150 52, 164 52" />
      <g v-for="n in 3" :key="`b${n}`" :class="`out o${n}`">
        <rect class="card" x="168" :y="12 + (n - 1) * 30" width="90" height="24" rx="6" />
        <text class="t-strong" x="178" :y="28 + (n - 1) * 30">batch {{ n }}</text>
        <text class="t-dim" x="250" :y="28 + (n - 1) * 30" text-anchor="end">1000</text>
      </g>
      <text class="t-dim" x="22" y="106">one cursor, one snapshot</text>
    </g>

    <!-- VIRTUAL FIELDS: a column computed by the database -->
    <g v-else-if="id === 'virtual'">
      <rect class="card" x="22" y="10" width="236" height="76" rx="7" />
      <text class="t-dim" x="34" y="26">name</text>
      <text class="t-dim" x="106" y="26">total</text>
      <text class="t-hit" x="178" y="26">latestOrder</text>
      <rect class="vcol" x="170" y="14" width="82" height="68" rx="4" />
      <g
        v-for="(r, i) in [
          ['Ada', '120.00', 'ORD-2041'],
          ['Lin', '64.50', 'ORD-2038'],
          ['Sam', '9.00', 'ORD-1977'],
        ]"
        :key="r[0]"
      >
        <text class="t-strong" x="34" :y="46 + i * 15">{{ r[0] }}</text>
        <text class="t" x="106" :y="46 + i * 15">{{ r[1] }}</text>
        <text class="t-hit vval" x="178" :y="46 + i * 15" :style="{ '--i': i }">{{ r[2] }}</text>
      </g>
      <text class="t-dim" x="258" y="104" text-anchor="end">virtual.scalar(select … limit 1)</text>
    </g>

    <!-- VALIDATION: requests pass a gate, one is turned back -->
    <g v-else>
      <line class="lane" x1="22" y1="60" x2="258" y2="60" />
      <rect class="post" x="132" y="22" width="6" height="76" rx="2" />
      <rect class="post" x="142" y="22" width="6" height="76" rx="2" />
      <rect class="pkt k1" x="18" y="50" width="20" height="20" rx="4" />
      <rect class="pkt k2" x="18" y="50" width="20" height="20" rx="4" />
      <rect class="pkt bad k3" x="18" y="50" width="20" height="20" rx="4" />
      <g class="reject">
        <rect class="warn-box" x="166" y="14" width="92" height="22" rx="5" />
        <text class="t-warn" x="212" y="29" text-anchor="middle">400 · unknown field</text>
      </g>
      <text class="t-dim" x="258" y="104" text-anchor="end">z.object(…) from the resource</text>
    </g>
  </svg>
</template>

<style scoped>
.art {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
  font-family: var(--font-mono);
}
.art * {
  animation-play-state: paused !important;
}
.art.play * {
  animation-play-state: running !important;
}
.art [class] {
  transform-box: fill-box;
}

/* shared paint */
.card {
  fill: var(--panel);
  stroke: var(--line2);
  stroke-width: 1;
}
.head {
  fill: var(--line2);
}
.hit {
  fill: var(--hit);
}
.ring {
  fill: color-mix(in srgb, var(--hit) 12%, transparent);
  stroke: var(--hit);
  stroke-width: 1.3;
}
.box {
  fill: none;
  stroke: var(--line2);
  stroke-width: 1.2;
}
.bar,
.row,
.field,
.chip {
  fill: var(--line2);
}
.track {
  fill: var(--line);
}
.wire,
.flow,
.join {
  fill: none;
  stroke: var(--ink3);
  stroke-width: 1.2;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
}
text {
  font-size: 9.5px;
}
.t {
  fill: var(--ink2);
}
.t-strong {
  fill: var(--ink);
  font-weight: 600;
}
.t-dim {
  fill: var(--ink3);
  font-size: 8.5px;
}
.t-hit {
  fill: var(--hit-text);
  font-weight: 600;
}
.t-warn {
  fill: var(--px-warn);
  font-weight: 600;
}
.t-ink-dark {
  fill: var(--hit-ink);
  font-weight: 700;
  font-size: 9px;
}
.k {
  fill: var(--ink3);
}
.v {
  fill: var(--hit-text);
  font-weight: 600;
}
.pix {
  font-family: var(--font-pixel);
  font-weight: 800;
  font-size: 24px;
  fill: var(--ink);
}

@keyframes draw {
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes pop6 {
  0% {
    opacity: 0;
    transform: scale(0.85);
  }
  8%,
  88% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
  }
}
@keyframes draw6 {
  0% {
    stroke-dashoffset: 1;
  }
  10%,
  88% {
    stroke-dashoffset: 0;
    opacity: 1;
  }
  100% {
    stroke-dashoffset: 0;
    opacity: 0;
  }
}

/* filters */
.a-filters .pop {
  transform-origin: left center;
  animation: pop6 6s var(--ease) infinite backwards;
}
.a-filters .p1 {
  animation-delay: 0.45s;
}
.a-filters .p2 {
  animation-delay: 0.6s;
}
.a-filters .p3 {
  animation-delay: 1.05s;
}
.a-filters .p4 {
  animation-delay: 1.2s;
}
.a-filters .wire {
  animation: draw6 6s ease-out infinite backwards;
}
.a-filters .w1,
.a-filters .w2 {
  animation-delay: 0.2s;
}
.a-filters .w3,
.a-filters .w4 {
  animation-delay: 0.8s;
}

/* search */
.a-search .lens {
  animation: lens 6s var(--ease) infinite;
}
.a-search .glass {
  fill: color-mix(in srgb, var(--hit) 10%, transparent);
  stroke: var(--ink);
  stroke-width: 2;
}
.a-search .handle {
  stroke: var(--ink);
  stroke-width: 3;
  stroke-linecap: round;
}
@keyframes lens {
  0% {
    transform: translate(250px, 20px);
  }
  25%,
  42% {
    transform: translate(67px, 46px);
  }
  62%,
  80% {
    transform: translate(87px, 90px);
  }
  100% {
    transform: translate(250px, 20px);
  }
}
.a-search .match {
  fill: color-mix(in srgb, var(--hit) 55%, transparent);
  opacity: 0;
  animation: 6s infinite;
}
.a-search .m1 {
  animation-name: m1;
}
.a-search .m2 {
  animation-name: m2;
}
@keyframes m1 {
  0%,
  24% {
    opacity: 0;
  }
  30%,
  92% {
    opacity: 1;
  }
}
@keyframes m2 {
  0%,
  61% {
    opacity: 0;
  }
  67%,
  92% {
    opacity: 1;
  }
}

/* sorting */
.a-sort .axis {
  stroke: var(--line2);
}
.a-sort .sbar {
  fill: var(--line2);
  animation: sortmove 6s var(--ease) infinite;
}
.a-sort .sbar.top {
  fill: var(--hit);
}
@keyframes sortmove {
  0%,
  15% {
    transform: none;
  }
  40%,
  85% {
    transform: translateX(var(--dx));
  }
  100% {
    transform: none;
  }
}

/* pagination */
.a-pages .tick {
  fill: var(--line2);
}
.a-pages .wide {
  stroke-width: 1.6;
}
.a-pages .window {
  animation: pagestep 6s steps(1) infinite;
}
.a-pages .cursor {
  fill: var(--hit);
}
@keyframes pagestep {
  0% {
    transform: translateX(0);
  }
  33% {
    transform: translateX(60px);
  }
  66% {
    transform: translateX(120px);
  }
}

/* facets */
.a-facets .fbar {
  fill: var(--ink3);
  transform-origin: left center;
  animation: grow 6s var(--ease) infinite backwards;
  animation-delay: calc(var(--i) * 0.12s);
}
.a-facets .fbar.on {
  fill: var(--hit);
}
@keyframes grow {
  0% {
    transform: scaleX(0);
  }
  20%,
  100% {
    transform: none;
  }
}

/* totals */
.a-summary .row {
  animation: rowlit 6s infinite;
  animation-delay: calc(var(--i) * 0.08s);
}
@keyframes rowlit {
  0%,
  4% {
    fill: var(--line2);
  }
  10%,
  30% {
    fill: color-mix(in srgb, var(--hit) 60%, var(--line2));
  }
  40%,
  100% {
    fill: var(--line2);
  }
}
.a-summary .flow {
  stroke: color-mix(in srgb, var(--hit) 70%, var(--ink3));
  animation: draw6 6s ease-out infinite backwards;
  animation-delay: calc(0.15s + var(--i) * 0.08s);
}
.a-summary .sigma-ring {
  fill: var(--bg);
  stroke: var(--hit);
  stroke-width: 1.5;
}
.a-summary .sigma {
  font-size: 15px;
  font-family: var(--font-sans);
}
.a-summary .result {
  animation: pop6 6s var(--ease) infinite backwards;
  animation-delay: 1s;
}

/* scope */
.a-scope .tile.on {
  fill: var(--panel);
  stroke: var(--line2);
  animation: tilelit 3s infinite;
  animation-delay: calc(var(--i) * 0.06s);
}
@keyframes tilelit {
  0%,
  100% {
    fill: var(--panel);
  }
  20%,
  40% {
    fill: color-mix(in srgb, var(--hit) 40%, var(--panel));
  }
}
.a-scope .tile.off {
  fill: none;
  stroke: var(--line2);
  stroke-dasharray: 3 3;
}
.a-scope .wall {
  stroke: var(--ink3);
  stroke-width: 1.5;
  stroke-dasharray: 2 4;
}
.a-scope .lock-body {
  fill: var(--ink);
}
.a-scope .lock-arc {
  fill: none;
  stroke: var(--ink);
  stroke-width: 2;
}
.a-scope .beam {
  fill: color-mix(in srgb, var(--hit) 22%, transparent);
  animation: beam 3s var(--ease) infinite;
}
@keyframes beam {
  0%,
  8% {
    transform: translateY(0);
  }
  38%,
  45% {
    transform: translateY(26px);
  }
  75%,
  100% {
    transform: translateY(52px);
  }
}

/* field policy */
.a-policy .ico path,
.a-policy .ico circle {
  fill: none;
  stroke: var(--ink2);
  stroke-width: 1.3;
}
.a-policy .strike {
  fill: none;
  stroke: var(--px-warn);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: draw6 6s ease-out infinite backwards;
}
.a-policy .s1 {
  animation-delay: 0.4s;
}
.a-policy .s2 {
  animation-delay: 1.1s;
}
.a-policy .tag1,
.a-policy .tag2 {
  animation: pop6 6s var(--ease) infinite backwards;
}
.a-policy .tag1 {
  animation-delay: 0.6s;
}
.a-policy .tag2 {
  animation-delay: 1.3s;
}

/* views */
.a-views .out {
  animation: viewcycle 9s infinite;
}
.a-views .o1 {
  animation-delay: 3s;
}
.a-views .o2 {
  animation-delay: 6s;
}
@keyframes viewcycle {
  0%,
  33% {
    opacity: 1;
  }
  36%,
  97% {
    opacity: 0.35;
  }
  100% {
    opacity: 1;
  }
}
.a-views .flow {
  stroke-dashoffset: 0;
  stroke: var(--ink3);
}
.a-views .out .chip {
  fill: var(--hit);
}
.a-views .field {
  animation: fieldcycle 9s steps(1) infinite;
}
.a-views .f1,
.a-views .f2,
.a-views .f3 {
  animation-name: fieldA;
}
.a-views .f4,
.a-views .f5 {
  animation-name: fieldB;
}
.a-views .f6 {
  animation-name: fieldC;
}
@keyframes fieldA {
  0% {
    fill: var(--hit);
  }
  33.3% {
    fill: var(--hit);
  }
  66.6% {
    fill: var(--line2);
  }
}
@keyframes fieldB {
  0% {
    fill: var(--line2);
  }
  33.3% {
    fill: var(--hit);
  }
  66.6% {
    fill: var(--line2);
  }
}
@keyframes fieldC {
  0% {
    fill: var(--line2);
  }
  66.6% {
    fill: var(--hit);
  }
}

/* relations */
.a-relations .join {
  stroke: var(--hit);
  stroke-width: 1.5;
  stroke-dashoffset: 0;
}
.a-relations .dot {
  fill: var(--hit);
  stroke: var(--bg);
  stroke-width: 2;
}

/* typed paths */
.a-types .seg {
  opacity: 0;
  animation: seg 6s infinite;
}
.a-types .s2 {
  animation-delay: 0.7s;
}
.a-types .s3 {
  animation-delay: 2.4s;
}
.a-types .s1 {
  fill: var(--ink);
}
.a-types .s2 {
  fill: var(--ink);
}
@keyframes seg {
  0%,
  2% {
    opacity: 0;
  }
  6%,
  92% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
.a-types .menu {
  animation: menu 6s var(--ease) infinite backwards;
}
@keyframes menu {
  0%,
  16% {
    opacity: 0;
    transform: translateY(-4px);
  }
  20%,
  40% {
    opacity: 1;
    transform: none;
  }
  44%,
  100% {
    opacity: 0;
  }
}
.a-types .sel {
  fill: color-mix(in srgb, var(--hit) 25%, transparent);
  animation: selmove 6s steps(1) infinite;
}
@keyframes selmove {
  0% {
    transform: translateY(0);
  }
  26% {
    transform: translateY(18px);
  }
  33% {
    transform: translateY(36px);
  }
}

/* validation */
.a-validation .lane {
  stroke: var(--line2);
  stroke-dasharray: 3 4;
}
.a-validation .post {
  fill: var(--ink3);
}
.a-validation .pkt {
  fill: var(--hit);
  animation: pass 6s var(--ease) infinite backwards;
}
.a-validation .k2 {
  animation-delay: 1s;
}
.a-validation .pkt.bad {
  fill: var(--px-warn);
  animation-name: bounce;
  animation-delay: 2s;
}
@keyframes pass {
  0% {
    opacity: 0;
    transform: translateX(0);
  }
  5% {
    opacity: 1;
  }
  45% {
    transform: translateX(220px);
    opacity: 1;
  }
  50%,
  100% {
    transform: translateX(220px);
    opacity: 0;
  }
}
@keyframes bounce {
  0% {
    opacity: 0;
    transform: translateX(0);
  }
  5% {
    opacity: 1;
  }
  22% {
    transform: translateX(98px);
  }
  32% {
    transform: translateX(70px) rotate(-12deg);
  }
  52% {
    transform: translateX(70px) translateY(40px) rotate(-30deg);
    opacity: 0;
  }
  100% {
    opacity: 0;
  }
}
.a-validation .reject {
  animation: pop6 6s var(--ease) infinite backwards;
  animation-delay: 3.2s;
}
.a-validation .warn-box {
  fill: color-mix(in srgb, var(--px-warn) 10%, transparent);
  stroke: color-mix(in srgb, var(--px-warn) 55%, transparent);
}

/* bulk scans */
.a-scan .batch {
  fill: color-mix(in srgb, var(--hit) 14%, transparent);
  stroke: var(--hit);
  stroke-width: 1.2;
  animation: scanband 6s steps(1, end) infinite;
}
@keyframes scanband {
  0% {
    transform: translateY(0);
  }
  33% {
    transform: translateY(30px);
  }
  66% {
    transform: translateY(60px);
  }
}
.a-scan .flow {
  stroke: color-mix(in srgb, var(--hit) 70%, var(--ink3));
  stroke-dashoffset: 0;
}
.a-scan .out {
  opacity: 0.35;
  animation: scanout 6s steps(1, end) infinite;
}
.a-scan .o2 {
  animation-delay: 2s;
}
.a-scan .o3 {
  animation-delay: 4s;
}
@keyframes scanout {
  0% {
    opacity: 1;
  }
  33% {
    opacity: 0.35;
  }
}

/* virtual fields */
.a-virtual .vcol {
  fill: color-mix(in srgb, var(--hit) 10%, transparent);
  stroke: var(--hit);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}
.a-virtual .vval {
  animation: vpop 6s var(--ease) infinite backwards;
  animation-delay: calc(0.4s + var(--i) * 0.25s);
}
@keyframes vpop {
  0%,
  6% {
    opacity: 0;
  }
  14%,
  100% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .art * {
    animation: none !important;
  }
  .wire,
  .flow,
  .strike {
    stroke-dashoffset: 0;
  }
}
</style>
