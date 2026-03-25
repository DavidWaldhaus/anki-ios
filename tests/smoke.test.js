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
