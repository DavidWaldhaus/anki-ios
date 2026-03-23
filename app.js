// ══════════════════════════════════════════════
//  GLOBALS
// ══════════════════════════════════════════════
let SQL = null, db = null;
let decks = {};
let mediaFiles = {};
let fieldConfigs = {};
let studyQueue = [], studyIdx = 0, curCard = null, flipped = false;
let sessionStats = {again:0, hard:0, good:0, easy:0};
let ghConfig = {token:'', repo:'', user:''};
let syncState = 'idle';
let userSettings = {
theme: 'auto',
newPerDeck: 20,
newOrder: 'ordered',
editMode: false,
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

function schedule(st, rating) {
const now = Date.now();
let {interval=0, ease=2.5, reps=0, lapses=0, type=0} = st || {};
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

// ══════════════════════════════════════════════
//  GITHUB SYNC
// ══════════════════════════════════════════════
const GH_FILE = 'kanji-progress.json';

async function ghRequest(method, path, body=null){
const {token, repo, user} = ghConfig;
if(!token||!repo||!user) throw new Error('GitHub nicht konfiguriert');
const url = `https://api.github.com/repos/${user}/${repo}/contents/${path}`;
const headers = {
'Authorization': `token ${token}`,
'Content-Type': 'application/json',
'X-GitHub-Api-Version': '2022-11-28'
};
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), GH_TIMEOUT_MS);
const opts = {method, headers, signal: controller.signal};
if(body) opts.body = JSON.stringify(body);
try{
const res = await fetch(url, opts);
if(!res.ok && res.status !== 404) throw new Error(`GitHub ${res.status}: ${res.statusText}`);
if(res.status === 404) return null;
return res.json();
}catch(err){
if(err?.name === 'AbortError') throw new Error(`GitHub Sync Timeout nach ${Math.round(GH_TIMEOUT_MS/1000)}s`);
throw err;
}finally{
clearTimeout(timeoutId);
}
}

function encodeForGH(obj) {
return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
}
function decodeFromGH(content) {
return JSON.parse(decodeURIComponent(escape(atob(content.replace(/\n/g,'')))));
}
function getSyncErrorMessage(err){
return err?.message || 'Unbekannter Sync-Fehler';
}

async function ghPushFile(path, obj, existingSha) {
const content = encodeForGH(obj);
await ghRequest('PUT', path, {
message: `Sync ${new Date().toISOString()}`,
content,
...(existingSha ? {sha: existingSha} : {})
});
}

async function ghPush(){
if(!ghConfig.token) return;
setSyncState('syncing');
try{
// Push progress
const existingProg = await ghRequest('GET', GH_FILE);
await ghPushFile(GH_FILE, progress, existingProg?.sha);

// Push field configs
const existingFields = await ghRequest('GET', 'kanji-fields.json');
await ghPushFile('kanji-fields.json', fieldConfigs, existingFields?.sha);

// Push stats
const existingStats = await ghRequest('GET', 'kanji-stats.json');
await ghPushFile('kanji-stats.json', studyStats, existingStats?.sha);

setSyncState('synced');

}catch(e){
setSyncState('error');
toast('☁️ Upload fehlgeschlagen: ' + getSyncErrorMessage(e));
console.warn('GitHub push failed:', e);
}
}

async function ghPull(){
if(!ghConfig.token) return;
setSyncState('syncing');
try{
// Pull progress - merge taking later due date
const progFile = await ghRequest('GET', GH_FILE);
if(progFile?.content){
const remote = decodeFromGH(progFile.content);
for(const [k,rv] of Object.entries(remote)){
if(!progress[k] || progress[k].due < rv.due) progress[k] = rv;
}
}

// Pull field configs - remote wins
const fieldsFile = await ghRequest('GET', 'kanji-fields.json');
if(fieldsFile?.content){
  const remoteFields = decodeFromGH(fieldsFile.content);
  for(const [did, cfg] of Object.entries(remoteFields)){
    fieldConfigs[did] = cfg;
  }
}

// Pull stats - merge taking higher studied count per day
const statsFile = await ghRequest('GET', 'kanji-stats.json');
if(statsFile?.content){
  const remoteStats = decodeFromGH(statsFile.content);
  for(const [day, data] of Object.entries(remoteStats)){
    if(!studyStats[day] || (data.studied||0) > (studyStats[day].studied||0)){
      studyStats[day] = data;
    }
  }
}

saveLocal();
setSyncState('synced');
toast('☁️ Synchronisiert!');

}catch(e){
setSyncState('error');
toast('☁️ Sync fehlgeschlagen: ' + getSyncErrorMessage(e));
console.warn('GitHub pull failed:', e);
}
}

function setSyncState(state){
syncState = state;
const dot = document.getElementById('syncDot');
const lbl = document.getElementById('syncLabel');
if(!dot) return;
dot.className = 'sync-dot ' + (state==='idle'?'':state);
lbl.textContent = state==='syncing'?'...':state==='synced'?'Sync ✓':state==='error'?'Sync ✗':'';
}

let pushTimer;
function schedulePush(){
if(!ghConfig.token) return;
clearTimeout(pushTimer);
pushTimer = setTimeout(ghPush, 3000);
}

// ══════════════════════════════════════════════
//  SQL.JS
// ══════════════════════════════════════════════
async function initSQL(){
setMsg('Engine laden...');
SQL = await initSqlJs({locateFile:f=>`https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`});
}

// ══════════════════════════════════════════════
//  IMPORT
// ══════════════════════════════════════════════
function triggerImport(){document.getElementById('fileInput').click()}
async function handleFile(e){
const f=e.target.files[0];
if(f) await importApkg(f);
e.target.value='';
}

async function importApkg(file){
showLoader('Importieren...');
try{
setMsg('Entpacken...');
const zip = await JSZip.loadAsync(file);
const dbEntry = zip.file('collection.anki21') || zip.file('collection.anki2') || zip.file('collection.anki21b');
if(!dbEntry) throw new Error('Keine Anki-Datenbank gefunden.');
setMsg('Datenbank lesen...');
const buf = await dbEntry.async('arraybuffer');
const newDb = new SQL.Database(new Uint8Array(buf));

setMsg('Medien laden...');
const mediaJson = zip.file('media');
if(mediaJson){
  const mediaMap = JSON.parse(await mediaJson.async('string'));
  for(const [idx, name] of Object.entries(mediaMap)){
    const entry = zip.file(idx);
    if(entry){
      const blob = await entry.async('blob');
      mediaFiles[name] = URL.createObjectURL(blob);
    }
  }
}

setMsg('Karten laden...');
const newDecks = loadDecksFromDb(newDb);
for(const [did, deck] of Object.entries(newDecks)) decks[did] = deck;
if(!window.allDbs) window.allDbs = [];
window.allDbs.push(newDb);
db = newDb;

hideLoader();
renderHome();
toast('✅ ' + Object.keys(newDecks).length + ' Deck(s) importiert');

}catch(err){
hideLoader();
toast('❌ '+err.message);
console.error(err);
}
}

// ══════════════════════════════════════════════
//  DECK PARSING
// ══════════════════════════════════════════════
function loadDecksFromDb(dbInst){
const result = {};
const col = dbInst.exec('SELECT decks,models FROM col LIMIT 1');
if(!col.length) return result;
const deckDef = JSON.parse(col[0].values[0][0]);
const modelDef = JSON.parse(col[0].values[0][1]);
const models = {};
for(const[mid,m] of Object.entries(modelDef)){
models[mid] = {name:m.name, fields:m.flds.map(f=>f.name)};
}
const rows = dbInst.exec(`SELECT c.id,c.nid,c.did,c.ord,c.type,n.mid,n.flds,n.tags FROM cards c JOIN notes n ON c.nid=n.id`);
if(!rows.length) return result;
for(const[cid,nid,did,ord,type,mid,flds,tags] of rows[0].values){
const dn = deckDef[did]?.name || 'Unbekannt';
if(!result[did]) result[did]={name:dn,cards:[],fields:[]};
const model = models[mid]||{fields:[]};
const vals = flds.split('\x1f');
const fields={};
model.fields.forEach((n,i)=>fields[n]=vals[i]||'');
if(!result[did].fields.length) result[did].fields=model.fields;
result[did].cards.push({cid,nid,did,ord,type,fields,tags:tags||''});
}
return result;
}

function loadDecks(){
const newDecks = loadDecksFromDb(db);
for(const [did, deck] of Object.entries(newDecks)) decks[did] = deck;
}

// ══════════════════════════════════════════════
//  FIELD CONFIG
// ══════════════════════════════════════════════
function getFieldConfig(did){
if(fieldConfigs[did]){
const cfg = fieldConfigs[did];
if(typeof cfg.front === 'string') cfg.front = cfg.front ? [cfg.front] : [];
return cfg;
}
const deck = decks[did];
if(!deck) return {front:[],back:[],hidden:[]};
const fields = deck.fields;
const frontCandidates = ['Expression','Front','Word','Vocab','単語','表現','Kanji','漢字','Question','Term'];
const hiddenCandidates = ['Index','Frequency','optimized voc index','voc index','Optimized Voc Index','Note ID','ID','Notes','Diagram','Stroke Order','Stroke','KanjiReadings'];
let front = fields[0];
for(const c of frontCandidates){ if(fields.includes(c)){front=c;break} }
const hidden = fields.filter(f=>hiddenCandidates.some(h=>f.toLowerCase().includes(h.toLowerCase())));
const back = fields.filter(f=>f!==front && !hidden.includes(f));
return {front:[front], back, hidden};
}

// ══════════════════════════════════════════════
//  DECK TREE
// ══════════════════════════════════════════════
function buildDeckTree() {
const tree = {};
for(const [did, deck] of Object.entries(decks)) {
const parts = deck.name.split('::');
let node = tree;
let path = '';
for(let i=0; i<parts.length; i++) {
const part = parts[i];
path = path ? path+'::'+part : part;
if(!node[part]) node[part] = {did:null, fullName:path, displayName:part, children:{}, allCards:[]};
if(i === parts.length-1) {
node[part].did = did;
node[part].allCards.push(...deck.cards);
}
node = node[part].children;
}
}
function bubbleCards(nodeMap) {
for(const node of Object.values(nodeMap)) {
bubbleCards(node.children);
for(const child of Object.values(node.children)) {
node.allCards.push(...child.allCards);
}
}
}
bubbleCards(tree);
return tree;
}

function getAllCardsForNodeByName(fullName) {
const tree = buildDeckTree();
const parts = fullName.split('::');
let node = tree;
for(const p of parts) {
if(!node[p]) return [];
const isLast = p === parts[parts.length-1];
if(isLast) return node[p].allCards;
node = node[p].children;
}
return [];
}

function getCounts(cards){
const seen = new Set();
let newC=0, lrnC=0, revC=0;
for(const c of cards){
if(seen.has(c.cid)) continue;
seen.add(c.cid);
const st=getState(c.nid,c.ord);
if(!st){ newC++; continue; }
if(!isDue(st)) continue;
if(st.type===2) revC++; else lrnC++;
}
return{newC,lrnC,revC};
}

function getDeckProgress(cards) {
const seen = new Set();
let total=0, graduated=0;
for(const c of cards){
if(seen.has(c.cid)) continue;
seen.add(c.cid);
total++;
const st=getState(c.nid,c.ord);
if(st && st.type===2) graduated++;
}
return {total, graduated, pct: total ? Math.round(graduated/total*100) : 0};
}

// ══════════════════════════════════════════════
//  HOME RENDER
// ══════════════════════════════════════════════
function toggleEditMode(){
userSettings.editMode = !userSettings.editMode;
saveLocal();
const btn = document.getElementById('editModeBtn');
if(btn){
btn.style.background = userSettings.editMode ? '#6e66ff' : '';
btn.style.color = userSettings.editMode ? '#fff' : '';
}
renderHome();
}
function applyEditModeBtn(){
const btn = document.getElementById('editModeBtn');
if(!btn) return;
btn.style.background = userSettings.editMode ? '#6e66ff' : '';
btn.style.color = userSettings.editMode ? '#fff' : '';
}

function renderHome(){
const el = document.getElementById('deckListEl');
if(!db||!Object.keys(decks).length){
el.innerHTML=` <div class="import-strip" onclick="triggerImport()"> <div class="import-strip-icon">🎌</div> <div class="import-strip-text"> <div class="import-strip-title">Anki-Deck importieren</div> <div class="import-strip-sub">.apkg Datei aus Anki Desktop exportieren</div> </div> <span style="color:#4a4a66;font-size:18px">›</span> </div> <div class="empty"> <div class="empty-icon">📚</div> <h3>Noch keine Decks</h3> <p>Exportiere dein Deck in Anki Desktop über<br><b>Datei → Exportieren → .apkg</b></p> </div>`;
document.getElementById('statsRow').style.display='none';
return;
}

let tNew=0,tLrn=0,tRev=0;
for(const deck of Object.values(decks)){
const{newC,lrnC,revC}=getCounts(deck.cards);
tNew+=newC; tLrn+=lrnC; tRev+=revC;
}

// Today's streak bar
const streak = getStreak();
const todayStudied = getTodayStudied();
let html = `

  <div style="background:#1a1a24;border:1.5px solid #2c2c3e;border-radius:16px;padding:14px 16px;margin-bottom:14px;display:flex;align-items:center;gap:14px">
    <div style="font-size:28px">🔥</div>
    <div style="flex:1">
      <div style="font-size:15px;font-weight:700;color:#f0f0f8">${streak} Tag${streak!==1?'e':''} Streak</div>
      <div style="font-size:12px;color:#8888aa;margin-top:2px">Heute: ${todayStudied} Karten gelernt</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:11px;color:#4a4a66;font-weight:600">${new Date().toLocaleDateString('de-DE',{weekday:'short',day:'numeric',month:'short'})}</div>
    </div>
  </div>
  <div class="import-strip" onclick="triggerImport()" style="margin-bottom:14px">
    <div class="import-strip-icon">📦</div>
    <div class="import-strip-text">
      <div class="import-strip-title">Weiteres Deck laden</div>
      <div class="import-strip-sub">.apkg importieren</div>
    </div>
  </div><div class="sect">Meine Decks</div>`;

const tree = buildDeckTree();
for(const node of Object.values(tree)) {
html += renderDeckNode(node, 0);
}

el.innerHTML=html;
document.getElementById('statsRow').style.display='grid';
document.getElementById('sNew').textContent=tNew;
document.getElementById('sLrn').textContent=tLrn;
document.getElementById('sRev').textContent=tRev;
}

function renderDeckNode(node, depth=0) {
const hasChildren = Object.keys(node.children).length > 0;
const cards = node.allCards;
const {newC,lrnC,revC} = getCounts(cards);
const prog = getDeckProgress(cards);
const EMOJIS = ['🎌','📖','✍️','🗾','📝','🎋','⛩️','🌸','📚','🈳'];
const emoji = EMOJIS[Math.abs(node.fullName.length * 7) % EMOJIS.length];
const indent = depth * 16;
const nodeId = 'node_' + node.fullName.replace(/[^a-zA-Z0-9]/g,'_');

let html = '';
if(hasChildren) {
html += `<div class="deck-card deck-parent" style="margin-left:${indent}px" onclick="toggleDeckNode('${nodeId}')"> <span class="deck-emoji">${emoji}</span> <div class="deck-info"> <div class="deck-name">${esc(node.displayName)}</div> <div class="deck-sub">${cards.length} Karten · ${prog.pct}% gelernt</div> <div style="height:3px;background:#2c2c3e;border-radius:3px;margin-top:6px;overflow:hidden"> <div style="height:100%;width:${prog.pct}%;background:#6e66ff;border-radius:3px;transition:width .4s"></div> </div> <div class="deck-pills" style="margin-top:6px"> <span class="pill ${newC?'pill-new':'pill-0'}">${newC} neu</span> <span class="pill ${lrnC?'pill-lrn':'pill-0'}">${lrnC} lernen</span> <span class="pill ${revC?'pill-rev':'pill-0'}">${revC} wdh.</span> </div> </div> <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0"> <div style="display:flex;gap:6px;align-items:center"> ${userSettings.editMode ? `<button onclick="event.stopPropagation();showFieldModalForGroup('${esc(node.fullName)}')"
style="background:#20202c;color:#a89fff;border:1.5px solid #2c2c3e;border-radius:10px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">
⚙️ Felder</button>` : ''} <button onclick="event.stopPropagation();startStudyCards(getAllCardsForNodeByName('${esc(node.fullName)}'),'${esc(node.displayName)}')" style="background:#6e66ff;color:#fff;border:none;border-radius:10px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap"> ▶ Alle lernen</button> </div> <span class="deck-arr" id="${nodeId}_arrow">›</span> </div> </div>`;
html += `<div id="${nodeId}_children" style="display:none">`;
for(const child of Object.values(node.children)) {
html += renderDeckNode(child, depth+1);
}
if(node.did) html += renderLeafDeck(node.did, decks[node.did], depth+1);
html += `</div>`;
} else {
if(node.did) html += renderLeafDeck(node.did, decks[node.did], depth);
}
return html;
}

function renderLeafDeck(did, deck, depth=0) {
const {newC,lrnC,revC} = getCounts(deck.cards);
const prog = getDeckProgress(deck.cards);
const EMOJIS = ['🎌','📖','✍️','🗾','📝','🎋','⛩️','🌸','📚','🈳'];
const emoji = EMOJIS[Math.abs(did * 7) % EMOJIS.length];
const indent = depth * 16;
const name = deck.name.split('::').pop();
return `<div class="deck-card" style="margin-left:${indent}px" onclick="startStudy('${did}')">
<span class="deck-emoji" style="font-size:22px">${emoji}</span>
<div class="deck-info">
<div class="deck-name" style="font-size:14px">${esc(name)}</div>
<div class="deck-sub">${deck.cards.length} Karten · ${prog.pct}%${userSettings.editMode ? ' · <span style="cursor:pointer;color:#a89fff;text-decoration:underline" onclick="event.stopPropagation();showFieldModal(\''+did+'\')">Felder</span>' : ''}</div>
<div style="height:3px;background:#2c2c3e;border-radius:3px;margin-top:5px;overflow:hidden">
<div style="height:100%;width:${prog.pct}%;background:#6e66ff;border-radius:3px"></div>
</div>
<div class="deck-pills" style="margin-top:5px">
<span class="pill ${newC?'pill-new':'pill-0'}">${newC} neu</span>
<span class="pill ${lrnC?'pill-lrn':'pill-0'}">${lrnC} lernen</span>
<span class="pill ${revC?'pill-rev':'pill-0'}">${revC} wdh.</span>
</div>
</div>
<span class="deck-arr">›</span>

  </div>`;
}

function toggleDeckNode(nodeId) {
const el = document.getElementById(nodeId + '_children');
const arrow = document.getElementById(nodeId + '_arrow');
if(!el) return;
const open = el.style.display === 'none';
el.style.display = open ? 'block' : 'none';
if(arrow) arrow.textContent = open ? '⌄' : '›';
}

// ══════════════════════════════════════════════
//  FIELD CONFIG MODAL
// ══════════════════════════════════════════════
let editingDid = null, tempConfig = null;

function getSubDeckIds(fullName) {
const ids = [];
for(const [did, deck] of Object.entries(decks)){
if(deck.name === fullName || deck.name.startsWith(fullName + '::')) ids.push(did);
}
return ids;
}

function showFieldModalForGroup(fullName) {
const subIds = getSubDeckIds(fullName);
if(!subIds.length) return;
const firstDeck = decks[subIds[0]];
if(!firstDeck) return;
const cfg = getFieldConfig(subIds[0]);
editingDid = subIds[0];
tempConfig = JSON.parse(JSON.stringify(cfg));
window._editingGroupIds = subIds;
const groupName = fullName.split('::').pop();
document.getElementById('fieldModalTitle').textContent = '⚙️ Felder für alle: ' + groupName;
renderFieldModal(firstDeck.fields);
const footer = document.getElementById('fieldModal').querySelector('.modal-footer');
footer.innerHTML = '<div style="font-size:12px;color:#8888aa;margin-bottom:10px;text-align:center">Gilt für alle ' + subIds.length + ' Unterdecks</div>' +
'<button class="primary-btn" style="width:100%" onclick="saveFieldConfigForGroup()">Für alle speichern</button>';
openModal('fieldModal');
}

function saveFieldConfigForGroup() {
const ids = window._editingGroupIds || [];
for(const did of ids) fieldConfigs[did] = JSON.parse(JSON.stringify(tempConfig));
window._editingGroupIds = null;
saveLocal();
closeModal('fieldModal');
document.getElementById('fieldModal').querySelector('.modal-footer').innerHTML =
'<button class="primary-btn" style="width:100%" onclick="saveFieldConfig()">Speichern</button>';
toast('✅ Felder für alle Unterdecks gespeichert');
renderHome();
schedulePush();
}

function showFieldModal(did){
editingDid = did;
window._editingGroupIds = null;
const deck = decks[did];
const cfg = getFieldConfig(did);
tempConfig = JSON.parse(JSON.stringify(cfg));
document.getElementById('fieldModal').querySelector('.modal-footer').innerHTML =
'<button class="primary-btn" style="width:100%" onclick="saveFieldConfig()">Speichern</button>';
document.getElementById('fieldModalTitle').textContent = '⚙️ Felder: '+deck.name.split('::').pop();
renderFieldModal(deck.fields);
openModal('fieldModal');
}

function renderFieldModal(fields){
if(!Array.isArray(tempConfig.front)) tempConfig.front = tempConfig.front ? [tempConfig.front] : [];
if(!Array.isArray(tempConfig.back)) tempConfig.back = tempConfig.back || [];
const allAssigned = [...tempConfig.front, ...tempConfig.back, ...tempConfig.hidden];
for(const f of fields){ if(!allAssigned.includes(f)) tempConfig.back.push(f); }

function fieldRow(f, role, idx, listId){
return `<div class="field-row sortable-item" data-field="${esc(f)}" data-role="${role}" data-idx="${idx}" data-list="${listId}" draggable="true" ondragstart="dragStart(event)" ondragover="dragOver(event)" ondrop="dragDrop(event)" ondragend="dragEnd(event)" ontouchstart="touchStart(event)" ontouchmove="touchMove(event)" ontouchend="touchEnd(event)"> <span class="field-drag">⠿</span> <div class="field-info"> <div class="field-name">${esc(f)}</div> <div class="field-role field-role-${role}">${roleLabel(role)}</div> </div> <div class="field-actions"> <button class="field-action-btn ${role==='front'?'active-front':''}" onclick="setFieldRole('${esc(f)}','front')">Vorne</button> <button class="field-action-btn ${role==='back'?'active-back':''}" onclick="setFieldRole('${esc(f)}','back')">Hinten</button> <button class="field-action-btn ${role==='hidden'?'active-hide':''}" onclick="setFieldRole('${esc(f)}','hidden')">Aus</button> </div> </div>`;
}

let html = `<div style="margin-bottom:14px;font-size:13px;color:#8888aa;line-height:1.5">
Tippe auf <b>Vorne/Hinten/Aus</b> um Felder zuzuweisen.<br>
Ziehe <b>⠿</b> um die Reihenfolge anzupassen.

  </div>`;

if(tempConfig.front.length){
html += `<div class="sort-section-label">▶ Vorderseite</div><div class="sortable-list" id="list-front">`;
tempConfig.front.forEach((f,i) => html += fieldRow(f,'front',i,'front'));
html += `</div>`;
}
if(tempConfig.back.length){
html += `<div class="sort-section-label" style="margin-top:14px">↩ Rückseite</div><div class="sortable-list" id="list-back">`;
tempConfig.back.forEach((f,i) => html += fieldRow(f,'back',i,'back'));
html += `</div>`;
}
if(tempConfig.hidden.length){
html += `<div class="sort-section-label" style="margin-top:14px">✕ Versteckt</div><div class="sortable-list" id="list-hidden">`;
tempConfig.hidden.forEach((f,i) => html += fieldRow(f,'hidden',i,'hidden'));
html += `</div>`;
}
document.getElementById('fieldContent').innerHTML = html;
}

function roleLabel(r){return r==='front'?'▶ Vorderseite':r==='back'?'↩ Rückseite':'✕ Versteckt'}

function setFieldRole(field, role){
const deck = decks[editingDid];
if(!Array.isArray(tempConfig.front)) tempConfig.front = tempConfig.front ? [tempConfig.front] : [];
if(role==='front'){
if(tempConfig.front.includes(field)){
tempConfig.front = tempConfig.front.filter(f=>f!==field);
if(!tempConfig.back.includes(field)) tempConfig.back.push(field);
} else {
tempConfig.front.push(field);
tempConfig.back = tempConfig.back.filter(f=>f!==field);
tempConfig.hidden = tempConfig.hidden.filter(f=>f!==field);
}
} else if(role==='back'){
tempConfig.front = tempConfig.front.filter(f=>f!==field);
tempConfig.hidden = tempConfig.hidden.filter(f=>f!==field);
if(!tempConfig.back.includes(field)) tempConfig.back.push(field);
} else {
tempConfig.front = tempConfig.front.filter(f=>f!==field);
tempConfig.back = tempConfig.back.filter(f=>f!==field);
if(!tempConfig.hidden.includes(field)) tempConfig.hidden.push(field);
}
renderFieldModal(deck.fields);
}

// ══════════════════════════════════════════════
//  DRAG & DROP / TOUCH SORT
// ══════════════════════════════════════════════
let dragSrc = null, dragSrcList = null;

function getListArray(listId){
if(listId==='front') return tempConfig.front;
if(listId==='back') return tempConfig.back;
return tempConfig.hidden;
}
function dragStart(e){
dragSrc = e.currentTarget; dragSrcList = dragSrc.dataset.list;
e.dataTransfer.effectAllowed = 'move';
setTimeout(()=>dragSrc.style.opacity='0.4', 0);
}
function dragEnd(e){
e.currentTarget.style.opacity='1';
document.querySelectorAll('.sortable-item').forEach(el=>el.classList.remove('drag-over-item'));
}
function dragOver(e){
e.preventDefault(); e.dataTransfer.dropEffect = 'move';
document.querySelectorAll('.sortable-item').forEach(el=>el.classList.remove('drag-over-item'));
e.currentTarget.classList.add('drag-over-item');
}
function dragDrop(e){
e.preventDefault();
const target = e.currentTarget;
if(target===dragSrc) return;
const srcArr = getListArray(dragSrc.dataset.list);
const srcIdx = srcArr.indexOf(dragSrc.dataset.field);
if(srcIdx>-1) srcArr.splice(srcIdx,1);
const tgtArr = getListArray(target.dataset.list);
const tgtIdx = tgtArr.indexOf(target.dataset.field);
tgtArr.splice(tgtIdx,0,dragSrc.dataset.field);
renderFieldModal(decks[editingDid].fields);
}

let touchItem=null, touchClone=null, touchStartY=0;
function touchStart(e){
const item = e.currentTarget;
const handle = item.querySelector('.field-drag');
const touch = e.touches[0];
const hr = handle.getBoundingClientRect();
if(touch.clientX < hr.left-10 || touch.clientX > hr.right+10) return;
e.preventDefault();
touchItem = item; touchStartY = touch.clientY;
touchClone = item.cloneNode(true);
touchClone.style.cssText = `position:fixed;left:${item.getBoundingClientRect().left}px;top:${item.getBoundingClientRect().top}px;width:${item.offsetWidth}px;opacity:0.85;z-index:999;pointer-events:none;background:#272734;border:1px solid #6e66ff;border-radius:14px;transition:none`;
document.body.appendChild(touchClone);
item.style.opacity='0.3';
}
function touchMove(e){
if(!touchItem||!touchClone) return;
e.preventDefault();
const touch = e.touches[0];
const dy = touch.clientY - touchStartY;
touchClone.style.top = (touchItem.getBoundingClientRect().top + window.scrollY + dy) + 'px';
touchClone.style.display='none';
const el = document.elementFromPoint(touch.clientX, touch.clientY);
touchClone.style.display='';
document.querySelectorAll('.sortable-item').forEach(i=>i.classList.remove('drag-over-item'));
el?.closest('.sortable-item')?.classList.add('drag-over-item');
}
function touchEnd(e){
if(!touchItem||!touchClone) return;
const touch = e.changedTouches[0];
touchClone.style.display='none';
const el = document.elementFromPoint(touch.clientX, touch.clientY);
touchClone.remove(); touchClone=null; touchItem.style.opacity='1';
const overItem = el?.closest('.sortable-item');
if(overItem && overItem!==touchItem){
const srcArr = getListArray(touchItem.dataset.list);
const srcIdx = srcArr.indexOf(touchItem.dataset.field);
if(srcIdx>-1) srcArr.splice(srcIdx,1);
const tgtArr = getListArray(overItem.dataset.list);
const tgtIdx = tgtArr.indexOf(overItem.dataset.field);
tgtArr.splice(tgtIdx,0,touchItem.dataset.field);
}
touchItem=null;
renderFieldModal(decks[editingDid].fields);
}

function saveFieldConfig(){
fieldConfigs[editingDid] = tempConfig;
saveLocal(); closeModal('fieldModal');
toast('✅ Felder gespeichert'); renderHome(); schedulePush();
}

// ══════════════════════════════════════════════
//  SETTINGS MODAL
// ══════════════════════════════════════════════
function showSettings(){
const s = userSettings;
const syncOk = ghConfig.token && ghConfig.repo && ghConfig.user;
document.getElementById('settingsContent').innerHTML=` <div class="settings-group"> <div class="settings-group-title">Erscheinungsbild</div> <div class="settings-card"> <div class="settings-row"> <div class="settings-row-info"> <div class="settings-row-title">Darstellung</div> <div class="settings-row-sub">Hell, Dunkel oder wie das iPhone</div> </div> <div class="segment" id="themeSegment"> <button class="seg-btn ${s.theme==='light'?'active':''}" onclick="setTheme('light')">Hell</button> <button class="seg-btn ${s.theme==='auto'?'active':''}" onclick="setTheme('auto')">Auto</button> <button class="seg-btn ${s.theme==='dark'?'active':''}" onclick="setTheme('dark')">Dunkel</button> </div> </div> </div> </div> <div class="settings-group"> <div class="settings-group-title">Lernen</div> <div class="settings-card"> <div class="settings-row"> <div class="settings-row-info"> <div class="settings-row-title">Neue Karten pro Sitzung</div> <div class="settings-row-sub">Pro Deck, zusätzlich zu fälligen Karten</div> </div> <div class="stepper"> <button class="stepper-btn" onclick="adjustNew(-5)">-</button> <div class="stepper-val" id="newPerDeckVal">${s.newPerDeck}</div> <button class="stepper-btn" onclick="adjustNew(+5)">+</button> </div> </div> <div class="settings-row"> <div class="settings-row-info"> <div class="settings-row-title">Reihenfolge neue Karten</div> <div class="settings-row-sub">Geordnet = Deck-Reihenfolge (empfohlen)</div> </div> <div class="segment" id="orderSegment"> <button class="seg-btn ${s.newOrder==='ordered'?'active':''}" onclick="setOrder('ordered')">Geordnet</button> <button class="seg-btn ${s.newOrder==='random'?'active':''}" onclick="setOrder('random')">Zufällig</button> </div> </div> </div> </div> <div class="settings-group"> <div class="settings-group-title">☁️ GitHub Sync</div> <div class="settings-card" style="padding:16px"> <div style="font-size:13px;color:#8888aa;margin-bottom:14px;line-height:1.6"> Fortschritt wird automatisch zwischen iPhone, iPad und Mac synchronisiert. Anfragen brechen nach 10s mit einer Fehlermeldung ab, statt unbegrenzt zu hängen. </div> <div style="display:flex;flex-direction:column;gap:12px"> <div><label class="s-label">GitHub Benutzername</label> <input class="s-input" id="ghUser" placeholder="deinusername" value="${esc(ghConfig.user||'')}"></div> <div><label class="s-label">Repository Name</label> <input class="s-input" id="ghRepo" placeholder="kanji" value="${esc(ghConfig.repo||'')}"></div> <div><label class="s-label">Personal Access Token</label> <input class="s-input" id="ghToken" type="password" placeholder="ghp_xxxxxxxxxxxx" value="${esc(ghConfig.token||'')}"> <div class="s-hint">Settings → Developer settings → Personal access tokens → <b>repo</b></div> </div> </div> <button class="s-btn accent" onclick="saveGHConfig()">Speichern & verbinden</button> ${syncOk?`<button class="s-btn" onclick="ghPull().then(()=>renderHome())">⬇️ Jetzt synchronisieren</button>
<button class="s-btn" onclick="ghPush()">⬆️ Jetzt hochladen</button>`:''} <div id="syncTestResult"></div> </div> </div> <div class="settings-group"> <div class="settings-group-title">💾 Fortschritt</div> <div class="settings-card" style="padding:16px"> <div id="progressSummary" style="margin-bottom:14px"></div> <div style="display:flex;flex-direction:column;gap:8px"> <button class="s-btn accent" onclick="exportProgress()">📤 Backup exportieren (.json)</button> <button class="s-btn" onclick="document.getElementById('importProgressInput').click()">📥 Backup importieren</button> <input type="file" id="importProgressInput" accept=".json" style="display:none" onchange="importProgressFile(event)"> <button class="s-btn" onclick="testProgressIntegrity()">🔍 Backup testen</button> <button class="s-btn danger" onclick="confirmReset()">🗑️ Fortschritt zurücksetzen</button> </div> </div> </div> `;
openModal('settingsModal');
setTimeout(renderProgressSummary, 50);
}

function setTheme(t){
userSettings.theme = t; saveLocal(); applyTheme();
document.querySelectorAll('#themeSegment .seg-btn').forEach((b,i)=>{
b.classList.toggle('active', ['light','auto','dark'][i]===t);
});
}
function adjustNew(delta){
userSettings.newPerDeck = Math.max(1, Math.min(100, (userSettings.newPerDeck||20) + delta));
saveLocal();
const el = document.getElementById('newPerDeckVal');
if(el) el.textContent = userSettings.newPerDeck;
}
function setOrder(o){
userSettings.newOrder = o; saveLocal();
document.querySelectorAll('#orderSegment .seg-btn').forEach((b,i)=>{
b.classList.toggle('active', ['ordered','random'][i]===o);
});
}

async function saveGHConfig(){
ghConfig.user = document.getElementById('ghUser').value.trim();
ghConfig.repo = document.getElementById('ghRepo').value.trim();
ghConfig.token = document.getElementById('ghToken').value.trim();
saveLocal();
const res = document.getElementById('syncTestResult');
res.innerHTML='<div class="status-badge status-info">Verbindung testen...</div>';
try{
const r = await fetch(`https://api.github.com/repos/${ghConfig.user}/${ghConfig.repo}`,{
headers:{'Authorization':`token ${ghConfig.token}`}
});
if(r.ok){
res.innerHTML='<div class="status-badge status-ok">✅ Verbindung erfolgreich!</div>';
showSettings(); ghPull();
} else {
res.innerHTML=`<div class="status-badge status-err">❌ Fehler ${r.status} - Token oder Repo prüfen</div>`;
}
}catch(e){
res.innerHTML='<div class="status-badge status-err">❌ Netzwerkfehler</div>';
}
}

function exportProgress(){
const blob = new Blob([JSON.stringify(progress,null,2)],{type:'application/json'});
const a = document.createElement('a');
a.href = URL.createObjectURL(blob); a.download = 'kanji-progress.json'; a.click();
}
function importProgressFile(e){
const f = e.target.files[0]; if(!f) return;
const r = new FileReader();
r.onload = ()=>{
try{ const data = JSON.parse(r.result); Object.assign(progress, data); saveLocal(); toast('✅ Fortschritt importiert'); renderHome(); }
catch{ toast('❌ Ungültige Datei') }
};
r.readAsText(f); e.target.value='';
}
function confirmReset(){
if(confirm('Wirklich ALLEN Fortschritt löschen? Das kann nicht rückgängig gemacht werden.')){
progress={}; saveLocal(); toast('🗑️ Fortschritt gelöscht'); renderHome(); closeModal('settingsModal');
}
}

function getProgressSummary() {
const keys = Object.keys(progress);
let learned=0, due=0, mature=0;
for(const k of keys) {
const st = progress[k];
if(!st) continue;
if(st.type===2 && st.interval>=21) mature++;
if(isDue(st)) due++; else learned++;
}
return { total:keys.length, learned, due, mature };
}

function renderProgressSummary() {
const el = document.getElementById('progressSummary');
if(!el) return;
const s = getProgressSummary();
const syncOk = ghConfig.token && ghConfig.repo && ghConfig.user;
const streak = getStreak();
const todayN = getTodayStudied();
if(s.total === 0) {
el.innerHTML = `<div style="font-size:13px;color:#8888aa;text-align:center;padding:8px 0">Noch kein Fortschritt. Fang an zu lernen! 🎌</div>`;
return;
}
el.innerHTML = ` <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px"> <div style="background:#1e1b3a;border:1px solid #6e66ff;border-radius:12px;padding:12px;text-align:center"> <div style="font-size:22px;font-weight:800;color:#a89fff">${s.total}</div> <div style="font-size:10px;color:#8888aa;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Gesamt</div> </div> <div style="background:#0e2a1e;border:1px solid #1a6644;border-radius:12px;padding:12px;text-align:center"> <div style="font-size:22px;font-weight:800;color:#3ecf8e">${s.mature}</div> <div style="font-size:10px;color:#8888aa;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Reif (21d+)</div> </div> <div style="background:#2d2010;border:1px solid #7a5510;border-radius:12px;padding:12px;text-align:center"> <div style="font-size:22px;font-weight:800;color:#ffaa44">${s.due}</div> <div style="font-size:10px;color:#8888aa;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Fällig heute</div> </div> <div style="background:#1e1b3a;border:1px solid #6e66ff;border-radius:12px;padding:12px;text-align:center"> <div style="font-size:22px;font-weight:800;color:#6e66ff">🔥${streak}</div> <div style="font-size:10px;color:#8888aa;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Tage Streak</div> </div> </div> <div style="font-size:12px;padding:10px 12px;border-radius:10px;margin-bottom:6px;background:#1a1a24;color:#8888aa;border:1px solid #2c2c3e"> 📅 Heute gelernt: <b style="color:#f0f0f8">${todayN} Karten</b> </div> <div style="font-size:12px;padding:10px 12px;border-radius:10px;${syncOk?'background:#0e2a1e;color:#3ecf8e;border:1px solid #1a6644':'background:#2d2010;color:#ffaa44;border:1px solid #7a5510'}"> ${syncOk?'☁️ GitHub Sync aktiv':'⚠️ Kein GitHub Sync - bitte regelmäßig exportieren!'} </div>`;
}

function testProgressIntegrity() {
try{
const json = JSON.stringify(progress);
const parsed = JSON.parse(json);
const ok = Object.keys(progress).length === Object.keys(parsed).length;
const s = getProgressSummary();
if(ok) toast('✅ ' + Object.keys(progress).length + ' Einträge OK - Backup ist sicher');
else toast('❌ Integrität fehlgeschlagen');
}catch(e){ toast('❌ ' + e.message); }
}

// ══════════════════════════════════════════════
//  STUDY SESSION
// ══════════════════════════════════════════════
function buildStudyQueue(cards) {
window._sessionStart = Date.now();
const seen = new Set();
const learning = [], due = [], newCards = [];

for(const c of cards){
if(seen.has(c.cid)) continue;
seen.add(c.cid);
const st = getState(c.nid, c.ord);
if(!st){
newCards.push(c);
} else if(isDue(st)){
if(st.type < 2) learning.push(c);
else due.push(c);
}
}

shuffle(due);
if(userSettings.newOrder==='random') shuffle(newCards);
const maxNew = userSettings.newPerDeck || 20;
// Learning cards first (already in progress), then reviews, then new
return [...learning, ...due, ...newCards.slice(0, maxNew)];
}

function startStudy(did){
const deck = decks[did];
if(!deck) return;
sessionStats={again:0,hard:0,good:0,easy:0};
window._sessionRequeues = {};
studyQueue=buildStudyQueue(deck.cards);
studyIdx=0;
if(!studyQueue.length){
document.getElementById('studyTitle').textContent=deck.name.split('::').pop();
showDone(true); showScreen('studyScreen'); return;
}
document.getElementById('studyTitle').textContent=deck.name.split('::').pop();
showScreen('studyScreen');
nextCard();
}

function startStudyCards(cards, name) {
if(!cards.length) { toast('Keine Karten zum Lernen'); return; }
sessionStats={again:0,hard:0,good:0,easy:0};
window._sessionRequeues = {};
studyQueue=buildStudyQueue(cards);
studyIdx=0;
if(!studyQueue.length){
document.getElementById('studyTitle').textContent=name;
showDone(true); showScreen('studyScreen'); return;
}
document.getElementById('studyTitle').textContent=name;
showScreen('studyScreen');
nextCard();
}

function nextCard(){
if(studyIdx>=studyQueue.length){ showDone(false); return; }
curCard=studyQueue[studyIdx];
flipped=false;
updateProgress();
renderCard();
renderAns(false);
}

function updateProgress(){
const rem=studyQueue.length-studyIdx;
document.getElementById('studyCount').textContent=rem+' übrig';
const pct=studyIdx/studyQueue.length*100;
document.getElementById('progFill').style.width=pct+'%';
}

function renderCard(){
const c=curCard;
const st=getState(c.nid,c.ord);
const cfg=getFieldConfig(c.did);
if(!Array.isArray(cfg.front)) cfg.front = cfg.front ? [cfg.front] : [];
const frontFields = cfg.front.filter(f=>c.fields[f]!==undefined);
if(!frontFields.length) frontFields.push(Object.keys(c.fields)[0]);
const typeLabel=!st?'NEU':st.type===2?'WIEDERHOLUNG':'LERNEN';
const frontAudio = frontFields.map(f=>extractAudio(c.fields[f]||'')).find(Boolean);

const div=document.createElement('div');
div.className='flashcard c-in'; div.id='fcard'; div.onclick=flipCard;

const frontHtml = frontFields.map((f,i)=>{
const val = removeAudioTags(c.fields[f]||'');
const big = i===0;
return '<div style="' + (i>0?'margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.07)':'') + '">' + renderField(val,big) + '</div>';
}).join('');

div.innerHTML=` <div class="card-type-badge">${typeLabel}</div> ${frontAudio?`<button class="card-audio-btn" onclick="event.stopPropagation();playAudio('${frontAudio}')">🔊</button>`:''} <div class="card-main" style="width:100%">${frontHtml}</div> <div class="tap-hint"><div class="tap-dot"></div>Tippen zum Aufdecken</div> `;

const stage=document.getElementById('cardStage');
stage.innerHTML=''; stage.appendChild(div);
}

function flipCard(){
if(flipped) return;
flipped=true;
const c=curCard;
const cfg=getFieldConfig(c.did);
const st=getState(c.nid,c.ord);
const card=document.getElementById('fcard');
card.onclick=null; card.querySelector('.tap-hint')?.remove();

const backFields=cfg.back.filter(f=>!cfg.hidden.includes(f)&&c.fields[f]&&c.fields[f].trim());
let backHtml='';
for(const f of backFields){
const val=c.fields[f];
const audio=extractAudio(val);
const cleanVal=removeAudioTags(val);
const isBig=backFields.indexOf(f)===0;
backHtml+=`<div class="back-field"> <div class="back-field-label">${esc(f)}</div> <div class="back-field-val ${isBig?'big':''}"> ${renderField(cleanVal,isBig)} ${audio?`<button class="card-audio-btn" style="position:static;display:inline-flex;margin-left:8px;vertical-align:middle;width:28px;height:28px;font-size:13px" onclick="playAudio('${audio}')">🔊</button>`:''} </div> </div>`;
}
if(!backHtml) backHtml='<div style="color:#4a4a66;font-size:14px">Keine weiteren Felder</div>';

const divider=document.createElement('div'); divider.className='card-divider';
const backEl=document.createElement('div'); backEl.className='back-fields'; backEl.innerHTML=backHtml;
card.appendChild(divider); card.appendChild(backEl);
renderAns(true,st);
}

function renderAns(showRating,st){
const wrap=document.getElementById('ansWrap');
if(!showRating){
wrap.innerHTML=`<button class="show-btn" onclick="flipCard()">Antwort zeigen</button>`;
return;
}
const btns=[
{k:'again',cls:'btn-again',l:'Nochmal'},
{k:'hard', cls:'btn-hard', l:'Schwer'},
{k:'good', cls:'btn-good', l:'Gut'},
{k:'easy', cls:'btn-easy', l:'Leicht'},
];
wrap.innerHTML=`<div class="rating-grid">${btns.map(b=>`
<button class="r-btn ${b.cls}" onclick="rateCard('${b.k}')">
<span class="r-lbl">${b.l}</span>
<span class="r-int">${intervalLabel(st,R[b.k])}</span>
</button>`).join('')}</div>`;
}

const R={again:1,hard:2,good:3,easy:4};

function rateCard(rk){
const c = curCard;
const rating = R[rk];
const oldSt = getState(c.nid, c.ord) || {};
const newSt = schedule(oldSt, rating);
setState(c.nid, c.ord, newSt);
sessionStats[rk]++;
recordStudied(1);
schedulePush();

// Re-queue learning cards within session (until graduated)
if(!window._sessionRequeues) window._sessionRequeues = {};
const reqKey = `${c.cid}_${c.ord}`;
if(newSt.type < 2){
const count = window._sessionRequeues[reqKey] || 0;
const alreadyWaiting = studyQueue.slice(studyIdx+1).some(q=>q.cid===c.cid && q.ord===c.ord);
if(!alreadyWaiting && count < 8){
window._sessionRequeues[reqKey] = count + 1;
// Again=sooner(3), Hard=medium(5), Good=later(8)
const stepsAhead = rating===1 ? 3 : rating===2 ? 5 : 8;
studyQueue.splice(Math.min(studyIdx+1+stepsAhead, studyQueue.length), 0, c);
}
}

// Undo stack
if(!window._undoStack) window._undoStack = [];
window._undoStack.push({card:c, oldSt, newSt, studyIdx, queueLen:studyQueue.length});
if(window._undoStack.length > 10) window._undoStack.shift();

const card = document.getElementById('fcard');
if(card){ card.classList.remove('c-in'); card.classList.add('c-out'); card.style.pointerEvents='none'; }
studyIdx++;
setTimeout(nextCard, 230);
}

function undoLast(){
if(!window._undoStack || !window._undoStack.length){ toast('Nichts rückgängig zu machen'); return; }
const {card, oldSt, studyIdx:prevIdx} = window._undoStack.pop();
setState(card.nid, card.ord, oldSt);
sessionStats.again = Math.max(0, sessionStats.again - (R['again']===1?1:0));
// Re-insert card at previous position
studyQueue.splice(prevIdx, 0, card);
studyIdx = prevIdx;
recordStudied(-1); // undo the count
nextCard();
toast('↩ Rückgängig');
}

// ══════════════════════════════════════════════
//  DONE SCREEN
// ══════════════════════════════════════════════
function showDone(allDone){
document.getElementById('progFill').style.width='100%';
document.getElementById('ansWrap').innerHTML='';
const total=sessionStats.again+sessionStats.hard+sessionStats.good+sessionStats.easy;
const correct=sessionStats.good+sessionStats.easy;
const pct=total?Math.round(correct/total*100):100;
const streak = getStreak();
document.getElementById('cardStage').innerHTML=`<div class="done-wrap"> <div class="done-icon">${allDone?'🎌':'🎉'}</div> <div class="done-title">${allDone?'Alles erledigt!':'Sitzung beendet!'}</div> <div class="done-sub">${allDone?'Für heute alle Karten fertig. Bis morgen!':total+' Karten gelernt'}</div> ${total?`<div class="done-row">
<div class="done-stat"><div class="done-stat-val" style="color:#ff4d6d">${sessionStats.again}</div><div class="done-stat-lbl">Nochmal</div></div>
<div class="done-stat"><div class="done-stat-val" style="color:#3ecf8e">${correct}</div><div class="done-stat-lbl">Richtig</div></div>
<div class="done-stat"><div class="done-stat-val">${pct}%</div><div class="done-stat-lbl">Quote</div></div>
</div>
<div style="font-size:13px;color:#8888aa;margin-top:4px">🔥 ${streak} Tage Streak</div>`:''}
<button class="primary-btn" onclick="goHome()">Zurück zu Decks</button>

  </div>`;
}

// ══════════════════════════════════════════════
//  AUDIO
// ══════════════════════════════════════════════
function extractAudio(val){
if(!val) return null;
const m = val.match(/\[sound:([^\]]+)\]/);
if(m) return m[1].trim();
const m2 = val.match(/<audio[^>]+src="([^"]+)"/i);
if(m2) return m2[1].trim();
return null;
}
function removeAudioTags(val){
return val ? val.replace(/\[sound:[^\]]+\]/g,'') : val;
}
function playAudio(filename){
const decoded = decodeURIComponent(filename);
const basename = filename.split('/').pop();
const url = mediaFiles[filename] || mediaFiles[decoded] || mediaFiles[basename] || mediaFiles[decoded.split('/').pop()];
if(!url){ toast('🔇 ' + basename + ' nicht gefunden'); return; }
const ext = basename.split('.').pop().toLowerCase();
const supported = ['mp3','m4a','aac','wav','mp4','caf'];
if(!supported.includes(ext)){ toast('⚠️ Format nicht unterstützt: .' + ext); return; }
if(window._currentAudio){ window._currentAudio.pause(); window._currentAudio.src=''; window._currentAudio=null; }
const audio = new Audio();
audio.preload='auto'; window._currentAudio=audio; audio.src=url;
const p = audio.play();
if(p) p.catch(e=>{
fetch(url).then(r=>r.arrayBuffer()).then(buf=>{
const ctx = new (window.AudioContext||window.webkitAudioContext)();
return ctx.decodeAudioData(buf).then(d=>{ const s=ctx.createBufferSource(); s.buffer=d; s.connect(ctx.destination); s.start(0); });
}).catch(()=>toast('🔇 Wiedergabe fehlgeschlagen'));
});
}

// ══════════════════════════════════════════════
//  FIELD RENDERING
// ══════════════════════════════════════════════
function sanitizeAnkiHtml(html) {
html = html.replace(/(?:color|background(?:-color)?|font-size|font-family)\s*:[^;"'}]+[;]?/gi, '');
html = html.replace(/style="[\s;]*"/gi, '');
html = html.replace(/style="\s*;+\s*/gi, 'style="');
html = html.replace(/<font[^>]*>/gi, '').replace(/<\/font>/gi, '');
html = html.replace(/<img([^>]*)src="([^"]+)"([^>]*?)\/?>/gi, (match, pre, src, post) => {
const filename = src.split('/').pop();
const url = mediaFiles[src] || mediaFiles[filename] || '';
if(!url) return `<div style="font-size:11px;color:#8888aa;padding:6px 10px;border:1px dashed #4a4a66;border-radius:8px;display:inline-block">🖼 ${esc(filename)}</div>`;
return `<img${pre}src="${url}"${post} style="max-width:100%;border-radius:12px;display:block;margin:8px auto">`;
});
return html;
}

function renderField(val, big=false){
if(!val) return '';
val = removeAudioTags(val);
if(!val.trim()) return '';
if(/<[a-z]/i.test(val)){
return `<div class="card-front-html">${sanitizeAnkiHtml(val)}</div>`;
}
const len=val.length;
let sz;
if(big){ sz=len<=3?'72px':len<=6?'52px':len<=12?'36px':len<=24?'24px':'17px'; }
else{ sz=len<=8?'22px':len<=30?'17px':'14px'; }
return `<span style="font-size:${sz};line-height:1.2;display:block">${esc(val)}</span>`;
}

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}}
function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('hidden',s.id!==id))}
function goHome(){showScreen('homeScreen');renderHome()}

function openModal(id){const m=document.getElementById(id);m.classList.remove('hidden');m.style.display='flex';}
function closeModal(id){document.getElementById(id).classList.add('hidden');}
document.querySelectorAll('.modal-bg').forEach(bg=>{
bg.addEventListener('click',e=>{if(e.target===bg)closeModal(bg.id)});
});

let toastT;
function toast(msg){
const el=document.getElementById('toast');
el.textContent=msg; el.classList.add('show');
clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('show'),3200);
}
function showLoader(msg){document.getElementById('loaderOverlay').classList.remove('gone');setMsg(msg);}
function hideLoader(){document.getElementById('loaderOverlay').classList.add('gone');}
function setMsg(m){const el=document.getElementById('loaderMsg');if(el)el.textContent=m;}

document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',async e=>{
e.preventDefault();
const f=e.dataTransfer.files[0];
if(f&&(f.name.endsWith('.apkg')||f.name.endsWith('.colpkg'))) await importApkg(f);
});

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
let appBooted = false;
async function runApp() {
if(appBooted) return;
appBooted = true;
try {
loadLocal();
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{
if(userSettings.theme==='auto') applyTheme();
});
setMsg('Bibliotheken prüfen...');
if(typeof initSqlJs==='undefined') throw new Error('sql.js nicht geladen - Seite neu laden');
if(typeof JSZip==='undefined') throw new Error('JSZip nicht geladen - Seite neu laden');
setMsg('SQL-Engine laden...');
await initSQL();
setMsg('Bereit ✓');
hideLoader();
renderHome();
applyEditModeBtn();
if(ghConfig.token && ghConfig.repo && ghConfig.user){
ghPull().then(()=>renderHome()).catch(e=>console.warn('GH pull failed:',e));
}
} catch(err) {
const ol=document.getElementById('loaderOverlay');
const msg=document.getElementById('loaderMsg');
if(msg) msg.textContent='❌ '+err.message;
if(ol){
const btn=document.createElement('button');
btn.textContent='🔄 Neu laden';
btn.style.cssText='margin-top:16px;padding:14px 28px;background:#6e66ff;color:#fff;border:none;border-radius:16px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit';
btn.onclick=()=>location.reload();
ol.appendChild(btn);
}
console.error('Init error:',err);
}
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runApp, {once:true});
else runApp();
