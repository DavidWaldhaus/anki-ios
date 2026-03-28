// ══════════════════════════════════════════════
//  GLOBALS
// ══════════════════════════════════════════════
let SQL = null, db = null;
let decks = {};
let mediaFiles = {};
let fieldConfigs = {};
let studyQueue = [], studyIdx = 0, curCard = null, flipped = false;
let sessionStats = {again:0, hard:0, good:0, easy:0};
let sessionMode = 'normal';
let ghConfig = {token:'', repo:'', user:''};
let syncState = 'idle';
const APP_VERSION = 'v3.4.0';
let userSettings = {
theme: 'auto',
newPerDeck: 20,
newOrder: 'ordered',
editMode: false,
deckEnabled: {},
funModeCount: 30,
funModeDeckFilter: 'active',
deckTreeCollapsed: {},
deckOrder: {},
funModeCustomDeck: '',
funModeCustomOrder: 'random',
};

const PROGRESS_KEY  = 'kj_progress_v3';
const FIELDCFG_KEY  = 'kj_fields_v3';
const GH_KEY        = 'kj_github_v2';
const SETTINGS_KEY  = 'kj_settings_v1';
const STATS_KEY     = 'kj_stats_v1';
const GH_TIMEOUT_MS = 10000;
let progress = {};
let studyStats = { // persistent daily stats
// date -> { studied: N, streak: N }
};

// ══════════════════════════════════════════════
//  SM-2 ALGORITHM (Anki-compatible)
// ══════════════════════════════════════════════
// type: 0=new, 1=learning/relearning, 2=review
// interval for type<2: step index (0=1min, 1=10min)
// interval for type=2: days until next review
// due: timestamp ms when card is next due

const LEARN_STEPS_MIN = [1, 10];   // learning step durations in minutes
const GRADUATING_INTERVAL = 1;     // days on first graduation
const EASY_INTERVAL = 4;           // days on Easy from new

function num(v, fallback) {
const n = Number(v);
return Number.isFinite(n) ? n : fallback;
}

function schedule(st, rating) {
const now = Date.now();
let {interval=0, ease=2.5, reps=0, lapses=0, type=0} = st || {};
interval = Math.max(0, num(interval, 0));
ease = Math.max(1.3, Math.min(3.0, num(ease, 2.5)));
reps = Math.max(0, Math.floor(num(reps, 0)));
lapses = Math.max(0, Math.floor(num(lapses, 0)));
type = [0,1,2].includes(num(type, 0)) ? num(type, 0) : 0;
let ni=interval, ne=ease, nr=reps, nl=lapses, nt=type, dueMs;

if (type < 2) {
// ── NEW / LEARNING ──────────────────────────────────────
if (rating === 1) {
// Again → back to step 0
nt=1; ni=0; dueMs = LEARN_STEPS_MIN[0] * 60000;
} else if (rating === 2) {
// Hard → stay on current step
nt=1; ni=Math.max(0, interval);
dueMs = LEARN_STEPS_MIN[Math.min(ni, LEARN_STEPS_MIN.length-1)] * 60000;
} else if (rating === 3) {
// Good → advance to next step, or graduate
const nextStep = interval + 1;
if (nextStep >= LEARN_STEPS_MIN.length) {
nt=2; ni=GRADUATING_INTERVAL; nr=1; dueMs = GRADUATING_INTERVAL * 86400000;
} else {
nt=1; ni=nextStep; dueMs = LEARN_STEPS_MIN[nextStep] * 60000;
}
} else {
// Easy → graduate immediately
nt=2; ni=EASY_INTERVAL; nr=1; dueMs = EASY_INTERVAL * 86400000;
}
} else {
// ── REVIEW ─────────────────────────────────────────────
if (rating === 1) {
// Again → back to relearning
nl=lapses+1; ne=Math.max(1.3, ease-0.2);
nt=1; ni=0; dueMs = LEARN_STEPS_MIN[0] * 60000;
} else if (rating === 2) {
// Hard
ne=Math.max(1.3, ease-0.15);
ni=Math.max(interval+1, Math.round(interval*1.2));
nr=reps+1; dueMs = ni * 86400000;
} else if (rating === 3) {
// Good
ni=Math.max(interval+1, Math.round(interval*ease));
nr=reps+1; dueMs = ni * 86400000;
} else {
// Easy
ne=Math.min(3.0, ease+0.15);
ni=Math.max(interval+1, Math.round(interval*ease*1.3));
nr=reps+1; dueMs = ni * 86400000;
}
}

return {interval:ni, ease:ne, reps:nr, lapses:nl, type:nt, due:now+dueMs};
}

function isDue(st) {
if (!st) return true;
// For learning cards (type<2): due if past their timestamp
// For review cards (type=2): due if past midnight of due date
if (st.type < 2) return Date.now() >= st.due;
// Review: due if today's date >= due date (Anki uses day boundary)
return Date.now() >= startOfDay(st.due);
}

function startOfDay(ts) {
const d = new Date(ts);
d.setHours(0,0,0,0);
return d.getTime();
}

function todayKey() {
return new Date().toISOString().slice(0,10); // YYYY-MM-DD
}

function intervalLabel(st, rating) {
const next = schedule(st, rating);
const ms = next.due - Date.now();
if(!Number.isFinite(ms)) return '-';
if (ms < 60000) return '<1m';
if (ms < 3600000) return Math.round(ms/60000)+'m';
if (ms < 86400000) return Math.round(ms/3600000)+'h';
return Math.round(ms/86400000)+'d';
}

// ══════════════════════════════════════════════
//  LOCAL STORAGE
// ══════════════════════════════════════════════
function loadLocal(){
try{progress=JSON.parse(localStorage.getItem(PROGRESS_KEY)||'{}')}catch{progress={}}
try{fieldConfigs=JSON.parse(localStorage.getItem(FIELDCFG_KEY)||'{}')}catch{fieldConfigs={}}
try{ghConfig=JSON.parse(localStorage.getItem(GH_KEY)||'{}')}catch{ghConfig={}}
try{userSettings={...userSettings,...JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')};}catch{}
try{studyStats=JSON.parse(localStorage.getItem(STATS_KEY)||'{}')}catch{studyStats={}}
ghConfig={token:'',repo:'',user:'',...ghConfig};
userSettings.deckEnabled = userSettings.deckEnabled && typeof userSettings.deckEnabled === 'object' ? userSettings.deckEnabled : {};
userSettings.funModeCount = Math.max(5, Math.min(200, num(userSettings.funModeCount, 30)));
userSettings.funModeDeckFilter = userSettings.funModeDeckFilter === 'all' ? 'all' : 'active';
userSettings.deckTreeCollapsed = userSettings.deckTreeCollapsed && typeof userSettings.deckTreeCollapsed === 'object' ? userSettings.deckTreeCollapsed : {};
userSettings.deckOrder = userSettings.deckOrder && typeof userSettings.deckOrder === 'object' ? userSettings.deckOrder : {};
userSettings.funModeCustomOrder = userSettings.funModeCustomOrder === 'ordered' ? 'ordered' : 'random';
userSettings.newSeenByDay = userSettings.newSeenByDay && typeof userSettings.newSeenByDay === 'object' ? userSettings.newSeenByDay : {};
}
function saveLocal(){
try{localStorage.setItem(PROGRESS_KEY,JSON.stringify(progress))}catch{}
try{localStorage.setItem(FIELDCFG_KEY,JSON.stringify(fieldConfigs))}catch{}
try{localStorage.setItem(GH_KEY,JSON.stringify(ghConfig))}catch{}
try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(userSettings))}catch{}
try{localStorage.setItem(STATS_KEY,JSON.stringify(studyStats))}catch{}
}
function applyTheme(){
const t = userSettings.theme;
const isDark = t==='dark' || (t==='auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
document.getElementById('theme-dark').disabled = !isDark;
document.getElementById('theme-light').disabled = isDark;
}
function cardKey(nid,ord){return`${nid}_${ord}`}
function getState(nid,ord){return progress[cardKey(nid,ord)]||null}
function setState(nid,ord,st){progress[cardKey(nid,ord)]=st;saveLocal()}

// ══════════════════════════════════════════════
//  DAILY STATS
// ══════════════════════════════════════════════
function recordStudied(count) {
const key = todayKey();
if (!studyStats[key]) studyStats[key] = {studied:0};
studyStats[key].studied += count;
saveLocal();
}

function getStreak() {
let streak = 0;
const today = new Date();
for (let i=0; i<365; i++) {
const d = new Date(today);
d.setDate(d.getDate() - i);
const key = d.toISOString().slice(0,10);
if (studyStats[key]?.studied > 0) streak++;
else if (i > 0) break; // gap → streak ends (today is ok to be 0)
}
return streak;
}

function getTodayStudied() {
return studyStats[todayKey()]?.studied || 0;
}

function isDeckEnabled(deckName){
if(!deckName) return true;
return userSettings.deckEnabled?.[deckName] !== false;
}

function touchTodayNewSeenBucket(){
const key = todayKey();
if(!userSettings.newSeenByDay || typeof userSettings.newSeenByDay !== 'object') userSettings.newSeenByDay = {};
if(!userSettings.newSeenByDay[key] || typeof userSettings.newSeenByDay[key] !== 'object') userSettings.newSeenByDay[key] = {};
const keep = {[key]: userSettings.newSeenByDay[key]};
userSettings.newSeenByDay = keep;
return userSettings.newSeenByDay[key];
}

function getNewSeenTodayForDeck(deckName){
if(!deckName) return 0;
const key = todayKey();
return num(userSettings.newSeenByDay?.[key]?.[deckName], 0);
}

function bumpNewSeenTodayForDeck(deckName, delta=1){
if(!deckName) return;
const bucket = touchTodayNewSeenBucket();
bucket[deckName] = Math.max(0, num(bucket[deckName], 0) + delta);
saveLocal();
}


function getUnseenNewCountsByDeck(cards){
const seen = new Set();
const counts = {};
for(const c of cards || []){
  if(!c || seen.has(c.cid)) continue;
  seen.add(c.cid);
  if(getState(c.nid,c.ord)) continue;
  const deckName = decks[c.did]?.name;
  if(!deckName) continue;
  counts[deckName] = (counts[deckName] || 0) + 1;
}
return counts;
}

function allocateAddableNewByDeck(cards, limit=num(userSettings.newPerDeck, 20), scopeDeckOrder=[]){
const unseenByDeck = getUnseenNewCountsByDeck(cards);
const orderedDecks = (scopeDeckOrder && scopeDeckOrder.length ? scopeDeckOrder : Object.keys(unseenByDeck).sort((a,b)=>a.localeCompare(b,'de')))
  .filter(name => unseenByDeck[name] > 0);
const fallbackDecks = Object.keys(unseenByDeck)
  .filter(name => unseenByDeck[name] > 0 && !orderedDecks.includes(name))
  .sort((a,b)=>a.localeCompare(b,'de'));
const allDecks = [...orderedDecks, ...fallbackDecks];
const seenTodayInScope = allDecks.reduce((sum, deckName)=>sum + getNewSeenTodayForDeck(deckName), 0);
let remaining = Math.max(0, Math.max(0, num(limit, 20)) - seenTodayInScope);
const byDeck = {};
for(const deckName of allDecks){
  if(remaining <= 0) break;
  const take = Math.min(unseenByDeck[deckName], remaining);
  if(take > 0){
    byDeck[deckName] = take;
    remaining -= take;
  }
}
const totalAddable = Object.values(byDeck).reduce((a,b)=>a+b,0);
return {totalAddable, byDeck, unseenByDeck};
}

function sumDeckAllocationForCards(cards, allocationByDeck){
if(!allocationByDeck) return 0;
const seen = new Set();
const deckNames = new Set();
for(const c of cards || []){
  if(!c || seen.has(c.cid)) continue;
  seen.add(c.cid);
  const deckName = decks[c.did]?.name;
  if(deckName) deckNames.add(deckName);
}
let total = 0;
for(const deckName of deckNames) total += num(allocationByDeck[deckName], 0);
return total;
}
