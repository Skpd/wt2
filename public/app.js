/* Wild Terra 2 wiki — Vue 3 SPA with hash routing (works on GitHub Pages).
 * Data comes from data/*.json, produced by bin/extract.py. */
'use strict';

const { createApp, reactive, computed } = Vue;
const { createRouter, createWebHashHistory } = VueRouter;

const COLLECTIONS = ['items', 'mobs', 'npcs', 'objects', 'quests', 'recipes', 'loot', 'gathers',
    'areas', 'fishing', 'effects', 'bonuses', 'skills'];

const LANG_NAMES = {
    en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano', pt_BR: 'Português (BR)',
    pl: 'Polski', nl: 'Nederlands', lt: 'Lietuvių', el: 'Ελληνικά', tr: 'Türkçe', ru: 'Русский',
    uk: 'Українська', ja: '日本語', ko: '한국어', zh_Hans: '简体中文',
};

const DIFFICULTY = { '-2': 'Easy', '-1': 'Casual', 0: 'Normal', 1: 'Hard', 2: 'Nightmare' };
const RARITY_ORDER = ['Trash', 'Normal', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Artefact'];

// kind -> collection, route and locale key of its display name
const KIND = {
    item: { coll: 'items', route: 'items', key: id => `Item.${id}`, label: 'Item' },
    mob: { coll: 'mobs', route: 'mobs', key: id => `Entity.${id}`, label: 'Mob' },
    npc: { coll: 'npcs', route: 'npcs', key: id => `Entity.${id}`, label: 'NPC' },
    object: { coll: 'objects', route: 'objects', key: id => `WorldObject.${id}`, label: 'Object' },
    quest: { coll: 'quests', route: 'quests', key: id => `Quest.${id}.Name`, label: 'Quest' },
    area: { coll: 'areas', route: 'areas', key: id => `UI.World.Areas.${id}`, label: 'Area' },
    skill: { coll: 'skills', route: 'skills', key: id => `Skill.${id}`, label: 'Skill' },
    bonus: { coll: 'bonuses', route: 'bonuses', key: id => `Bonus.${id}`, label: 'Bonus' },
    effect: { coll: 'effects', route: null, key: id => `Effect.${id}`, label: 'Effect' },
    passive: { coll: null, route: null, key: id => `Passive.${id}`, label: 'Passive' },
    folder: { coll: null, route: null, key: id => `CraftFolder.${id}`, label: 'Folder' },
};

/* ---------------------------------------------------------------- store */

function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}
function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode etc. */ }
}

const store = reactive({
    ready: false,
    error: null,
    progress: 0,
    meta: null,
    changes: null,
    data: {},
    lang: storageGet('wt2.lang') || 'en',
    strings: {},
    fallback: {},
    theme: storageGet('wt2.theme') || '',
});

async function fetchJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
}

async function loadAll() {
    try {
        store.meta = await fetchJson('data/meta.json');
        if (!store.meta.languages.includes(store.lang)) store.lang = 'en';
        const jobs = COLLECTIONS.map(name => fetchJson(`data/${name}.json`).then(d => {
            store.data[name] = Object.freeze(d);
            store.progress++;
        }));
        jobs.push(fetchJson('data/i18n/en.json').then(d => { store.fallback = Object.freeze(d); store.progress++; }));
        if (store.lang !== 'en') {
            jobs.push(fetchJson(`data/i18n/${store.lang}.json`).then(d => { store.strings = Object.freeze(d); store.progress++; }));
        }
        await Promise.all(jobs);
        if (store.lang === 'en') store.strings = store.fallback;
        buildIndexes();
        store.ready = true;
        if (store.meta.changes) fetchJson('data/changes.json').then(d => { store.changes = d; }).catch(() => {});
    } catch (e) {
        store.error = String(e);
    }
}

async function setLang(lang) {
    store.strings = lang === 'en' ? store.fallback : Object.freeze(await fetchJson(`data/i18n/${lang}.json`));
    store.lang = lang;
    storageSet('wt2.lang', lang);
    document.documentElement.lang = lang.replace('_', '-');
    window.posthog?.register({ wiki_lang: lang });
}

function applyTheme() {
    if (store.theme) document.documentElement.dataset.theme = store.theme;
    else delete document.documentElement.dataset.theme;
}

/* ---------------------------------------------------------------- derived indexes */

const idx = {};

function buildIndexes() {
    const { mobs, objects, items, loot, recipes, quests } = store.data;
    // corpse object -> mobs, loot table -> where it drops
    idx.corpseOf = {};
    for (const [id, m] of Object.entries(mobs)) {
        if (m.corpse) (idx.corpseOf[m.corpse] ||= []).push(id);
    }
    idx.tableOwners = {};
    for (const [tid, t] of Object.entries(loot)) {
        const owners = [];
        for (const f of t.from) {
            if (f.t === 'object' && idx.corpseOf[f.id]) {
                for (const mid of idx.corpseOf[f.id]) owners.push({ t: 'mob', id: mid });
            } else if (f.t === 'object' && objects[f.id]) {
                owners.push(f);
            } else if (f.t === 'item' && items[f.id]) {
                owners.push(f);
            }
        }
        idx.tableOwners[tid] = owners;
    }
    // recipe lookups
    idx.recipeSkills = [...new Set(Object.values(recipes).map(r => r.skill).filter(Boolean))].sort();
    idx.recipeStations = [...new Set(Object.values(recipes).flatMap(r => r.stations || []))].sort();
    idx.questLines = [...new Set(Object.values(quests).map(q => q.line))].sort();
    idx.questKinds = [...new Set(Object.values(quests).map(q => q.kind))].sort();
}

/* ---------------------------------------------------------------- text helpers */

function t(key) {
    return store.strings[key] ?? store.fallback[key];
}

function humanize(id) {
    return String(id).replace(/#\d+$/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
}

function plain(s) {
    return String(s).replace(/<[^>]*>/g, '');
}

function entityName(kind, id) {
    const k = KIND[kind];
    const s = k ? t(k.key(id)) : null;
    return s ? plain(s) : humanize(id);
}

function hasName(kind, id) {
    return !!t(KIND[kind].key(id));
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Unity rich text -> safe HTML (only b, i, color survive)
function richText(s) {
    if (!s) return '';
    let html = escapeHtml(s);
    html = html.replace(/&lt;(\/?)(b|i)&gt;/g, '<$1$2>');
    html = html.replace(/&lt;color=(#[0-9a-fA-F]{3,8}|[a-z]+)&gt;/g, '<span style="color:$1">');
    html = html.replace(/&lt;\/color&gt;/g, '</span>');
    html = html.replace(/&lt;\/?(size|u|s|sprite|link)[^&]*&gt;/g, '');
    return html.replace(/\\n|\n/g, '<br>');
}

function fmtNum(v, digits = 2) {
    if (v == null || v === '') return '';
    if (typeof v !== 'number') return String(v);
    return v.toLocaleString(store.lang.replace('_', '-'), { maximumFractionDigits: digits });
}

function fmtPct(p) {
    if (p == null) return '';
    const v = p * 100;
    if (v >= 99.995) return '100%';
    const digits = v >= 10 ? 0 : v >= 1 ? 1 : v >= 0.1 ? 2 : 3;
    return `${fmtNum(+v.toFixed(digits), digits)}%`;
}

function fmtRange(min, max) {
    if (min == null && max == null) return '';
    if (max == null || max === min) return fmtNum(min ?? max);
    return `${fmtNum(min)}–${fmtNum(max)}`;
}

function fmtTime(sec) {
    if (!sec) return '';
    if (sec < 60) return `${fmtNum(sec, 1)}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60 ? ` ${Math.round(sec % 60)}s` : ''}`;
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return `${h}h${m ? ` ${m}m` : ''}`;
}

function fmtBonus(name, value) {
    const info = store.data.bonuses?.[name] || {};
    if (info.hide) return '';
    let s = info.pct ? `${fmtNum(value * 100, 1)}%` : fmtNum(value, info.int ? 0 : 2);
    if (value > 0 && (info.sign || info.pct)) s = `+${s}`;
    return s;
}

function iconOf(kind, id) {
    const d = store.data;
    switch (kind) {
        case 'item': return d.items[id]?.icon;
        case 'mob': return d.mobs[id]?.icon || d.items[d.mobs[id]?.pet]?.icon;
        case 'npc': return d.npcs[id]?.icon;
        case 'object': return d.objects[id]?.icon;
        case 'effect': return d.effects[id]?.icon;
        default: return null;
    }
}

function categoryLabel(cat) {
    return t(`UI.AuctionCategory.${cat}`) || humanize(cat);
}

function routeTo(kind, id) {
    return `/${KIND[kind].route}/${encodeURIComponent(id)}`;
}

/* ---------------------------------------------------------------- search */

const searchIndex = computed(() => {
    if (!store.ready) return [];
    const out = [];
    const add = (kind, id, extra = '') => {
        const name = entityName(kind, id);
        out.push({ kind, id, name, hay: `${name} ${id} ${extra}`.toLowerCase() });
    };
    const d = store.data;
    for (const id in d.items) add('item', id);
    for (const id in d.mobs) add('mob', id);
    for (const id in d.npcs) add('npc', id, plain(t(`Entity.${id}.Title`) || ''));
    for (const id in d.objects) if (hasName('object', id)) add('object', id);
    for (const id in d.quests) if (hasName('quest', id)) add('quest', id);
    for (const id in d.skills) add('skill', id);
    for (const id in d.areas) if (hasName('area', id)) add('area', id);
    return out;
});

function search(query, limit = 40) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const e of searchIndex.value) {
        const i = e.hay.indexOf(q);
        if (i < 0) continue;
        const nameLower = e.name.toLowerCase();
        const score = (nameLower === q ? 0 : nameLower.startsWith(q) ? 1 : i === 0 ? 2 : 3) * 1000 + e.name.length;
        scored.push([score, e]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    return scored.slice(0, limit).map(x => x[1]);
}

/* ---------------------------------------------------------------- shared components */

const helpers = {
    methods: {
        t, entityName, richText, fmtNum, fmtPct, fmtRange, fmtTime, fmtBonus, humanize, categoryLabel, routeTo,
        diff: v => DIFFICULTY[v] ? (t(`UI.DungeonLevel.Difficulty.${DIFFICULTY[v]}`) || DIFFICULTY[v]) : v,
    },
    computed: {
        D() { return store.data; },
        store() { return store; },
    },
};

const ELink = {
    mixins: [helpers],
    props: { t: String, id: String, amount: [Number, String], noIcon: Boolean },
    computed: {
        kind() { return KIND[this.t]; },
        exists() { return !!(this.kind?.route && store.data[this.kind.coll]?.[this.id]); },
        label() { return this.kind ? entityName(this.t, this.id) : humanize(this.id); },
        icon() { return iconOf(this.t, this.id); },
        rarity() { return this.t === 'item' ? `r-${store.data.items[this.id]?.rarity}` : ''; },
    },
    template: `
      <router-link v-if="exists" :to="routeTo(t, id)" class="elink" :class="rarity" :title="label">
        <img v-if="!noIcon && icon" class="ic" :src="'icons/' + icon + '.webp'" loading="lazy" alt="">
        <span v-else-if="!noIcon && t === 'item'" class="ic ic-empty"></span>
        <span class="nm">{{ label }}</span><span v-if="amount != null && amount !== ''" class="amt">×{{ amount }}</span>
      </router-link>
      <span v-else class="elink" :title="id">
        <img v-if="!noIcon && icon" class="ic" :src="'icons/' + icon + '.webp'" loading="lazy" alt="">
        <span class="nm">{{ label }}</span><span v-if="amount != null && amount !== ''" class="amt">×{{ amount }}</span>
      </span>`,
};

const BonusList = {
    mixins: [helpers],
    props: { bonuses: Array },
    template: `
      <ul class="plain" style="list-style:none;padding:0;margin:0">
        <li v-for="[name, value] in bonuses" :key="name">
          <router-link :to="routeTo('bonus', name)">{{ entityName('bonus', name) }}</router-link>
          <b v-if="fmtBonus(name, value)" style="margin-left:.4em">{{ fmtBonus(name, value) }}</b>
        </li>
      </ul>`,
};

const EffectList = {
    mixins: [helpers],
    props: { effects: Array },
    template: `
      <span>
        <span v-for="(e, i) in effects" :key="i" class="nowrap">
          <e-link t="effect" :id="e.effect" />
          <span class="muted small" v-if="e.chance || e.time">
            ({{ [e.chance && e.chance < 1 ? fmtPct(e.chance) : '', fmtTime(e.time)].filter(Boolean).join(', ') }})</span><span v-if="i < effects.length - 1">, </span>
        </span>
      </span>`,
};

const RecipeCard = {
    mixins: [helpers],
    props: { id: String, highlight: String },
    computed: {
        r() { return store.data.recipes[this.id]; },
        typeLabel() {
            return { craft: 'Crafting', build: 'Building', produce: 'Production', feed: 'Animal feeding', pairing: 'Breeding' }[this.r.type];
        },
    },
    template: `
      <div class="recipe" v-if="r">
        <div class="out">
          <template v-for="(o, i) in r.out" :key="i">
            <e-link v-if="o.item" t="item" :id="o.item" :amount="o.amount > 1 ? o.amount : null" />
            <e-link v-else :t="o.t" :id="o.id" />
            <span v-if="i < r.out.length - 1">, </span>
          </template>
        </div>
        <ul>
          <li v-for="m in r.in" :key="m.item">
            <e-link t="item" :id="m.item" :amount="m.amount" />
            <span v-if="m.kept" class="tag">not consumed</span>
          </li>
        </ul>
        <div class="meta">
          <span>{{ typeLabel }}</span>
          <span v-if="r.skill"><router-link :to="routeTo('skill', r.skill)">{{ entityName('skill', r.skill) }}</router-link> {{ r.level || 0 }}</span>
          <span v-if="r.tool">Tool: <router-link :to="routeTo('bonus', r.tool)">{{ entityName('bonus', r.tool) }}</router-link></span>
          <span v-for="s in r.stations || []" :key="s">At: <router-link :to="routeTo('bonus', s)">{{ entityName('bonus', s) }}</router-link></span>
          <span v-for="s in r.at || []" :key="s">At: <e-link t="object" :id="s" no-icon /></span>
          <span v-if="r.time">{{ fmtTime(r.time) }}</span>
          <span v-if="r.event" class="tag event">{{ r.event }}</span>
          <span v-if="r.secret" class="tag">secret</span>
          <span v-if="r.randomBonus" class="tag">random bonuses</span>
        </div>
      </div>`,
};

const LootTable = {
    mixins: [helpers],
    props: { id: String, showOwners: Boolean },
    data() { return { expanded: {} }; },
    methods: {
        // chance of this particular row: entry chance × its weight in the random pick
        share(e, x) { return e.chance * (x.w || 1) / (e.n || 1); },
        rows(e, i) {
            const sorted = e.items.length > 1 ? [...e.items].sort((a, b) => (b.w || 1) - (a.w || 1)) : e.items;
            return this.expanded[i] ? sorted : sorted.slice(0, 25);
        },
    },
    computed: {
        table() { return store.data.loot[this.id]; },
        owners() { return idx.tableOwners[this.id] || []; },
    },
    template: `
      <div v-if="table">
        <p v-if="showOwners && owners.length" class="small muted">From:
          <template v-for="(o, i) in owners" :key="i"><e-link :t="o.t" :id="o.id" no-icon /><span v-if="i < owners.length - 1">, </span></template>
        </p>
        <div v-if="table.money" class="loot-entry">
          <span class="chance">{{ fmtPct(table.money.chance) }}</span>
          <div><span class="coin">{{ fmtRange(table.money.min, table.money.max) }}</span></div>
        </div>
        <div v-for="(e, i) in table.entries" :key="i" class="loot-entry">
          <span class="chance">{{ fmtPct(e.chance) }}</span>
          <div>
            <div v-if="e.items.length > 1 || e.minDifficulty != null || e.maxDifficulty != null || e.event" class="small">
              <span v-if="e.items.length > 1" class="muted">one of {{ e.items.length }} items </span>
              <span v-if="e.minDifficulty != null || e.maxDifficulty != null" class="tag">
                {{ e.minDifficulty != null ? diff(e.minDifficulty) + '+' : '' }}{{ e.maxDifficulty != null ? ' ≤ ' + diff(e.maxDifficulty) : '' }}</span>
              <span v-if="e.event" class="tag event">{{ e.event }}</span>
            </div>
            <ul>
              <li v-for="(x, j) in rows(e, i)" :key="j">
                <e-link t="item" :id="x.item" :amount="fmtRange(x.min, x.max)" />
                <span v-if="x.qmin != null" class="muted small"> quality {{ fmtRange(x.qmin, x.qmax) }}</span>
                <span v-if="e.items.length > 1" class="muted small"> · {{ fmtPct(share(e, x)) }}</span>
              </li>
            </ul>
            <button v-if="e.items.length > 25 && !expanded[i]" class="small" @click="expanded[i] = true">Show all {{ e.items.length }}</button>
          </div>
        </div>
      </div>`,
};

const GatherTable = {
    mixins: [helpers],
    props: { id: String },
    computed: { g() { return store.data.gathers[this.id]; } },
    template: `
      <div v-if="g">
        <p class="small muted">
          <span v-if="g.skill"><router-link :to="routeTo('skill', g.skill)">{{ entityName('skill', g.skill) }}</router-link> {{ g.level || 0 }}</span>
          <span v-if="g.tool"> · Tool: <router-link :to="routeTo('bonus', g.tool)">{{ entityName('bonus', g.tool) }}</router-link></span>
          <span v-if="g.needs"> · Needs: <template v-for="n in g.needs" :key="n.item"><e-link t="item" :id="n.item" :amount="n.amount" /> </template></span>
        </p>
        <table>
          <tbody>
            <tr v-for="(x, i) in g.items" :key="i">
              <td><e-link t="item" :id="x.item" /></td>
              <td class="num">{{ fmtRange(x.min, x.max) }}</td>
              <td class="num">{{ fmtPct(x.chance) }}</td>
            </tr>
          </tbody>
        </table>
      </div>`,
};

const DataTable = {
    mixins: [helpers],
    props: { rows: Array, columns: Array, pageSize: { type: Number, default: 150 }, defaultSort: String },
    data() {
        const col = this.columns.find(c => c.key === this.defaultSort);
        return { sortKey: this.defaultSort || null, desc: !!col?.desc, shown: this.pageSize };
    },
    watch: { rows() { this.shown = this.pageSize; } },
    computed: {
        sorted() {
            if (!this.sortKey) return this.rows;
            const col = this.columns.find(c => c.key === this.sortKey);
            const val = col?.sort || (r => r[this.sortKey]);
            const dir = this.desc ? -1 : 1;
            return [...this.rows].sort((a, b) => {
                const x = val(a), y = val(b);
                if (x == null && y == null) return 0;
                if (x == null) return 1;
                if (y == null) return -1;
                return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
            });
        },
        visible() { return this.sorted.slice(0, this.shown); },
    },
    methods: {
        sortBy(col) {
            if (!col.sort && col.sortable === false) return;
            if (this.sortKey === col.key) this.desc = !this.desc;
            else { this.sortKey = col.key; this.desc = !!col.desc; }
        },
    },
    template: `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th v-for="c in columns" :key="c.key" :class="[c.cls, { sortable: c.sortable !== false, sorted: sortKey === c.key }]" @click="sortBy(c)">
              {{ c.label }}<span v-if="sortKey === c.key">{{ desc ? ' ▾' : ' ▴' }}</span>
            </th>
          </tr></thead>
          <tbody>
            <tr v-for="row in visible" :key="row.id">
              <td v-for="c in columns" :key="c.key" :class="c.cls">
                <slot :name="c.key" :row="row">{{ row[c.key] }}</slot>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!rows.length" class="more muted">Nothing matches.</div>
        <div v-if="shown < rows.length" class="more">
          <button @click="shown += pageSize * 2">Show more ({{ rows.length - shown }} left)</button>
        </div>
      </div>`,
};

const SearchBox = {
    mixins: [helpers],
    props: { autofocus: Boolean },
    data() { return { q: '', open: false, active: 0 }; },
    computed: { results() { return search(this.q, 30); } },
    watch: { q() { this.active = 0; this.open = true; } },
    mounted() { if (this.autofocus) this.$refs.input.focus(); },
    methods: {
        label: kind => KIND[kind].label,
        go(e) {
            if (!e) return;
            window.posthog?.capture('search_select', { query: this.q.trim(), kind: e.kind, id: e.id });
            this.$router.push(routeTo(e.kind, e.id));
            this.q = '';
            this.open = false;
            this.$refs.input.blur();
        },
        key(ev) {
            if (ev.key === 'ArrowDown') { this.active = Math.min(this.active + 1, this.results.length - 1); ev.preventDefault(); }
            else if (ev.key === 'ArrowUp') { this.active = Math.max(this.active - 1, 0); ev.preventDefault(); }
            else if (ev.key === 'Enter') this.go(this.results[this.active]);
            else if (ev.key === 'Escape') { this.open = false; this.$refs.input.blur(); }
        },
    },
    template: `
      <div class="search">
        <input ref="input" type="search" v-model="q" placeholder="Search items, mobs, NPCs, quests…"
               @keydown="key" @focus="open = true" @blur="setTimeout(() => open = false, 150)" aria-label="Search">
        <div v-if="open && q.trim()" class="results">
          <a v-for="(e, i) in results" :key="e.kind + e.id" :class="{ active: i === active }"
             :href="'#' + routeTo(e.kind, e.id)" @mousedown.prevent="go(e)">
            <e-link :t="e.kind" :id="e.id" /><span class="kind">{{ label(e.kind) }}</span>
          </a>
          <div v-if="!results.length" class="empty">No matches.</div>
        </div>
      </div>`,
};
SearchBox.methods.setTimeout = (fn, ms) => window.setTimeout(fn, ms);

/* ---------------------------------------------------------------- list-page helpers */

// Filters live in the URL query, so every filtered view is a shareable link.
const queryState = {
    computed: { query() { return this.$route.query; } },
    methods: {
        setQuery(key, value) {
            const query = { ...this.$route.query };
            if (value === '' || value == null || value === false) delete query[key];
            else query[key] = value;
            this.$router.replace({ query });
        },
    },
};

function matches(q, ...texts) {
    if (!q) return true;
    const needle = q.toLowerCase();
    return texts.some(s => s && String(s).toLowerCase().includes(needle));
}

/* ---------------------------------------------------------------- pages */

const Home = {
    mixins: [helpers],
    computed: {
        tiles() {
            const c = store.meta.counts;
            return [
                ['/items', 'Items', c.items], ['/recipes', 'Recipes', c.recipes], ['/mobs', 'Mobs', c.mobs],
                ['/npcs', 'NPCs', c.npcs], ['/objects', 'World objects', Object.keys(store.data.objects).filter(id => hasName('object', id)).length],
                ['/quests', 'Quests', c.quests], ['/skills', 'Skills', c.skills], ['/areas', 'Areas', c.areas],
            ];
        },
        extracted() { return new Date(store.meta.extracted * 1000).toLocaleDateString(); },
    },
    template: `
      <div>
        <div class="card hero">
          <h1>Wild Terra 2 Wiki</h1>
          <p class="muted">Items, recipes, drops, mobs, NPCs and quests, pulled straight from the game files.</p>
          <search-box autofocus />
        </div>
        <div class="tiles">
          <router-link v-for="[to, label, n] in tiles" :key="to" :to="to" class="tile"><b>{{ fmtNum(n) }}</b>{{ label }}</router-link>
        </div>
        <p class="muted small" style="margin-top:20px">
          Game build {{ store.meta.build || '?' }} · extracted {{ extracted }}
          <span v-if="store.changes"> · <router-link to="/changes">what changed in the last update</router-link></span>
        </p>
      </div>`,
};

const ItemList = {
    mixins: [helpers, queryState],
    computed: {
        all() {
            return Object.entries(store.data.items).map(([id, it]) => ({ id, ...it, name: entityName('item', id) }));
        },
        tree() {
            // category1 -> category2 -> count
            const tree = {};
            for (const it of this.all) {
                const c1 = (it.cat || ['Uncategorized'])[0];
                tree[c1] ||= {};
                for (const c of it.cats || it.cat || []) {
                    if (c.startsWith(c1) && this.catLevels[c] === 2) tree[c1][c] = (tree[c1][c] || 0) + 1;
                }
            }
            return tree;
        },
        rows() {
            const { q, cat, sub, leaf, rarity, kind } = this.query;
            return this.all.filter(it =>
                (!cat || (it.cat || ['Uncategorized'])[0] === cat) &&
                (!sub || (it.cats || it.cat || []).includes(sub)) &&
                (!leaf || (it.cats || it.cat || []).includes(leaf)) &&
                (!rarity || it.rarity === rarity) &&
                (!kind || it.kind === kind) &&
                matches(q, it.name, it.id));
        },
        subcats() {
            return this.query.cat ? Object.keys(this.tree[this.query.cat] || {}) : [];
        },
        leaves() {
            const sub = this.query.sub;
            if (!sub) return [];
            const out = new Set();
            for (const it of this.all) for (const c of it.cats || it.cat || []) if (c.startsWith(sub) && this.catLevels[c] === 3) out.add(c);
            return [...out];
        },
        kinds() { return [...new Set(this.all.map(i => i.kind))].sort(); },
        catLevels() {
            // Category names nest by prefix: Equipments > EquipmentsTools > EquipmentsToolsPickaxes
            const names = new Set(this.all.flatMap(it => it.cats || it.cat || []));
            const level = c => 1 + [...names].filter(p => p !== c && c.startsWith(p)).length;
            return Object.fromEntries([...names].map(c => [c, level(c)]));
        },
        columns() {
            return [
                { key: 'name', label: 'Name', sort: r => r.name },
                { key: 'cat', label: 'Category', sort: r => (r.cat || []).at(-1) || '' },
                { key: 'rarity', label: 'Rarity', sort: r => RARITY_ORDER.indexOf(r.rarity) },
                { key: 'level', label: 'Req.', cls: 'num', sort: r => r.req?.level },
                { key: 'stats', label: 'Stats', sortable: false },
                { key: 'price', label: 'NPC buys', cls: 'num', sort: r => r.buyUp, desc: true },
            ];
        },
    },
    methods: {
        rarities: () => RARITY_ORDER,
        isLeaf(c) { return this.catLevels[c] === 3; },
        pick(cats) {
            this.$router.replace({ query: { ...this.query, cat: undefined, sub: undefined, leaf: undefined, ...cats } });
        },
        statLine(it) {
            if (it.attack) return `${fmtRange(it.attack.minDamage, it.attack.maxDamage)} dmg`;
            if (it.use?.foods?.length) return it.use.foods.map(f => `${f.value} ${t(`FoodType.${f.type}`) || f.type}`).join(', ');
            if (it.bonuses?.length) return it.bonuses.slice(0, 2).map(([n, v]) => `${entityName('bonus', n)} ${fmtBonus(n, v)}`).join(', ');
            return '';
        },
    },
    template: `
      <div>
        <h1>Items</h1>
        <div class="filters">
          <input type="search" :value="query.q" @input="setQuery('q', $event.target.value)" placeholder="Filter by name…">
          <select :value="query.rarity || ''" @change="setQuery('rarity', $event.target.value)">
            <option value="">Any rarity</option>
            <option v-for="r in rarities()" :key="r" :value="r">{{ r }}</option>
          </select>
          <select :value="query.kind || ''" @change="setQuery('kind', $event.target.value)">
            <option value="">Any type</option>
            <option v-for="k in kinds" :key="k" :value="k">{{ humanize(k) }}</option>
          </select>
          <span class="count">{{ rows.length }} items</span>
        </div>
        <div class="chips">
          <span class="chip" :class="{ on: !query.cat }" @click="pick({ cat: undefined })">All</span>
          <span v-for="(subs, c) in tree" :key="c" class="chip" :class="{ on: query.cat === c }" @click="pick({ cat: c })">{{ categoryLabel(c) }}</span>
        </div>
        <div class="chips" v-if="subcats.length">
          <span v-for="c in subcats" :key="c" class="chip" :class="{ on: query.sub === c }"
                @click="pick({ cat: query.cat, sub: query.sub === c ? undefined : c })">{{ categoryLabel(c) }}</span>
        </div>
        <div class="chips" v-if="leaves.length">
          <span v-for="c in leaves" :key="c" class="chip" :class="{ on: query.leaf === c }"
                @click="pick({ cat: query.cat, sub: query.sub, leaf: query.leaf === c ? undefined : c })">{{ categoryLabel(c) }}</span>
        </div>
        <div class="card">
          <data-table :rows="rows" :columns="columns" default-sort="name">
            <template #name="{ row }"><e-link t="item" :id="row.id" /></template>
            <template #cat="{ row }"><span class="muted">{{ row.cat ? categoryLabel(row.cat.at(-1)) : humanize(row.kind) }}</span></template>
            <template #rarity="{ row }"><span :class="'r-' + row.rarity">{{ row.rarity }}</span></template>
            <template #level="{ row }">{{ row.req?.level }}</template>
            <template #stats="{ row }"><span class="small">{{ statLine(row) }}</span></template>
            <template #price="{ row }"><span v-if="row.buyUp" class="coin nowrap" title="Base price NPCs pay">{{ fmtNum(row.buyUp) }}</span></template>
          </data-table>
        </div>
      </div>`,
};

const ItemPage = {
    mixins: [helpers],
    props: { id: String },
    computed: {
        it() { return store.data.items[this.id]; },
        name() { return entityName('item', this.id); },
        desc() { return t(`Item.${this.id}.Description`); },
        src() { return this.it.src || {}; },
        use() { return this.it.use || {}; },
        drops() {
            // one row per (table owner) with the table's chance for this item
            const rows = [];
            for (const s of this.src.loot || []) {
                const owners = idx.tableOwners[s.table] || [];
                for (const o of owners.length ? owners : [{ t: null, id: s.table }]) rows.push({ ...s, owner: o });
            }
            return rows.sort((a, b) => b.chance - a.chance);
        },
        gathers() {
            return (this.src.gather || []).map(s => ({ ...s, g: store.data.gathers[s.gather] }));
        },
        fishing() {
            return (this.src.fishing || []).map(f => ({ id: f, ...store.data.fishing.fish[f] }));
        },
        craftRecipes() { return (this.src.recipe || []); },
        useRecipes() { return (this.use.recipe || []); },
        stats() {
            const it = this.it, rows = [];
            if (it.slot) rows.push(['Slot', humanize(it.slot)]);
            if (it.weaponSkill) rows.push(['Weapon skill', entityName('skill', it.weaponSkill)]);
            if (it.req?.level) rows.push([t('UI.ItemToolTip.SkillRequired') || 'Skill required', `${it.req.skill ? entityName('skill', it.req.skill) + ' ' : ''}${it.req.level}`]);
            if (it.durability) rows.push([t('UI.ItemToolTip.DurabilityText') || 'Durability', fmtNum(it.durability)]);
            if (it.stack) rows.push(['Stack', it.stack]);
            if (it.seedLevel) rows.push([t('UI.ItemToolTip.SeedSkill') || 'Seed skill', it.seedLevel]);
            if (it.fishWeight) rows.push(['Base weight', `${fmtNum(it.fishWeight)} kg`]);
            if (it.use?.time) rows.push(['Use time', fmtTime(it.use.time)]);
            if (it.use?.alcohol) rows.push([t('FoodType.AlcoholValue') || 'Alcohol', fmtNum(it.use.alcohol)]);
            if (it.use?.petXp) rows.push([t('UI.ItemToolTip.AddPetXp') || 'Pet experience', fmtNum(it.use.petXp)]);
            if (it.book?.xpBonus) rows.push(['XP bonus', fmtPct(it.book.xpBonus)]);
            if (it.book?.time) rows.push(['Duration', fmtTime(it.book.time)]);
            if (it.xp) rows.push(['Craft XP', it.xp]);
            if (it.buyUp) rows.push(['NPC buys for', fmtNum(it.buyUp)]);
            if (it.repair) rows.push(['Repair price', fmtNum(it.repair)]);
            return rows;
        },
        attackRows() {
            const a = this.it.attack;
            if (!a) return [];
            const rows = [[t('UI.ItemToolTip.DamageText') || 'Damage', fmtRange(a.minDamage, a.maxDamage)]];
            if (a.maxPlagueDamage) rows.push([t('UI.ItemToolTip.PlagueDamageText') || 'Plague damage', fmtRange(a.minPlagueDamage, a.maxPlagueDamage)]);
            if (a.criticalChance) rows.push([t('UI.ItemToolTip.CriticalChanceText') || 'Critical chance', fmtPct(a.criticalChance)]);
            if (a.criticalValue) rows.push([t('UI.ItemToolTip.CriticalValueText') || 'Critical value', `×${fmtNum(a.criticalValue)}`]);
            if (a.ignoreDefense) rows.push(['Ignores defense', fmtPct(a.ignoreDefense)]);
            if (a.ignoreAbsorb) rows.push(['Ignores absorption', fmtPct(a.ignoreAbsorb)]);
            if (a.ignoreBlock) rows.push(['Ignores block', fmtPct(a.ignoreBlock)]);
            if (a.ignoreDodge) rows.push(['Ignores dodge', fmtPct(a.ignoreDodge)]);
            if (a.dismountChance) rows.push([t('UI.ItemToolTip.DismountChance') || 'Dismount chance', fmtPct(a.dismountChance)]);
            if (a.isAOE) rows.push(['Area of effect', a.projectileAOERange ? `${fmtNum(a.projectileAOERange)} m` : 'yes']);
            if (a.entityMaxLevel) rows.push(['Max target level', a.entityMaxLevel]);
            return rows;
        },
        hasSources() { return Object.keys(this.src).length > 0; },
        hasUses() { return Object.keys(this.use).length > 0; },
    },
    template: `
      <div v-if="!it" class="card">Unknown item <code>{{ id }}</code>. <router-link to="/items">All items</router-link></div>
      <div v-else>
        <div class="head">
          <img v-if="it.icon" class="ic ic-lg" :src="'icons/' + it.icon + '.webp'" alt="">
          <div>
            <div class="crumbs" v-if="it.cat">
              <template v-for="(c, i) in it.cat" :key="c">
                <router-link :to="{ path: '/items', query: [{ cat: c }, { cat: it.cat[0], sub: c }, { cat: it.cat[0], sub: it.cat[1], leaf: c }][i] }">{{ categoryLabel(c) }}</router-link>
                <span v-if="i < it.cat.length - 1"> › </span>
              </template>
            </div>
            <h1 :class="'r-' + it.rarity">{{ name }}</h1>
            <div class="sub">
              <span class="tag">{{ it.rarity }}</span>
              <span class="tag">{{ humanize(it.kind) }}</span>
              <span v-if="it.quality" class="tag">has quality</span>
              <span v-for="f in it.flags || []" :key="f" class="tag" :class="{ warn: f === 'noTrade' }">{{ humanize(f) }}</span>
            </div>
            <div v-if="desc" class="desc rich" v-html="richText(desc)"></div>
          </div>
        </div>

        <div class="grid-2">
          <section class="card" v-if="stats.length || attackRows.length">
            <h2>Stats</h2>
            <dl class="kv">
              <template v-for="[k, v] in attackRows.concat(stats)" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
              <template v-if="it.ammo"><dt>{{ t('UI.ItemToolTip.RequiredAmmoText') || 'Ammo' }}</dt><dd><e-link t="item" :id="it.ammo" /></dd></template>
            </dl>
            <p v-if="it.attack?.effects"><span class="muted">On hit:</span> <effect-list :effects="it.attack.effects" /></p>
          </section>
          <section class="card" v-if="it.bonuses">
            <h2>Bonuses</h2>
            <bonus-list :bonuses="it.bonuses" />
          </section>
          <section class="card" v-if="it.use && (it.use.foods || it.use.effects || it.use.removes)">
            <h2>When used</h2>
            <dl class="kv">
              <template v-for="f in it.use.foods || []" :key="f.type"><dt>{{ t('FoodType.' + f.type) || f.type }}</dt><dd>{{ fmtNum(f.value) }}</dd></template>
            </dl>
            <p v-if="it.use.effects"><span class="muted">Effects:</span> <effect-list :effects="it.use.effects" /></p>
            <p v-if="it.use.removes"><span class="muted">Removes:</span>
              <template v-for="e in it.use.removes"><e-link t="effect" :id="e" /> </template></p>
          </section>
          <section class="card" v-if="it.ammoStats">
            <h2>As ammo</h2>
            <dl class="kv">
              <template v-if="it.ammoStats.damage"><dt>{{ t('UI.ItemToolTip.AddAmmoDamageText') || 'Additional damage' }}</dt><dd>+{{ it.ammoStats.damage }}</dd></template>
              <template v-if="it.ammoStats.ignoreDefense"><dt>{{ t('UI.ItemToolTip.AddAmmoIgnoreDefenseText') || 'Ignores defense' }}</dt><dd>{{ fmtPct(it.ammoStats.ignoreDefense) }}</dd></template>
              <template v-if="it.ammoStats.maxLevel"><dt>Max target level</dt><dd>{{ it.ammoStats.maxLevel }}</dd></template>
            </dl>
            <p v-if="it.ammoStats.effects"><span class="muted">On hit:</span> <effect-list :effects="it.ammoStats.effects" /></p>
          </section>
          <section class="card" v-if="it.enchant">
            <h2>Enchantment</h2>
            <div v-for="(e, i) in it.enchant" :key="i">
              <dl class="kv">
                <template v-if="e.level"><dt>{{ t('UI.ItemToolTip.WitchcraftLevel') || 'Witchcraft level' }}</dt><dd>{{ e.level }}</dd></template>
                <template v-if="e.charges"><dt>Charges</dt><dd>{{ e.charges }}</dd></template>
                <template v-if="e.vs"><dt>{{ t('UI.ItemToolTip.EnchantmentEntityClass') || 'Affects' }}</dt><dd>{{ t('UI.ItemToolTip.EntityClass.' + e.vs) || e.vs }}</dd></template>
                <template v-for="(v, k) in e.values || {}" :key="k"><dt>{{ humanize(k) }}</dt><dd>{{ v < 1 ? fmtPct(v) : '+' + v }}</dd></template>
              </dl>
              <p v-if="e.effect"><span class="muted">Effect:</span> <effect-list :effects="[e.effect]" /></p>
            </div>
          </section>
          <section class="card" v-if="it.pet">
            <h2>Pet</h2>
            <dl class="kv">
              <template v-if="it.pet.tameLevel"><dt>Taming level</dt><dd>{{ it.pet.tameLevel }}</dd></template>
              <template v-if="it.pet.feed"><dt>Food</dt><dd><e-link t="item" :id="it.pet.feed" /></dd></template>
              <template v-if="it.pet.levels?.maxLevel"><dt>Max level</dt><dd>{{ it.pet.levels.maxLevel }}</dd></template>
              <template v-for="s in ['health', 'minDamage', 'maxDamage']" :key="s">
                <template v-if="it.pet.levels?.[s]"><dt>{{ humanize(s) }}</dt><dd>{{ it.pet.levels[s].baseValue }} → {{ it.pet.levels[s].maxLevelValue }}</dd></template>
              </template>
              <template v-if="it.mountEffect"><dt>Mount effect</dt><dd><e-link t="effect" :id="it.mountEffect" /></dd></template>
            </dl>
            <details v-if="it.pet.levels?.perks" style="margin-top:8px">
              <summary>Perks by level</summary>
              <dl class="kv" style="margin-top:8px">
                <template v-for="p in it.pet.levels.perks" :key="p.level"><dt>{{ p.level }}</dt><dd><bonus-list :bonuses="(p.bonuses || []).map(b => [b.name, b.value])" /></dd></template>
              </dl>
            </details>
          </section>
          <section class="card" v-if="it.group">
            <h2>Any of</h2>
            <div class="mats"><e-link v-for="m in it.group" :key="m" t="item" :id="m" /></div>
          </section>
        </div>

        <section class="card" v-if="craftRecipes.length" style="margin-top:16px">
          <h2>Crafted by</h2>
          <div class="recipes"><recipe-card v-for="r in craftRecipes" :key="r" :id="r" /></div>
        </section>

        <section class="card" v-if="drops.length">
          <h2>Dropped by</h2>
          <data-table :rows="drops.map((d, i) => ({ id: i, ...d }))" :columns="[
              { key: 'owner', label: 'Source', sort: r => entityName(r.owner.t || 'item', r.owner.id) },
              { key: 'amount', label: 'Amount', cls: 'num', sortable: false },
              { key: 'chance', label: 'Chance', cls: 'num', sort: r => r.chance, desc: true }]" default-sort="chance">
            <template #owner="{ row }"><e-link v-if="row.owner.t" :t="row.owner.t" :id="row.owner.id" /><span v-else class="muted">{{ humanize(row.owner.id) }}</span></template>
            <template #amount="{ row }">{{ fmtRange(row.min, row.max) }}</template>
            <template #chance="{ row }">{{ fmtPct(row.chance) }}</template>
          </data-table>
        </section>

        <section class="card" v-if="gathers.length">
          <h2>Gathered from</h2>
          <table>
            <thead><tr><th>Source</th><th>Skill</th><th>Tool</th><th class="num">Amount</th><th class="num">Chance</th></tr></thead>
            <tbody>
              <tr v-for="s in gathers" :key="s.gather">
                <td>
                  <template v-for="(f, i) in s.g.from" :key="i"><e-link :t="f.t" :id="f.id" /><span v-if="f.via" class="muted small"> ({{ f.via === 'butcher' ? 'butchering' : f.via }})</span><br v-if="i < s.g.from.length - 1"></template>
                  <span v-if="!s.g.from.length" class="muted">{{ humanize(s.gather) }}</span>
                </td>
                <td><span v-if="s.g.skill">{{ entityName('skill', s.g.skill) }} {{ s.g.level || 0 }}</span></td>
                <td><router-link v-if="s.g.tool" :to="routeTo('bonus', s.g.tool)">{{ entityName('bonus', s.g.tool) }}</router-link></td>
                <td class="num">{{ fmtRange(s.min, s.max) }}</td>
                <td class="num">{{ fmtPct(s.chance) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div class="grid-2" style="margin-bottom:16px">
          <section class="card" v-if="src.shop">
            <h2>Sold by</h2>
            <table><tbody>
              <tr v-for="(s, i) in src.shop" :key="i">
                <td><e-link t="npc" :id="s.npc" /></td>
                <td><span v-if="s.book" class="tag">{{ entityName('skill', s.book) }}</span></td>
                <td class="num"><e-link v-if="s.currency" t="item" :id="s.currency" :amount="s.price" /><span v-else class="coin">{{ fmtNum(s.price) }}</span></td>
              </tr>
            </tbody></table>
          </section>
          <section class="card" v-if="src.quest">
            <h2>Quest reward</h2>
            <div v-for="q in src.quest" :key="q"><e-link t="quest" :id="q" /></div>
          </section>
          <section class="card" v-if="src.catch">
            <h2>Caught from</h2>
            <div v-for="m in src.catch" :key="m"><e-link t="mob" :id="m" /></div>
          </section>
          <section class="card" v-if="src.oath">
            <h2>Oath-bound variant of</h2>
            <div v-for="m in src.oath" :key="m"><e-link t="item" :id="m" /></div>
          </section>
          <section class="card" v-if="fishing.length">
            <h2>Fishing</h2>
            <div v-for="f in fishing" :key="f.id">
              <dl class="kv">
                <dt>Fishing level</dt><dd>{{ f.level || 0 }}</dd>
                <template v-if="f.baits"><dt>Baits</dt><dd><div class="mats"><e-link v-for="b in f.baits" :key="b" t="item" :id="b" /></div></dd></template>
                <template v-if="f.areas"><dt>Waters</dt><dd><div v-for="(w, a) in f.areas" :key="a">{{ humanize(a) }} <span class="muted">{{ fmtPct(w) }}</span></div></dd></template>
              </dl>
            </div>
          </section>
          <section class="card" v-if="use.buyer">
            <h2>Bought at a premium by</h2>
            <div v-for="n in use.buyer" :key="n"><e-link t="npc" :id="n" /> <span class="muted small">×{{ fmtNum(D.npcs[n]?.buys?.special) }}</span></div>
          </section>
          <section class="card" v-if="use.quest">
            <h2>Needed for quests</h2>
            <div v-for="q in use.quest" :key="q"><e-link t="quest" :id="q" /></div>
          </section>
          <section class="card" v-if="use.bait">
            <h2>Bait for</h2>
            <div class="mats"><template v-for="f in use.bait" :key="f"><e-link v-for="i in D.fishing.fish[f]?.items || []" :key="i" t="item" :id="i" /></template></div>
          </section>
          <section class="card" v-if="use.plant">
            <h2>Grows into</h2>
            <div v-for="o in use.plant" :key="o"><e-link t="object" :id="o" /></div>
          </section>
          <section class="card" v-if="use.group || use.ammoFor">
            <h2>Counts as</h2>
            <div v-for="g in use.group || []" :key="g"><e-link t="item" :id="g" /></div>
            <p v-if="use.ammoFor" class="small"><span class="muted">Ammo for:</span>
              <template v-for="w in use.ammoFor"><e-link t="item" :id="w" /> </template></p>
          </section>
          <section class="card" v-if="it.butcher || it.essence">
            <h2>Butchering</h2>
            <gather-table v-if="it.butcher" :id="it.butcher" />
            <h3 v-if="it.essence" style="margin-top:12px">Essence</h3>
            <gather-table v-if="it.essence" :id="it.essence" />
          </section>
          <section class="card" v-if="it.contains">
            <h2>Contains</h2>
            <loot-table v-for="tb in it.contains" :key="tb" :id="tb" />
          </section>
        </div>

        <section class="card" v-if="useRecipes.length">
          <h2>Used in ({{ useRecipes.length }})</h2>
          <div class="recipes"><recipe-card v-for="r in useRecipes" :key="r" :id="r" /></div>
        </section>

        <p v-if="!hasSources" class="muted small">No in-game source found in the game data (cash shop, event or unused item).</p>
        <p class="muted small">Internal id: <code>{{ id }}</code></p>
      </div>`,
};

const MobList = {
    mixins: [helpers, queryState],
    computed: {
        all() {
            return Object.entries(store.data.mobs).map(([id, m]) => ({ id, ...m, name: entityName('mob', id) }));
        },
        classes() { return [...new Set(this.all.map(m => m.class).filter(Boolean))].sort(); },
        rows() {
            const { q, cls, danger } = this.query;
            return this.all.filter(m => (!cls || m.class === cls) && (!danger || m.danger === danger) && matches(q, m.name, m.id));
        },
        columns() {
            return [
                { key: 'name', label: 'Name', sort: r => r.name },
                { key: 'level', label: 'Level', cls: 'num', sort: r => r.level },
                { key: 'hp', label: 'HP', cls: 'num', sort: r => r.hp },
                { key: 'class', label: 'Type', sort: r => r.class || '' },
                { key: 'danger', label: 'Rank', sort: r => r.danger || '' },
                { key: 'extra', label: '', sortable: false },
            ];
        },
    },
    template: `
      <div>
        <h1>Mobs</h1>
        <div class="filters">
          <input type="search" :value="query.q" @input="setQuery('q', $event.target.value)" placeholder="Filter by name…">
          <select :value="query.cls || ''" @change="setQuery('cls', $event.target.value)">
            <option value="">Any type</option>
            <option v-for="c in classes" :key="c" :value="c">{{ t('UI.ItemToolTip.EntityClass.' + c) || c }}</option>
          </select>
          <select :value="query.danger || ''" @change="setQuery('danger', $event.target.value)">
            <option value="">Any rank</option>
            <option v-for="d in ['Elite', 'Boss', 'Guard']" :key="d" :value="d">{{ t('Overlay.EntityDanger.' + d) || d }}</option>
          </select>
          <span class="count">{{ rows.length }} mobs</span>
        </div>
        <div class="card">
          <data-table :rows="rows" :columns="columns" default-sort="level">
            <template #name="{ row }"><e-link t="mob" :id="row.id" /></template>
            <template #class="{ row }"><span class="muted">{{ row.class ? (t('UI.ItemToolTip.EntityClass.' + row.class) || row.class) : '' }}</span></template>
            <template #danger="{ row }"><span v-if="row.danger" class="tag">{{ t('Overlay.EntityDanger.' + row.danger) || row.danger }}</span></template>
            <template #extra="{ row }">
              <span v-if="row.loot" class="tag">loot</span><span v-if="row.butcher" class="tag">butchering</span><span v-if="row.pet" class="tag">tameable</span>
            </template>
          </data-table>
        </div>
      </div>`,
};

const MobPage = {
    mixins: [helpers],
    props: { id: String },
    data() { return { mode: '' }; },
    computed: {
        m() { return store.data.mobs[this.id]; },
        icon() { return iconOf('mob', this.id); },
        bonuses() { return this.m['bonuses' + this.mode] || (this.mode ? null : []); },
        vitals() {
            const m = this.m, rows = [['Level', m.level], ['Health', fmtNum(m.hp)]];
            if (m.hpRegen) rows.push(['Health regen', `${m.hpRegen}/s`]);
            if (m.stamina) rows.push(['Stamina', m.stamina]);
            if (m.walk || m.run) rows.push(['Speed', `${fmtNum(m.walk)} / ${fmtNum(m.run)}`]);
            if (m.xp) rows.push(['Experience', `${m.xp}${m.skillXp ? ` (+${m.skillXp} skill)` : ''}`]);
            if (m.behaviour) rows.push(['Behaviour', humanize(m.behaviour)]);
            return rows;
        },
    },
    template: `
      <div v-if="!m" class="card">Unknown mob <code>{{ id }}</code>. <router-link to="/mobs">All mobs</router-link></div>
      <div v-else>
        <div class="head">
          <img v-if="icon" class="ic ic-lg" :src="'icons/' + icon + '.webp'" alt="">
          <div>
            <div class="crumbs"><router-link to="/mobs">Mobs</router-link></div>
            <h1>{{ entityName('mob', id) }}</h1>
            <div class="sub">
              <span v-if="m.danger" class="tag warn">{{ t('Overlay.EntityDanger.' + m.danger) || m.danger }}</span>
              <span v-if="m.class" class="tag">{{ t('UI.ItemToolTip.EntityClass.' + m.class) || m.class }}</span>
              <span v-if="m.invincible" class="tag">invincible</span>
            </div>
          </div>
        </div>
        <div class="grid-2">
          <section class="card">
            <h2>Stats</h2>
            <dl class="kv"><template v-for="[k, v] in vitals" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template></dl>
          </section>
          <section class="card" v-if="m.bonuses || m.bonusesHard || m.bonusesNightmare">
            <h2>Defenses</h2>
            <div class="chips" v-if="m.bonusesHard || m.bonusesNightmare">
              <span class="chip" :class="{ on: mode === '' }" @click="mode = ''">{{ diff(0) }}</span>
              <span v-if="m.bonusesHard" class="chip" :class="{ on: mode === 'Hard' }" @click="mode = 'Hard'">{{ diff(1) }}</span>
              <span v-if="m.bonusesNightmare" class="chip" :class="{ on: mode === 'Nightmare' }" @click="mode = 'Nightmare'">{{ diff(2) }}</span>
            </div>
            <bonus-list :bonuses="bonuses || []" />
          </section>
          <section class="card" v-if="m.pet || m.areas || m.quests">
            <template v-if="m.pet"><h2>Tameable</h2><p><e-link t="item" :id="m.pet" /></p></template>
            <template v-if="m.areas"><h2>Found in</h2>
              <div class="mats"><span v-for="a in m.areas" :key="a.area"><e-link t="area" :id="a.area" no-icon /><span v-if="a.event" class="tag event">{{ a.event }}</span></span></div>
            </template>
            <template v-if="m.quests"><h2 style="margin-top:12px">Quests</h2><div v-for="q in m.quests" :key="q"><e-link t="quest" :id="q" /></div></template>
          </section>
        </div>
        <section class="card" v-if="m.skills" style="margin-top:16px">
          <h2>Attacks &amp; skills</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Skill</th><th class="num">Damage</th><th class="num">Crit</th><th class="num">Cooldown</th><th class="num">Range</th><th>Effects</th></tr></thead>
            <tbody>
              <tr v-for="s in m.skills" :key="s.id">
                <td>{{ humanize(s.id) }}<span v-if="s.attack?.isAOE" class="tag">AoE</span><span v-if="s.belowHp" class="tag">below {{ fmtPct(s.belowHp) }} HP</span></td>
                <td class="num">{{ s.attack ? fmtRange(s.attack.minDamage, s.attack.maxDamage) : '' }}</td>
                <td class="num">{{ s.attack?.criticalChance ? fmtPct(s.attack.criticalChance) + ' ×' + fmtNum(s.attack.criticalValue) : '' }}</td>
                <td class="num">{{ fmtTime(s.cooldown) }}</td>
                <td class="num">{{ s.range ? fmtNum(s.range) + ' m' : '' }}</td>
                <td><effect-list :effects="(s.attack?.effects || []).concat(s.onCaster || [], s.onTarget || [])" /></td>
              </tr>
            </tbody>
          </table></div>
        </section>
        <div class="grid-2">
          <section class="card" v-for="tb in m.loot || []" :key="tb">
            <h2>Loot <span class="muted small">{{ humanize(tb) }}</span></h2>
            <loot-table :id="tb" />
          </section>
          <section class="card" v-if="m.butcher">
            <h2>Butchering</h2>
            <gather-table :id="m.butcher" />
          </section>
        </div>
        <p class="muted small">Internal id: <code>{{ id }}</code></p>
      </div>`,
};

const NpcList = {
    mixins: [helpers, queryState],
    computed: {
        rows() {
            const q = this.query.q;
            return Object.entries(store.data.npcs)
                .map(([id, n]) => ({ id, ...n, name: entityName('npc', id), title: plain(t(`Entity.${id}.Title`) || '') }))
                .filter(n => matches(q, n.name, n.title, n.id));
        },
        columns() {
            return [
                { key: 'name', label: 'Name', sort: r => r.name },
                { key: 'title', label: 'Title', sort: r => r.title },
                { key: 'shop', label: 'Sells', cls: 'num', sort: r => r.shop?.length || 0 },
                { key: 'quests', label: 'Quests', cls: 'num', sort: r => r.quests?.length || 0 },
                { key: 'extra', label: '', sortable: false },
            ];
        },
    },
    template: `
      <div>
        <h1>NPCs</h1>
        <div class="filters">
          <input type="search" :value="query.q" @input="setQuery('q', $event.target.value)" placeholder="Filter by name or title…">
          <span class="count">{{ rows.length }} NPCs</span>
        </div>
        <div class="card">
          <data-table :rows="rows" :columns="columns" default-sort="name">
            <template #name="{ row }"><e-link t="npc" :id="row.id" /></template>
            <template #title="{ row }"><span class="muted">{{ row.title }}</span></template>
            <template #shop="{ row }">{{ row.shop?.length || '' }}</template>
            <template #quests="{ row }">{{ row.quests?.length || '' }}</template>
            <template #extra="{ row }"><span v-if="row.buys" class="tag">buys items</span><span v-for="s in row.services || []" :key="s" class="tag">{{ humanize(s) }}</span></template>
          </data-table>
        </div>
      </div>`,
};

const NpcPage = {
    mixins: [helpers],
    props: { id: String },
    computed: {
        n() { return store.data.npcs[this.id]; },
        title() { return t(`Entity.${this.id}.Title`); },
        talk() { return t(`Entity.${this.id}.Talk`); },
        given() { return (this.n.quests || []).filter(q => store.data.quests[q]?.giver === this.id); },
        taken() { return (this.n.quests || []).filter(q => store.data.quests[q]?.giver !== this.id); },
    },
    template: `
      <div v-if="!n" class="card">Unknown NPC <code>{{ id }}</code>. <router-link to="/npcs">All NPCs</router-link></div>
      <div v-else>
        <div class="head">
          <img v-if="n.icon" class="ic ic-lg" :src="'icons/' + n.icon + '.webp'" alt="">
          <div>
            <div class="crumbs"><router-link to="/npcs">NPCs</router-link></div>
            <h1>{{ entityName('npc', id) }}</h1>
            <div class="sub" v-if="title">{{ plain(title) }}</div>
            <div class="sub"><span v-for="s in n.services || []" :key="s" class="tag">{{ humanize(s) }}</span>
              <span v-for="a in n.areas || []" :key="a.area" class="tag">{{ entityName('area', a.area) }}</span></div>
            <div v-if="talk" class="desc rich" v-html="richText(talk)"></div>
          </div>
        </div>
        <section class="card" v-if="n.shop">
          <h2>Shop</h2>
          <data-table :rows="n.shop.map((s, i) => ({ id: i, ...s }))" :columns="[
              { key: 'item', label: 'Item', sort: r => entityName('item', r.item) },
              { key: 'book', label: '', sortable: false },
              { key: 'quality', label: 'Quality / level', cls: 'num' },
              { key: 'price', label: 'Price', cls: 'num' }]">
            <template #item="{ row }"><e-link t="item" :id="row.item" :amount="row.amount > 1 ? row.amount : null" /></template>
            <template #book="{ row }"><span v-if="row.book" class="tag">{{ entityName('skill', row.book) }}</span></template>
            <template #price="{ row }"><e-link v-if="row.currency" t="item" :id="row.currency" :amount="row.price" /><span v-else class="coin">{{ fmtNum(row.price) }}</span></template>
          </data-table>
        </section>
        <section class="card" v-if="n.buys">
          <h2>Buys</h2>
          <p class="muted">Pays ×{{ fmtNum(n.buys.usual) }} of the base price, ×{{ fmtNum(n.buys.special) }} for:</p>
          <p v-if="n.buys.skills">Anything crafted with: <template v-for="s in n.buys.skills"><router-link :to="routeTo('skill', s)">{{ entityName('skill', s) }}</router-link> </template></p>
          <div class="mats"><e-link v-for="i in n.buys.items || []" :key="i" t="item" :id="i" /></div>
        </section>
        <div class="grid-2">
          <section class="card" v-if="given.length"><h2>Gives quests</h2><div v-for="q in given" :key="q"><e-link t="quest" :id="q" /></div></section>
          <section class="card" v-if="taken.length"><h2>Completes quests</h2><div v-for="q in taken" :key="q"><e-link t="quest" :id="q" /></div></section>
        </div>
        <p class="muted small">Internal id: <code>{{ id }}</code></p>
      </div>`,
    methods: { plain },
};

const OBJECT_TYPES = {
    resource: o => !!o.gather,
    container: o => !!o.loot,
    station: o => !!(o.produce || o.provides),
    building: o => !!o.recipes,
    crop: o => !!o.seeds,
};

const ObjectList = {
    mixins: [helpers, queryState],
    computed: {
        all() {
            return Object.entries(store.data.objects)
                .filter(([id, o]) => hasName('object', id) && !idx.corpseOf[id])
                .map(([id, o]) => ({
                    id, ...o, name: entityName('object', id),
                    types: Object.keys(OBJECT_TYPES).filter(k => OBJECT_TYPES[k](o)),
                    skill: store.data.gathers[o.gather]?.skill,
                    level: store.data.gathers[o.gather]?.level,
                }));
        },
        rows() {
            const { q, type } = this.query;
            return this.all.filter(o => (!type || o.types.includes(type)) && matches(q, o.name, o.id));
        },
        columns() {
            return [
                { key: 'name', label: 'Name', sort: r => r.name },
                { key: 'types', label: 'Type', sortable: false },
                { key: 'skill', label: 'Gathering', sort: r => r.skill ? `${r.skill}${String(r.level || 0).padStart(3, '0')}` : null },
            ];
        },
    },
    template: `
      <div>
        <h1>World objects</h1>
        <div class="filters">
          <input type="search" :value="query.q" @input="setQuery('q', $event.target.value)" placeholder="Filter by name…">
          <span class="count">{{ rows.length }} objects</span>
        </div>
        <div class="chips">
          <span class="chip" :class="{ on: !query.type }" @click="setQuery('type', '')">All</span>
          <span v-for="k in Object.keys(types)" :key="k" class="chip" :class="{ on: query.type === k }" @click="setQuery('type', k)">{{ humanize(k) }}</span>
        </div>
        <div class="card">
          <data-table :rows="rows" :columns="columns" default-sort="name">
            <template #name="{ row }"><e-link t="object" :id="row.id" /></template>
            <template #types="{ row }"><span v-for="k in row.types" :key="k" class="tag">{{ humanize(k) }}</span></template>
            <template #skill="{ row }"><span v-if="row.skill">{{ entityName('skill', row.skill) }} {{ row.level || 0 }}</span></template>
          </data-table>
        </div>
      </div>`,
    data() { return { types: OBJECT_TYPES }; },
};

const ObjectPage = {
    mixins: [helpers],
    props: { id: String },
    computed: {
        o() { return store.data.objects[this.id]; },
        desc() { return t(`WorldObject.${this.id}.Description`); },
        corpseOf() { return idx.corpseOf[this.id] || []; },
        stationFor() {
            // recipes that need a bonus this object provides
            const provides = new Set(this.o.provides || []);
            return Object.entries(store.data.recipes).filter(([, r]) => (r.stations || []).some(s => provides.has(s))).map(([id]) => id);
        },
    },
    template: `
      <div v-if="!o" class="card">Unknown object <code>{{ id }}</code>. <router-link to="/objects">All objects</router-link></div>
      <div v-else>
        <div class="head">
          <img v-if="o.icon" class="ic ic-lg" :src="'icons/' + o.icon + '.webp'" alt="">
          <div>
            <div class="crumbs"><router-link to="/objects">World objects</router-link></div>
            <h1>{{ entityName('object', id) }}</h1>
            <div class="sub">
              <span v-if="corpseOf.length">Corpse of <template v-for="m in corpseOf"><e-link t="mob" :id="m" /> </template></span>
              <span v-if="o.slots" class="tag">{{ o.slots }} slots</span>
              <span v-for="a in o.areas || []" :key="a.area" class="tag">{{ entityName('area', a.area) }}</span>
            </div>
            <div v-if="desc" class="desc rich" v-html="richText(desc)"></div>
          </div>
        </div>
        <div class="grid-2">
          <section class="card" v-if="o.gather"><h2>Gathering</h2><gather-table :id="o.gather" /></section>
          <section class="card" v-for="s in o.stateGathers || []" :key="s.gather"><h2>{{ humanize(s.state) }}</h2><gather-table :id="s.gather" /></section>
          <section class="card" v-for="tb in o.loot || []" :key="tb"><h2>Loot <span class="muted small">{{ humanize(tb) }}</span></h2><loot-table :id="tb" /></section>
          <section class="card" v-if="o.provides">
            <h2>Provides</h2>
            <div v-for="b in o.provides" :key="b"><router-link :to="routeTo('bonus', b)">{{ entityName('bonus', b) }}</router-link></div>
          </section>
          <section class="card" v-if="o.fuels || o.timer">
            <h2>Fuel</h2>
            <div class="mats"><e-link v-for="f in o.fuels || []" :key="f.item" t="item" :id="f.item" :amount="f.amount" /></div>
            <p v-if="o.timer" class="muted small">Burns for {{ fmtTime(o.timer) }}</p>
          </section>
          <section class="card" v-if="o.seeds">
            <h2>Grown from</h2>
            <div v-for="s in o.seeds" :key="s.item"><e-link t="item" :id="s.item" /> <span class="muted small">{{ fmtPct(s.chance) }}<span v-if="s.level">, skill {{ s.level }}</span></span></div>
          </section>
          <section class="card" v-if="o.upgradeTo">
            <h2>Upgrades to</h2>
            <p><e-link t="object" :id="o.upgradeTo" /></p>
            <div class="mats"><e-link v-for="m in o.upgradeCost || []" :key="m.item" t="item" :id="m.item" :amount="m.amount" /></div>
          </section>
        </div>
        <section class="card" v-if="o.recipes" style="margin-top:16px">
          <h2>How to build</h2>
          <div class="recipes"><recipe-card v-for="r in o.recipes" :key="r" :id="r" /></div>
        </section>
        <section class="card" v-if="o.produce">
          <h2>Production</h2>
          <div class="recipes"><recipe-card v-for="p in o.produce" :key="p" :id="Object.keys(D.recipes).find(k => D.recipes[k].name === p)" /></div>
        </section>
        <section class="card" v-if="stationFor.length">
          <h2>Crafting station for ({{ stationFor.length }})</h2>
          <p><router-link :to="{ path: '/recipes', query: { station: o.provides[0] } }">Show as recipe list</router-link></p>
        </section>
        <p class="muted small">Internal id: <code>{{ id }}</code></p>
      </div>`,
};

const QuestList = {
    mixins: [helpers, queryState],
    computed: {
        rows() {
            const { q, line, kind, daily } = this.query;
            return Object.entries(store.data.quests)
                .map(([id, qu]) => ({ id, ...qu, name: entityName('quest', id) }))
                .filter(x => (!line || x.line === line) && (!kind || x.kind === kind) && (!daily || !!x.daily === (daily === '1')) &&
                    matches(q, x.name, x.id, x.giver && entityName('npc', x.giver)));
        },
        columns() {
            return [
                { key: 'name', label: 'Quest', sort: r => r.name },
                { key: 'kind', label: 'Type', sort: r => r.kind },
                { key: 'giver', label: 'Giver', sort: r => r.giver ? entityName('npc', r.giver) : null },
                { key: 'reward', label: 'Reward', sort: r => r.reward?.money || 0, desc: true },
            ];
        },
        lines: () => idx.questLines,
        kinds: () => idx.questKinds,
    },
    template: `
      <div>
        <h1>Quests</h1>
        <div class="filters">
          <input type="search" :value="query.q" @input="setQuery('q', $event.target.value)" placeholder="Filter by name or NPC…">
          <select :value="query.line || ''" @change="setQuery('line', $event.target.value)">
            <option value="">Any line</option><option v-for="l in lines" :key="l" :value="l">{{ humanize(l) }}</option>
          </select>
          <select :value="query.kind || ''" @change="setQuery('kind', $event.target.value)">
            <option value="">Any type</option><option v-for="k in kinds" :key="k" :value="k">{{ humanize(k) }}</option>
          </select>
          <select :value="query.daily || ''" @change="setQuery('daily', $event.target.value)">
            <option value="">Daily and regular</option><option value="1">Daily only</option><option value="0">Not daily</option>
          </select>
          <span class="count">{{ rows.length }} quests</span>
        </div>
        <div class="card">
          <data-table :rows="rows" :columns="columns" default-sort="name">
            <template #name="{ row }"><e-link t="quest" :id="row.id" no-icon /><span v-if="row.daily" class="tag">daily</span></template>
            <template #kind="{ row }"><span class="muted">{{ humanize(row.kind) }}</span></template>
            <template #giver="{ row }"><e-link v-if="row.giver" t="npc" :id="row.giver" no-icon /></template>
            <template #reward="{ row }">
              <span v-if="row.reward?.money" class="coin">{{ fmtNum(row.reward.money) }} </span>
              <e-link v-if="row.reward?.item" t="item" :id="row.reward.item" :amount="row.reward.amount > 1 ? row.reward.amount : null" />
            </template>
          </data-table>
        </div>
      </div>`,
};

const QUEST_GOAL_LABELS = {
    killTarget: 'Kill', killTargets: 'Kill any of', killAmount: 'Amount', triggerItem: 'Item', itemAmount: 'Amount',
    triggerObject: 'Target', triggerAmount: 'Amount', triggerSkill: 'Action', buildTarget: 'Build', buildAmount: 'Amount',
    areaName: 'Area', entityGroup: 'Mob group', otherTargets: 'Also counts', npcForAction: 'NPC', isFishing: 'By fishing',
    minQuality: 'Min. quality', requiredDifficult: 'Difficulty', removeItemsOnComplete: 'Items are taken',
    triggerTargets: 'Targets', attackItem: 'Using', playerHaveEffect: 'With effect', targetEntityClass: 'Target type',
};

const QuestPage = {
    mixins: [helpers],
    props: { id: String },
    computed: {
        q() { return store.data.quests[this.id]; },
        desc() { return t(`Quest.${this.id}.Description`); },
        goal() {
            const order = Object.keys(QUEST_GOAL_LABELS);
            const rank = k => (order.indexOf(k) + 1) || 99;
            return Object.entries(this.q.goal || {}).sort((a, b) => rank(a[0]) - rank(b[0])).map(([k, v]) => ({
                k, label: QUEST_GOAL_LABELS[k] || humanize(k),
                links: Array.isArray(v) ? (v[0]?.t ? v : null) : (v?.t ? [v] : null),
                value: v,
            }));
        },
    },
    methods: {
        valueText(g) {
            if (g.k === 'areaName') return entityName('area', g.value);
            if (g.k === 'requiredDifficult') return g.value;
            if (g.value === 1 && /^is|remove/.test(g.k)) return 'yes';
            return typeof g.value === 'object' ? JSON.stringify(g.value) : g.value;
        },
    },
    template: `
      <div v-if="!q" class="card">Unknown quest <code>{{ id }}</code>. <router-link to="/quests">All quests</router-link></div>
      <div v-else>
        <div class="head"><div>
          <div class="crumbs"><router-link to="/quests">Quests</router-link> ›
            <router-link :to="{ path: '/quests', query: { line: q.line } }">{{ humanize(q.line) }}</router-link></div>
          <h1>{{ entityName('quest', id) }}</h1>
          <div class="sub">
            <span class="tag">{{ humanize(q.kind) }}</span>
            <span v-if="q.daily" class="tag">daily</span><span v-if="q.repeatable" class="tag">repeatable</span><span v-if="q.tutorial" class="tag">tutorial</span>
            <span v-if="q.guildLevel" class="tag">guild level {{ q.guildLevel }}+</span>
          </div>
          <div v-if="desc" class="desc rich" v-html="richText(desc)"></div>
        </div></div>
        <div class="grid-2">
          <section class="card">
            <h2>Objective</h2>
            <dl class="kv">
              <template v-for="g in goal" :key="g.k">
                <dt>{{ g.label }}</dt>
                <dd><template v-if="g.links"><div v-for="(l, i) in g.links" :key="i"><e-link :t="l.t" :id="l.id" /></div></template>
                    <template v-else>{{ valueText(g) }}</template></dd>
              </template>
            </dl>
          </section>
          <section class="card">
            <h2>NPCs</h2>
            <dl class="kv">
              <template v-if="q.giver"><dt>Given by</dt><dd><e-link t="npc" :id="q.giver" /></dd></template>
              <template v-if="q.taker"><dt>Turn in to</dt><dd><e-link t="npc" :id="q.taker" /></dd></template>
            </dl>
          </section>
          <section class="card" v-if="q.reward">
            <h2>Reward</h2>
            <dl class="kv">
              <template v-if="q.reward.money"><dt>Money</dt><dd class="coin">{{ fmtNum(q.reward.money) }}</dd></template>
              <template v-if="q.reward.guildXp"><dt>Guild XP</dt><dd>{{ fmtNum(q.reward.guildXp) }}</dd></template>
              <template v-if="q.reward.item"><dt>Item</dt><dd><e-link t="item" :id="q.reward.item" :amount="q.reward.amount > 1 ? q.reward.amount : null" />
                <span v-if="q.reward.book" class="tag">{{ entityName('skill', q.reward.book) }}</span></dd></template>
            </dl>
          </section>
          <section class="card" v-if="q.prev || q.next">
            <h2>Quest chain</h2>
            <dl class="kv">
              <template v-if="q.prev"><dt>After</dt><dd><div v-for="p in q.prev" :key="p"><e-link t="quest" :id="p" no-icon /></div></dd></template>
              <template v-if="q.next"><dt>Unlocks</dt><dd><div v-for="p in q.next" :key="p"><e-link t="quest" :id="p" no-icon /></div></dd></template>
            </dl>
          </section>
        </div>
        <p class="muted small" style="margin-top:16px">Internal id: <code>{{ id }}</code></p>
      </div>`,
};

const RecipeList = {
    mixins: [helpers, queryState],
    computed: {
        rows() {
            const { q, type, skill, station } = this.query;
            return Object.entries(store.data.recipes)
                .map(([id, r]) => ({ id, ...r, name: this.outName(r) }))
                .filter(r => (!type || r.type === type) && (!skill || r.skill === skill) &&
                    (!station || (r.stations || []).includes(station) || r.tool === station) &&
                    (!q || matches(q, r.name, ...(r.in || []).map(m => entityName('item', m.item)))));
        },
        columns() {
            return [
                { key: 'name', label: 'Result', sort: r => r.name },
                { key: 'in', label: 'Materials', sortable: false },
                { key: 'skill', label: 'Skill', sort: r => r.skill ? `${r.skill}${String(r.level || 0).padStart(3, '0')}` : null },
                { key: 'where', label: 'Tool / station', sortable: false },
            ];
        },
        skills: () => idx.recipeSkills,
        stations: () => idx.recipeStations,
    },
    methods: {
        outName(r) {
            const o = r.out?.[0];
            if (!o) return r.name ? humanize(r.name) : '';
            return o.item ? entityName('item', o.item) : entityName(o.t, o.id);
        },
    },
    template: `
      <div>
        <h1>Recipes</h1>
        <div class="filters">
          <input type="search" :value="query.q" @input="setQuery('q', $event.target.value)" placeholder="Result or material…">
          <select :value="query.type || ''" @change="setQuery('type', $event.target.value)">
            <option value="">Any kind</option>
            <option v-for="k in ['craft', 'build', 'produce', 'feed', 'pairing']" :key="k" :value="k">{{ humanize(k) }}</option>
          </select>
          <select :value="query.skill || ''" @change="setQuery('skill', $event.target.value)">
            <option value="">Any skill</option><option v-for="s in skills" :key="s" :value="s">{{ entityName('skill', s) }}</option>
          </select>
          <select :value="query.station || ''" @change="setQuery('station', $event.target.value)">
            <option value="">Any station</option><option v-for="s in stations" :key="s" :value="s">{{ entityName('bonus', s) }}</option>
          </select>
          <span class="count">{{ rows.length }} recipes</span>
        </div>
        <div class="card">
          <data-table :rows="rows" :columns="columns" default-sort="skill">
            <template #name="{ row }">
              <template v-for="(o, i) in row.out" :key="i"><e-link v-if="o.item" t="item" :id="o.item" :amount="o.amount > 1 ? o.amount : null" /><e-link v-else :t="o.t" :id="o.id" /><br v-if="i < row.out.length - 1"></template>
              <span v-if="row.event" class="tag event">{{ row.event }}</span>
            </template>
            <template #in="{ row }"><div class="mats small"><e-link v-for="m in row.in" :key="m.item" t="item" :id="m.item" :amount="m.amount" /></div></template>
            <template #skill="{ row }"><span v-if="row.skill" class="nowrap">{{ entityName('skill', row.skill) }} {{ row.level || 0 }}</span></template>
            <template #where="{ row }">
              <span class="small">
                <router-link v-if="row.tool" :to="routeTo('bonus', row.tool)">{{ entityName('bonus', row.tool) }}</router-link>
                <template v-for="s in row.stations || []"> · <router-link :to="routeTo('bonus', s)">{{ entityName('bonus', s) }}</router-link></template>
                <template v-for="s in row.at || []"><e-link t="object" :id="s" no-icon /> </template>
              </span>
            </template>
          </data-table>
        </div>
      </div>`,
};

const SkillList = {
    mixins: [helpers],
    computed: {
        groups() {
            const g = {};
            for (const [id, s] of Object.entries(store.data.skills)) (g[s.type || 'Other'] ||= []).push(id);
            for (const k in g) g[k].sort((a, b) => entityName('skill', a).localeCompare(entityName('skill', b)));
            return g;
        },
    },
    template: `
      <div>
        <h1>Skills</h1>
        <div class="grid-2">
          <section v-for="(ids, type) in groups" :key="type" class="card">
            <h2>{{ humanize(type) }}</h2>
            <div v-for="id in ids" :key="id"><router-link :to="routeTo('skill', id)">{{ entityName('skill', id) }}</router-link>
              <span class="muted small" v-if="D.skills[id].passives"> · {{ D.skills[id].passives.length }} passives</span></div>
          </section>
        </div>
      </div>`,
};

const SkillPage = {
    mixins: [helpers],
    props: { id: String },
    computed: {
        s() { return store.data.skills[this.id]; },
        desc() { return t(`Skill.${this.id}.Description`); },
        recipeCount() { return Object.values(store.data.recipes).filter(r => r.skill === this.id).length; },
        gathers() {
            return Object.entries(store.data.gathers).filter(([, g]) => g.skill === this.id && g.from?.length)
                .sort((a, b) => (a[1].level || 0) - (b[1].level || 0));
        },
    },
    template: `
      <div v-if="!s" class="card">Unknown skill <code>{{ id }}</code>. <router-link to="/skills">All skills</router-link></div>
      <div v-else>
        <div class="head"><div>
          <div class="crumbs"><router-link to="/skills">Skills</router-link></div>
          <h1>{{ entityName('skill', id) }}</h1>
          <div class="sub"><span v-if="s.type" class="tag">{{ humanize(s.type) }}</span><span v-if="s.combat" class="tag">combat</span>
            <span v-if="s.cap" class="tag">level cap {{ s.cap }}</span><span v-if="s.xpMod" class="tag">XP ×{{ s.xpMod }}</span></div>
          <div v-if="desc" class="desc rich" v-html="richText(desc)"></div>
          <p v-if="recipeCount"><router-link :to="{ path: '/recipes', query: { skill: id } }">{{ recipeCount }} recipes use this skill</router-link></p>
        </div></div>
        <section class="card" v-if="s.passives">
          <h2>Passives</h2>
          <table><tbody>
            <tr v-for="p in s.passives" :key="p.id">
              <td class="num">{{ p.level }}</td>
              <td><span class="elink"><img v-if="p.icon" class="ic" :src="'icons/' + p.icon + '.webp'" alt="" loading="lazy">{{ entityName('passive', p.id) }}</span>
                <div class="small muted rich" v-if="t('Passive.' + p.id + '.Description')" v-html="richText(t('Passive.' + p.id + '.Description'))"></div></td>
              <td><bonus-list :bonuses="p.bonuses || []" /></td>
            </tr>
          </tbody></table>
        </section>
        <section class="card" v-if="s.abilities">
          <h2>Abilities</h2>
          <table><tbody>
            <tr v-for="a in s.abilities" :key="a.id">
              <td class="num">{{ a.level || 0 }}</td>
              <td><span class="elink"><img v-if="a.icon" class="ic" :src="'icons/' + a.icon + '.webp'" alt="" loading="lazy">{{ humanize(a.id) }}</span></td>
              <td class="muted small">{{ a.cooldown ? 'cooldown ' + fmtTime(a.cooldown) : '' }}{{ a.stamina ? ' · ' + a.stamina + ' stamina' : '' }}</td>
            </tr>
          </tbody></table>
        </section>
        <section class="card" v-if="gathers.length">
          <h2>Gathering</h2>
          <table><tbody>
            <tr v-for="[gid, g] in gathers" :key="gid">
              <td class="num">{{ g.level || 0 }}</td>
              <td><template v-for="(f, i) in g.from" :key="i"><e-link :t="f.t" :id="f.id" />&nbsp; </template></td>
              <td><div class="mats small"><e-link v-for="x in g.items" :key="x.item" t="item" :id="x.item" /></div></td>
            </tr>
          </tbody></table>
        </section>
      </div>`,
};

const BonusPage = {
    mixins: [helpers],
    props: { id: String },
    computed: {
        b() { return store.data.bonuses[this.id] || {}; },
        items() {
            return Object.entries(store.data.items).filter(([, it]) => (it.bonuses || []).some(([n]) => n === this.id))
                .map(([iid, it]) => ({ id: iid, value: it.bonuses.find(([n]) => n === this.id)[1] }));
        },
        objects() { return Object.entries(store.data.objects).filter(([, o]) => (o.provides || []).includes(this.id)).map(([oid]) => oid); },
        recipes() {
            return Object.values(store.data.recipes).filter(r => r.tool === this.id || (r.stations || []).includes(this.id)).length;
        },
    },
    template: `
      <div>
        <div class="head"><div>
          <div class="crumbs">Bonus</div>
          <h1>{{ entityName('bonus', id) }}</h1>
          <div class="sub"><span v-if="b.cat" class="tag">{{ humanize(b.cat) }}</span><span v-if="b.max" class="tag">max {{ fmtBonus(id, b.max) }}</span></div>
          <p v-if="recipes"><router-link :to="{ path: '/recipes', query: { station: id } }">{{ recipes }} recipes require this</router-link></p>
        </div></div>
        <section class="card" v-if="objects.length">
          <h2>Provided by structures</h2>
          <div class="mats"><e-link v-for="o in objects" :key="o" t="object" :id="o" /></div>
        </section>
        <section class="card" v-if="items.length">
          <h2>Items with this bonus</h2>
          <data-table :rows="items" :columns="[{ key: 'id', label: 'Item', sort: r => entityName('item', r.id) }, { key: 'value', label: 'Value', cls: 'num', sort: r => r.value, desc: true }]" default-sort="value">
            <template #id="{ row }"><e-link t="item" :id="row.id" /></template>
            <template #value="{ row }">{{ fmtBonus(id, row.value) }}</template>
          </data-table>
        </section>
      </div>`,
};

const AreaList = {
    mixins: [helpers],
    computed: {
        rows() {
            return Object.entries(store.data.areas).filter(([, a]) => a.spawns)
                .map(([id, a]) => ({ id, ...a, name: entityName('area', id), mobs: a.spawns.filter(s => s.t === 'mob').length }));
        },
    },
    template: `
      <div>
        <h1>Areas</h1>
        <div class="card">
          <data-table :rows="rows" :columns="[{ key: 'name', label: 'Area', sort: r => r.name }, { key: 'mobs', label: 'Mob spawns', cls: 'num', sort: r => r.mobs, desc: true }]" default-sort="name">
            <template #name="{ row }"><router-link :to="routeTo('area', row.id)">{{ row.name }}</router-link></template>
          </data-table>
        </div>
      </div>`,
};

const AreaPage = {
    mixins: [helpers],
    props: { id: String },
    computed: {
        a() { return store.data.areas[this.id]; },
        groups() {
            const g = {};
            for (const s of this.a?.spawns || []) (g[s.t] ||= []).push(s);
            return g;
        },
    },
    template: `
      <div v-if="!a" class="card">Unknown area <code>{{ id }}</code>.</div>
      <div v-else>
        <div class="head"><div>
          <div class="crumbs"><router-link to="/areas">Areas</router-link></div>
          <h1>{{ entityName('area', id) }}</h1>
          <div class="sub"><span v-if="a.noBuild" class="tag">no building</span><span v-if="a.claim" class="tag">claims allowed</span>
            <span v-for="e in a.effects || []" :key="e" class="tag">{{ entityName('effect', e) }}</span></div>
        </div></div>
        <div class="grid-2">
          <section class="card" v-for="(list, kind) in groups" :key="kind">
            <h2>{{ { mob: 'Mobs', object: 'Objects', npc: 'NPCs' }[kind] || humanize(kind) }}</h2>
            <table><tbody>
              <tr v-for="(s, i) in list" :key="i">
                <td><e-link v-if="['mob', 'object', 'npc'].includes(s.t)" :t="s.t" :id="s.id" /><span v-else>{{ humanize(s.id) }}</span>
                  <span v-if="s.event" class="tag event">{{ s.event }}</span></td>
                <td class="num muted small">{{ s.density ? 'density ' + fmtNum(s.density, 3) : '' }}</td>
                <td class="num muted small">{{ s.respawn ? 'respawn ' + fmtTime(s.respawn) : '' }}</td>
              </tr>
            </tbody></table>
          </section>
        </div>
      </div>`,
};

const Changes = {
    mixins: [helpers],
    computed: { c() { return store.changes; } },
    methods: {
        kindOf(coll) { return Object.keys(KIND).find(k => KIND[k].coll === coll && KIND[k].route); },
    },
    template: `
      <div>
        <h1>Changes in the last update</h1>
        <div v-if="!c" class="card muted">No changes recorded yet.</div>
        <template v-else>
          <p class="muted">Build {{ c.from || '?' }} → {{ c.to || '?' }}, extracted {{ new Date(c.date * 1000).toLocaleDateString() }}</p>
          <section class="card" v-for="(d, coll) in c.changes" :key="coll">
            <h2>{{ humanize(coll) }}</h2>
            <div v-for="(ids, what) in d" :key="what" style="margin-bottom:8px">
              <h3>{{ what }} ({{ ids.length }})</h3>
              <div class="mats small">
                <template v-for="id in ids.slice(0, 300)" :key="id">
                  <e-link v-if="kindOf(coll) && what !== 'removed'" :t="kindOf(coll)" :id="id" /><span v-else>{{ humanize(id) }}</span>
                </template>
              </div>
            </div>
          </section>
        </template>
      </div>`,
};

const NotFound = {
    template: `<div class="card">Page not found. <router-link to="/">Home</router-link></div>`,
};

/* ---------------------------------------------------------------- app */

const routes = [
    { path: '/', component: Home, meta: { title: '' } },
    { path: '/items', component: ItemList, meta: { title: 'Items' } },
    { path: '/items/:id', component: ItemPage, props: true, meta: { kind: 'item' } },
    { path: '/mobs', component: MobList, meta: { title: 'Mobs' } },
    { path: '/mobs/:id', component: MobPage, props: true, meta: { kind: 'mob' } },
    { path: '/npcs', component: NpcList, meta: { title: 'NPCs' } },
    { path: '/npcs/:id', component: NpcPage, props: true, meta: { kind: 'npc' } },
    { path: '/objects', component: ObjectList, meta: { title: 'World objects' } },
    { path: '/objects/:id', component: ObjectPage, props: true, meta: { kind: 'object' } },
    { path: '/quests', component: QuestList, meta: { title: 'Quests' } },
    { path: '/quests/:id', component: QuestPage, props: true, meta: { kind: 'quest' } },
    { path: '/recipes', component: RecipeList, meta: { title: 'Recipes' } },
    { path: '/skills', component: SkillList, meta: { title: 'Skills' } },
    { path: '/skills/:id', component: SkillPage, props: true, meta: { kind: 'skill' } },
    { path: '/bonuses/:id', component: BonusPage, props: true, meta: { kind: 'bonus' } },
    { path: '/areas', component: AreaList, meta: { title: 'Areas' } },
    { path: '/areas/:id', component: AreaPage, props: true, meta: { kind: 'area' } },
    { path: '/changes', component: Changes, meta: { title: 'Changes' } },
    { path: '/:pathMatch(.*)*', component: NotFound, meta: { title: 'Not found' } },
];

const router = createRouter({
    history: createWebHashHistory(),
    routes,
    scrollBehavior: (to, from, saved) => saved || (to.path !== from.path ? { top: 0 } : undefined),
});

// One pageview per page; filter edits only replace the query and are not counted.
let lastTrackedPath = null;
router.afterEach(to => {
    if (to.path === lastTrackedPath) return;
    lastTrackedPath = to.path;
    window.posthog?.capture('$pageview');
});

const App = {
    mixins: [helpers],
    computed: {
        nav() {
            const c = store.meta?.counts || {};
            return [['/items', 'Items', c.items], ['/recipes', 'Recipes', c.recipes], ['/mobs', 'Mobs', c.mobs],
                ['/npcs', 'NPCs', c.npcs], ['/objects', 'Objects'], ['/quests', 'Quests', c.quests],
                ['/skills', 'Skills', c.skills], ['/areas', 'Areas']];
        },
        languages() { return store.meta?.languages || ['en']; },
        total() { return COLLECTIONS.length + 1 + (store.lang !== 'en' ? 1 : 0); },
        pageTitle() {
            const r = this.$route;
            if (!store.ready) return '';
            if (r.meta.kind) return entityName(r.meta.kind, r.params.id);
            return r.meta.title;
        },
    },
    watch: {
        pageTitle: {
            immediate: true,
            handler(v) { document.title = v ? `${v} — Wild Terra 2 Wiki` : 'Wild Terra 2 Wiki'; },
        },
    },
    methods: {
        langName: l => LANG_NAMES[l] || l,
        setLang,
        toggleTheme() {
            const dark = store.theme ? store.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
            store.theme = dark ? 'light' : 'dark';
            storageSet('wt2.theme', store.theme);
            applyTheme();
        },
    },
    template: `
      <header class="topbar">
        <router-link to="/" class="brand">WT2 Wiki</router-link>
        <search-box v-if="store.ready" />
        <div class="tools">
          <select :value="store.lang" @change="setLang($event.target.value)" aria-label="Language">
            <option v-for="l in languages" :key="l" :value="l">{{ langName(l) }}</option>
          </select>
          <button @click="toggleTheme" title="Toggle light/dark" aria-label="Toggle theme">◐</button>
        </div>
      </header>
      <div v-if="store.error" class="loading">Failed to load data: {{ store.error }}</div>
      <div v-else-if="!store.ready" class="loading">Loading game data…<div class="bar"><div :style="{ width: (100 * store.progress / total) + '%' }"></div></div></div>
      <div v-else class="layout">
        <nav class="side">
          <router-link v-for="[to, label, n] in nav" :key="to" :to="to">{{ label }}<span class="count" v-if="n">{{ fmtNum(n) }}</span></router-link>
          <router-link v-if="store.changes" to="/changes">Changes</router-link>
        </nav>
        <main><router-view :key="$route.path" /></main>
      </div>
      <footer>Fan-made wiki. Data extracted from the Wild Terra 2 client{{ store.meta?.build ? ', build ' + store.meta.build : '' }}. Not affiliated with Juvty Worlds.</footer>`,
};

applyTheme();
const app = createApp(App);
app.mixin({ methods: { plain } });
for (const [name, c] of Object.entries({
    'e-link': ELink, 'bonus-list': BonusList, 'effect-list': EffectList, 'recipe-card': RecipeCard,
    'loot-table': LootTable, 'gather-table': GatherTable, 'data-table': DataTable, 'search-box': SearchBox,
})) app.component(name, c);
app.use(router);
app.mount('#app');
loadAll();
