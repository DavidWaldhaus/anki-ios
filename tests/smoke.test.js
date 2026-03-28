const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createCtx() {
  class FakeClassList {
    constructor() { this.set = new Set(); }
    add(...n){ n.forEach(v=>this.set.add(v)); }
    remove(...n){ n.forEach(v=>this.set.delete(v)); }
    toggle(n,force){ if(force===undefined){ if(this.set.has(n)){this.set.delete(n);return false;} this.set.add(n);return true; } if(force) this.set.add(n); else this.set.delete(n); return force; }
    contains(n){ return this.set.has(n); }
  }
  class FakeElement {
    constructor(id=''){ this.id=id; this.innerHTML=''; this.textContent=''; this.style={}; this.value=''; this.classList=new FakeClassList(); this.children=[]; }
    appendChild(c){ this.children.push(c); return c; }
    querySelector(){ return new FakeElement(); }
    querySelectorAll(){ return []; }
    addEventListener(){}
    remove(){}
    click(){}
  }
  const map = new Map();
  const getEl = (id)=>{ if(!map.has(id)) map.set(id,new FakeElement(id)); return map.get(id); };
  const document = {
    readyState: 'loading',
    getElementById: getEl,
    querySelectorAll: ()=>[],
    querySelector: ()=>new FakeElement(),
    createElement: ()=>new FakeElement(),
    addEventListener: ()=>{},
    elementFromPoint: ()=>null,
  };
  const windowObj = {
    document,
    matchMedia: ()=>({matches:false, addEventListener(){}}),
    addEventListener(){},
    removeEventListener(){},
  };
  windowObj.window = windowObj;
  class AbortSignal { constructor(){this.l=[];} addEventListener(t,cb){ if(t==='abort') this.l.push(cb); } }
  class AbortController { constructor(){ this.signal = new AbortSignal(); } abort(){ this.signal.l.forEach(cb=>cb()); } }

  const ctx = {
    console,
    document,
    window: windowObj,
    localStorage: { getItem: ()=>null, setItem: ()=>{} },
    initSqlJs: async ()=>({Database: function(){}}),
    JSZip: { loadAsync: async ()=>({}) },
    fetch: async ()=>({ ok:true, status:200, json: async()=>({}) }),
    Blob: function(){},
    URL: { createObjectURL: ()=> 'blob:test' },
    Audio: function(){ this.play=()=>Promise.resolve(); this.pause=()=>{}; },
    FileReader: function(){ this.readAsText=()=>{}; },
    confirm: ()=>true,
    setTimeout,
    clearTimeout,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp,
    encodeURIComponent, decodeURIComponent, escape, unescape,
    atob: (s)=>Buffer.from(s,'base64').toString('binary'),
    btoa: (s)=>Buffer.from(s,'binary').toString('base64'),
    AbortController,
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const file of ['js/state.js','js/sync.js','js/import-render-settings.js','js/study-init.js']) {
    vm.runInContext(fs.readFileSync(file,'utf8'), ctx, { filename:file });
  }
  return {ctx, getEl};
}

test('runApp hides loader on successful boot path', async () => {
  const {ctx, getEl} = createCtx();
  vm.runInContext('decks={};db={};', ctx);
  await ctx.runApp();
  assert.equal(getEl('loaderOverlay').classList.contains('gone'), true);
});

test('intervalLabel never returns NaN string with malformed state', () => {
  const {ctx} = createCtx();
  const txt = ctx.intervalLabel({ due: 'x', ease: 'oops', interval: '??', type: 2 }, 3);
  assert.equal(/NaN/.test(String(txt)), false);
});

test('disabled subdeck is excluded from all-cards aggregation', () => {
  const {ctx} = createCtx();
  vm.runInContext(`
    decks={
      a:{name:'Root::A', cards:[{cid:1,nid:1,ord:0}]},
      b:{name:'Root::B', cards:[{cid:2,nid:2,ord:0}]}
    };
    userSettings.deckEnabled={'Root::B':false};
  `, ctx);
  const cards = ctx.getAllCardsForNodeByName('Root');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].cid, 1);
});

test('fun mode re-queues card unless rated easy', () => {
  const {ctx} = createCtx();
  vm.runInContext(`
    sessionMode = 'fun-random';
    const c1 = {cid:10,nid:10,ord:0,did:'1',fields:{Front:'A'}};
    curCard = c1;
    studyQueue = [c1];
    studyIdx = 0;
    rateCard('hard');
  `, ctx);
  const qLenAfterHard = vm.runInContext('studyQueue.length', ctx);
  assert.equal(qLenAfterHard >= 1, true);

  vm.runInContext(`
    sessionMode = 'fun-random';
    const c2 = {cid:11,nid:11,ord:0,did:'1',fields:{Front:'B'}};
    curCard = c2;
    studyQueue = [c2];
    studyIdx = 0;
    rateCard('easy');
  `, ctx);
  const qLenAfterEasy = vm.runInContext('studyQueue.length', ctx);
  assert.equal(qLenAfterEasy, 1);
});

test('buildStudyQueue respects daily new-per-deck delta', () => {
  const {ctx} = createCtx();
  vm.runInContext(`
    decks={ d1:{name:'Root::Deck', cards:[
      {cid:1,nid:1,ord:0,did:'d1',fields:{Front:'A'}},
      {cid:2,nid:2,ord:0,did:'d1',fields:{Front:'B'}},
      {cid:3,nid:3,ord:0,did:'d1',fields:{Front:'C'}}
    ]}};
    userSettings.newPerDeck = 3;
    userSettings.newSeenByDay = {[todayKey()]: {'Root::Deck': 2}};
    const q = buildStudyQueue(decks.d1.cards);
    globalThis._qLen = q.length;
  `, ctx);
  assert.equal(vm.runInContext('_qLen', ctx), 1);
});

test('startStudy allows explicitly opening disabled deck', () => {
  const {ctx} = createCtx();
  vm.runInContext(`
    decks={ d1:{name:'Root::Off', fields:['Front'], cards:[{cid:1,nid:1,ord:0,did:'d1',fields:{Front:'A'}}]} };
    userSettings.deckEnabled={'Root::Off':false};
    startStudy('d1');
    globalThis._mode = sessionMode;
  `, ctx);
  assert.equal(vm.runInContext('_mode', ctx), 'normal');
});

test('new delta tracking applies same-day difference for selected scope', () => {
  const {ctx} = createCtx();
  vm.runInContext(`
    decks={
      d1:{name:'Parent::A', cards:Array.from({length:40},(_,i)=>({cid:i+1,nid:i+1,ord:0,did:'d1',fields:{Front:'A'+i}}))},
      d2:{name:'Parent::B', cards:Array.from({length:15},(_,i)=>({cid:100+i,nid:100+i,ord:0,did:'d2',fields:{Front:'B'+i}}))}
    };
    const day = todayKey();
    userSettings.newPerDeck = 20;
    userSettings.newSeenByDay = {[day]: {'Parent::A': 20, 'Parent::B': 0}};
    const before = buildStudyQueue(decks.d1.cards).length; // already at cap
    userSettings.newPerDeck = 30;
    const deckAAfterRaise = buildStudyQueue(decks.d1.cards).length; // +10 remaining
    const parentMixed = buildStudyQueue([...decks.d1.cards, ...decks.d2.cards]);
    globalThis._vals = {before, deckAAfterRaise, parentMixedLen: parentMixed.length};
  `, ctx);
  const vals = vm.runInContext('_vals', ctx);
  assert.equal(vals.before, 0);
  assert.equal(vals.deckAAfterRaise, 10);
  assert.equal(vals.parentMixedLen, 10); // parent scope has only +10 remaining after 20 already learned
});

test('deck overview addableNew is capped by unseen new cards in scope', () => {
  const {ctx} = createCtx();
  vm.runInContext(`
    decks={
      d1:{name:'Root::A', cards:Array.from({length:8},(_,i)=>({cid:i+1,nid:i+1,ord:0,did:'d1',fields:{Front:'A'+i}}))}
    };
    userSettings.newPerDeck = 20;
    userSettings.newSeenByDay = {[todayKey()]: {'Root::A': 5}};
    const counts = getCounts(decks.d1.cards);
    globalThis._counts = counts;
  `, ctx);
  const counts = vm.runInContext('_counts', ctx);
  assert.equal(counts.newC, 8);
  assert.equal(counts.addableNew, 8);
});



test('deck tree addableNew distributes parent quota across subdecks', () => {
  const {ctx} = createCtx();
  vm.runInContext(`
    decks={
      d1:{name:'Root::A', cards:Array.from({length:10},(_,i)=>({cid:i+1,nid:i+1,ord:0,did:'d1',fields:{Front:'A'+i}}))},
      d2:{name:'Root::B', cards:Array.from({length:10},(_,i)=>({cid:100+i,nid:100+i,ord:0,did:'d2',fields:{Front:'B'+i}}))}
    };
    userSettings.newPerDeck = 15;
    userSettings.newSeenByDay = {[todayKey()]: {'Root::A': 0, 'Root::B': 0}};
    const parentAlloc = allocateAddableNewByDeck([...decks.d1.cards, ...decks.d2.cards]).byDeck;
    globalThis._dist = {a: num(parentAlloc['Root::A'],0), b: num(parentAlloc['Root::B'],0)};
  `, ctx);
  const dist = vm.runInContext('_dist', ctx);
  assert.equal(dist.a, 10);
  assert.equal(dist.b, 5);
});

test('sync merge for newSeenByDay keeps max and trims to latest day', () => {
  const {ctx} = createCtx();
  const merged = vm.runInContext(`
    mergeNewSeenByDay(
      {'2026-03-27': {'Deck': 12}, '2026-03-28': {'Deck': 5}},
      {'2026-03-28': {'Deck': 18}, '2026-03-26': {'Deck': 99}}
    )
  `, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), {'2026-03-28': {'Deck': 18}});
});

test('import dedupe removes audio/text prompt collisions but keeps legit different prompts', () => {
  const {ctx} = createCtx();
  vm.runInContext(`
    const fakeDb = {
      exec(sql){
        if(sql.includes('SELECT decks,models FROM col')){
          return [{ values: [[
            JSON.stringify({'1': {name:'Root::Deck'}}),
            JSON.stringify({'10': {name:'Basic', flds:[{name:'Front'},{name:'Back'}]}})
          ]] }];
        }
        return [{ values: [
          [1, 11, '1', 0, 0, '10', 'Haus\\x1f[sound:h.mp3]home', ''],
          [2, 11, '1', 1, 0, '10', '<b>Haus</b>\\x1fhome', ''],
          [3, 12, '1', 0, 0, '10', 'Baum\\x1ftree', '']
        ]}];
      }
    };
    const r = loadDecksFromDb(fakeDb);
    globalThis._cards = r['1'].cards;
  `, ctx);
  const cards = vm.runInContext('_cards', ctx);
  assert.equal(cards.length, 2);
  assert.equal(cards.some(c => c.fields.Front.includes('Haus')), true);
  assert.equal(cards.some(c => c.fields.Front.includes('Baum')), true);
});

test('disabled deck handling stays consistent for all-learn/fun filters', () => {
  const {ctx} = createCtx();
  vm.runInContext(`
    decks={
      a:{name:'Root::A', cards:[{cid:1,nid:1,ord:0,did:'a',fields:{Front:'A'}}]},
      b:{name:'Root::B', cards:[{cid:2,nid:2,ord:0,did:'b',fields:{Front:'B'}}]}
    };
    progress['1_0'] = {type:2,due:0,interval:1,ease:2.5,reps:1,lapses:0};
    progress['2_0'] = {type:2,due:0,interval:1,ease:2.5,reps:1,lapses:0};
    userSettings.deckEnabled={'Root::B':false};
    userSettings.funModeDeckFilter='active';
    const allLearn = getAllCardsForNodeByName('Root');
    const activeFunDecks = getEligibleDecksForFunMode().map(d=>d.name);
    userSettings.funModeDeckFilter='all';
    const allFunDecks = getEligibleDecksForFunMode().map(d=>d.name);
    globalThis._res = {allLearnLen: allLearn.length, activeFunDecks, allFunDecks};
  `, ctx);
  const res = vm.runInContext('_res', ctx);
  assert.equal(res.allLearnLen, 1);
  assert.deepEqual(res.activeFunDecks, ['Root::A']);
  assert.deepEqual(res.allFunDecks.sort(), ['Root::A','Root::B']);
});

test('deckOrder migration fallback is stable and manual order is applied', () => {
  const {ctx} = createCtx();
  vm.runInContext(`
    const demo = {B:{}, A:{}};
    userSettings.deckOrder = undefined;
    const fallback = getOrderedEntries(demo, '__root__').map(([k])=>k);
    userSettings.deckOrder = {'__root__':['B','A']};
    const persisted = getOrderedEntries(demo, '__root__').map(([k])=>k);
    globalThis._order = {fallback, persisted};
  `, ctx);
  const o = vm.runInContext('_order', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(o.fallback)), ['A','B']);
  assert.deepEqual(JSON.parse(JSON.stringify(o.persisted)), ['B','A']);
});
