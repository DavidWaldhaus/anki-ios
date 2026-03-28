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
const dedupeByDeck = {};
for(const[cid,nid,did,ord,type,mid,flds,tags] of rows[0].values){
const dn = deckDef[did]?.name || 'Unbekannt';
if(!result[did]) result[did]={name:dn,cards:[],fields:[]};
const model = models[mid]||{fields:[]};
const vals = flds.split('\x1f');
const fields={};
model.fields.forEach((n,i)=>fields[n]=vals[i]||'');
if(!result[did].fields.length) result[did].fields=model.fields;
const dedupeKey = `${nid}::${buildCardPromptFingerprint(fields, model.fields)}`;
if(!dedupeByDeck[did]) dedupeByDeck[did] = {};
const prevIdx = dedupeByDeck[did][dedupeKey];
const nextCard = {cid,nid,did,ord,type,fields,tags:tags||''};
if(prevIdx === undefined){
  dedupeByDeck[did][dedupeKey] = result[did].cards.length;
  result[did].cards.push(nextCard);
}else{
  const prev = result[did].cards[prevIdx];
  if(cardInfoRichness(nextCard) > cardInfoRichness(prev)) result[did].cards[prevIdx] = nextCard;
}
}
return result;
}

function normalizePromptText(v=''){
return String(v)
  .replace(/\[sound:[^\]]+\]/gi,' ')
  .replace(/<audio[^>]*>.*?<\/audio>/gi,' ')
  .replace(/<[^>]+>/g,' ')
  .replace(/\s+/g,' ')
  .trim()
  .toLowerCase();
}

function buildCardPromptFingerprint(fields, fieldOrder){
const candidates = ['Expression','Front','Word','Vocab','単語','表現','Kanji','漢字','Question','Term'];
let chosen = fieldOrder?.[0] || Object.keys(fields)[0] || '';
for(const c of candidates){ if(fields[c] !== undefined){ chosen = c; break; } }
const text = normalizePromptText(fields[chosen] || '');
return `${chosen}:${text}`;
}

function cardInfoRichness(card){
const vals = Object.values(card.fields || {});
const txtLen = vals.map(v => normalizePromptText(v).length).reduce((a,b)=>a+b,0);
const hasAudio = vals.some(v => /\[sound:[^\]]+\]/i.test(String(v||'')));
return txtLen + (hasAudio ? 50 : 0);
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
if(!node[part]) node[part] = {did:null, fullName:path, displayName:part, children:{}, allCards:[], activeCards:[], hasEnabledLeaf:false, hasDisabledLeaf:false};
if(i === parts.length-1) {
node[part].did = did;
node[part].allCards.push(...deck.cards);
if(isDeckEnabled(deck.name)){
  node[part].activeCards.push(...deck.cards);
  node[part].hasEnabledLeaf = true;
}else{
  node[part].hasDisabledLeaf = true;
}
}
node = node[part].children;
}
}
function bubbleCards(nodeMap) {
for(const node of Object.values(nodeMap)) {
bubbleCards(node.children);
for(const child of Object.values(node.children)) {
node.allCards.push(...child.allCards);
node.activeCards.push(...child.activeCards);
if(child.hasEnabledLeaf) node.hasEnabledLeaf = true;
if(child.hasDisabledLeaf) node.hasDisabledLeaf = true;
}
}
}
bubbleCards(tree);
return tree;
}

function getAllCardsForNodeByName(fullName) {
const cards = [];
for(const deck of Object.values(decks)){
if((deck.name === fullName || deck.name.startsWith(fullName + '::')) && isDeckEnabled(deck.name)){
cards.push(...deck.cards);
}
}
return cards;
}

function getCounts(cards){
const seen = new Set();
let newC=0, lrnC=0, revC=0;
const newByDeck = {};
for(const c of cards){
if(seen.has(c.cid)) continue;
seen.add(c.cid);
const st=getState(c.nid,c.ord);
if(!st){
  newC++;
  const deckName = decks[c.did]?.name;
  if(deckName) newByDeck[deckName] = (newByDeck[deckName] || 0) + 1;
  continue;
}
if(!isDue(st)) continue;
if(st.type===2) revC++; else lrnC++;
}
const newPerDeck = Math.max(0, num(userSettings.newPerDeck, 20));
let addableNew = 0;
for(const [deckName, unseenNew] of Object.entries(newByDeck)){
  const seenToday = getNewSeenTodayForDeck(deckName);
  const remainingByLimit = Math.max(0, newPerDeck - seenToday);
  addableNew += Math.min(unseenNew, remainingByLimit);
}
return{newC,lrnC,revC,addableNew};
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

function getOrderedEntries(mapObj, parentPath='__root__'){
const entries = Object.entries(mapObj || {});
const order = Array.isArray(userSettings.deckOrder?.[parentPath]) ? userSettings.deckOrder[parentPath] : [];
const byName = new Map(entries.map(([k,v])=>[k,v]));
const ordered = [];
for(const name of order){
if(byName.has(name)){
ordered.push([name, byName.get(name)]);
byName.delete(name);
}
}
const rest = [...byName.entries()].sort((a,b)=>a[0].localeCompare(b[0], 'de'));
return [...ordered, ...rest];
}

function getDeckStudySummary(newC, lrnC, revC){
const due = lrnC + revC;
if(!due && !newC) return 'Heute nichts fällig';
if(!due) return `Heute: ${newC} neue Karte${newC===1?'':'n'}`;
return `Heute: ${due} fällig + ${newC} neu`;
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
const forecast = getDueForecast(7);
const dueTomorrow = forecast[1]?.count || 0;
let html = `

  <div style="background:#1a1a24;border:1.5px solid #2c2c3e;border-radius:16px;padding:14px 16px;margin-bottom:14px;display:flex;align-items:center;gap:14px">
    <div style="font-size:28px">🔥</div>
    <div style="flex:1">
      <div style="font-size:15px;font-weight:700;color:#f0f0f8">${streak} Tag${streak!==1?'e':''} Streak</div>
      <div style="font-size:12px;color:#8888aa;margin-top:2px">Heute: ${todayStudied} Karten gelernt · Morgen fällig: ${dueTomorrow}</div>
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
for(const [,node] of getOrderedEntries(tree, '__root__')) {
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
const cards = node.activeCards;
const {newC,lrnC,revC,addableNew} = getCounts(cards);
const prog = getDeckProgress(cards);
const EMOJIS = ['🎌','📖','✍️','🗾','📝','🎋','⛩️','🌸','📚','🈳'];
const emoji = EMOJIS[Math.abs(node.fullName.length * 7) % EMOJIS.length];
const indent = depth * 16;
const nodeId = 'node_' + node.fullName.replace(/[^a-zA-Z0-9]/g,'_');
const collapsed = userSettings.deckTreeCollapsed?.[node.fullName] !== false;
const disabledClass = !node.hasEnabledLeaf && node.hasDisabledLeaf ? ' deck-card-disabled' : '';
const hint = node.hasEnabledLeaf ? '' : '<span style="margin-left:6px;color:#ffaa44;font-size:11px">deaktiviert</span>';
const summary = getDeckStudySummary(newC, lrnC, revC);

let html = '';
if(hasChildren) {
html += `<div class="deck-card deck-parent${disabledClass}" style="margin-left:${indent}px" onclick="toggleDeckNode('${nodeId}','${esc(node.fullName)}')"> <span class="deck-emoji">${emoji}</span> <div class="deck-info"> <div class="deck-name">${esc(node.displayName)}${hint}</div> <div class="deck-sub">${cards.length} aktive Karten · ${prog.pct}% gelernt</div><div class="deck-sub" style="margin-top:2px">${summary}</div> <div style="height:3px;background:#2c2c3e;border-radius:3px;margin-top:6px;overflow:hidden"> <div style="height:100%;width:${prog.pct}%;background:#6e66ff;border-radius:3px;transition:width .4s"></div> </div> <div class="deck-pills" style="margin-top:6px"> <span class="pill ${newC?'pill-new':'pill-0'}">${newC} neu</span> <span class="pill ${lrnC?'pill-lrn':'pill-0'}">${lrnC} lernen</span> <span class="pill ${revC?'pill-rev':'pill-0'}">${revC} wdh.</span> <span class="pill ${addableNew?'pill-add':'pill-0'}">${addableNew} zusätzlich</span> </div> </div> <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0"> <div style="display:flex;gap:6px;align-items:center"> ${userSettings.editMode ? `<button onclick="event.stopPropagation();showFieldModalForGroup('${esc(node.fullName)}')"
style="background:#20202c;color:#a89fff;border:1.5px solid #2c2c3e;border-radius:10px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">
⚙️ Felder</button>` : ''} <button onclick="event.stopPropagation();startStudyCards(getAllCardsForNodeByName('${esc(node.fullName)}'),'${esc(node.displayName)}', '${esc(node.fullName)}')" style="background:#6e66ff;color:#fff;border:none;border-radius:10px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap"> ▶ Alle lernen</button> </div> <span class="deck-arr" id="${nodeId}_arrow">${collapsed?'›':'⌄'}</span> </div> </div>`;
html += `<div id="${nodeId}_children" style="display:${collapsed?'none':'block'}">`;
for(const [,child] of getOrderedEntries(node.children, node.fullName)) {
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
const {newC,lrnC,revC,addableNew} = getCounts(deck.cards);
const prog = getDeckProgress(deck.cards);
const EMOJIS = ['🎌','📖','✍️','🗾','📝','🎋','⛩️','🌸','📚','🈳'];
const emoji = EMOJIS[Math.abs(did * 7) % EMOJIS.length];
const indent = depth * 16;
const name = deck.name.split('::').pop();
const enabled = isDeckEnabled(deck.name);
const summary = getDeckStudySummary(newC, lrnC, revC);
return `<div class="deck-card${enabled?'':' deck-card-disabled'}" style="margin-left:${indent}px" onclick="startStudy('${did}')">
<span class="deck-emoji" style="font-size:22px">${emoji}</span>
<div class="deck-info">
<div class="deck-name" style="font-size:14px">${esc(name)}${enabled?'':' <span style="font-size:11px;color:#ffaa44">(deaktiviert)</span>'}</div>
<div class="deck-sub">${deck.cards.length} Karten · ${prog.pct}%${userSettings.editMode ? ' · <span style="cursor:pointer;color:#a89fff;text-decoration:underline" onclick="event.stopPropagation();showFieldModal(\''+did+'\')">Felder</span>' : ''}</div>
<div class="deck-sub" style="margin-top:2px">${summary}</div>
<div style="height:3px;background:#2c2c3e;border-radius:3px;margin-top:5px;overflow:hidden">
<div style="height:100%;width:${prog.pct}%;background:#6e66ff;border-radius:3px"></div>
</div>
<div class="deck-pills" style="margin-top:5px">
<span class="pill ${newC?'pill-new':'pill-0'}">${newC} neu</span>
<span class="pill ${lrnC?'pill-lrn':'pill-0'}">${lrnC} lernen</span>
<span class="pill ${revC?'pill-rev':'pill-0'}">${revC} wdh.</span>
<span class="pill ${addableNew?'pill-add':'pill-0'}">${addableNew} zusätzlich</span>
</div>
</div>
<span class="deck-arr">›</span>

  </div>`;
}

function toggleDeckNode(nodeId, fullName) {
const el = document.getElementById(nodeId + '_children');
const arrow = document.getElementById(nodeId + '_arrow');
if(!el) return;
const open = el.style.display === 'none';
el.style.display = open ? 'block' : 'none';
if(arrow) arrow.textContent = open ? '⌄' : '›';
if(fullName){
  userSettings.deckTreeCollapsed[fullName] = !open;
  saveLocal();
}
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
document.getElementById('settingsContent').innerHTML=`
<div class="settings-group"><div class="settings-group-title">Version</div><div class="settings-card"><div class="settings-row"><div class="settings-row-info"><div class="settings-row-title">Aktueller Stand</div><div class="settings-row-sub">Build ${APP_VERSION}</div></div></div></div></div>
<div class="settings-group"><div class="settings-group-title">Erscheinungsbild</div><div class="settings-card"><div class="settings-row"><div class="settings-row-info"><div class="settings-row-title">Darstellung</div><div class="settings-row-sub">Hell, Dunkel oder wie das iPhone</div></div><div class="segment" id="themeSegment"><button class="seg-btn ${s.theme==='light'?'active':''}" onclick="setTheme('light')">Hell</button><button class="seg-btn ${s.theme==='auto'?'active':''}" onclick="setTheme('auto')">Auto</button><button class="seg-btn ${s.theme==='dark'?'active':''}" onclick="setTheme('dark')">Dunkel</button></div></div></div></div>
<div class="settings-group"><div class="settings-group-title">Lernen</div><div class="settings-card"><div class="settings-row"><div class="settings-row-info"><div class="settings-row-title">Neue Karten pro Tag</div><div class="settings-row-sub">Pro Deck, zusätzlich zu fälligen Karten</div></div><div class="stepper"><button class="stepper-btn" onclick="adjustNew(-5)">-</button><div class="stepper-val" id="newPerDeckVal">${s.newPerDeck}</div><button class="stepper-btn" onclick="adjustNew(+5)">+</button></div></div><div class="settings-row"><div class="settings-row-info"><div class="settings-row-title">Neue Karten direkt setzen</div><div class="settings-row-sub">1 bis 100</div></div><input class="s-input" id="newPerDeckInput" type="number" min="1" max="100" value="${s.newPerDeck}" onchange="setNewPerDeckFromInput(this.value)" style="max-width:110px"></div><div class="settings-row"><div class="settings-row-info"><div class="settings-row-title">Reihenfolge neue Karten</div><div class="settings-row-sub">Geordnet = Deck-Reihenfolge</div></div><div class="segment" id="orderSegment"><button class="seg-btn ${s.newOrder==='ordered'?'active':''}" onclick="setOrder('ordered')">Geordnet</button><button class="seg-btn ${s.newOrder==='random'?'active':''}" onclick="setOrder('random')">Zufällig</button></div></div></div></div>
<div class="settings-group"><div class="settings-group-title">Deck-Auswahl</div><div class="settings-card" style="padding:16px"><div style="font-size:12px;color:#8888aa;line-height:1.5;margin-bottom:10px">Deaktivierte Decks bleiben in Sammelmodi ausgeschlossen, lassen sich aber direkt in der Deckliste öffnen.</div><button class="s-btn" onclick="showDeckActivationModal()">Decks aktivieren/deaktivieren</button><button class="s-btn" onclick="showDeckOrderModal()">Subdeck-Reihenfolge anpassen</button></div></div>
<div class="settings-group"><div class="settings-group-title">Fun-Modi (ohne Score-Änderung)</div><div class="settings-card" style="padding:16px"><div style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><label class="s-label" style="margin:0;min-width:95px">Kartenanzahl</label><div class="stepper"><button class="stepper-btn" onclick="adjustFunModeCount(-10)">-</button><div class="stepper-val" id="funModeCountVal">${s.funModeCount||30}</div><button class="stepper-btn" onclick="adjustFunModeCount(+10)">+</button></div></div><div class="settings-row" style="padding:0;border:none;background:transparent"><div class="settings-row-info"><div class="settings-row-title">Kartenanzahl direkt setzen</div><div class="settings-row-sub">5 bis 200</div></div><input class="s-input" id="funModeCountInput" type="number" min="5" max="200" value="${s.funModeCount||30}" onchange="setFunModeCountFromInput(this.value)" style="max-width:110px"></div><div class="segment" id="funDeckFilterSegment" style="margin-bottom:10px"><button class="seg-btn ${s.funModeDeckFilter!=='all'?'active':''}" onclick="setFunDeckFilter('active')">Nur aktive Decks</button><button class="seg-btn ${s.funModeDeckFilter==='all'?'active':''}" onclick="setFunDeckFilter('all')">Alle Decks</button></div><button class="s-btn" onclick="startFunMode('worst')">🎯 Schwächste Karten zufällig</button><button class="s-btn" onclick="startFunMode('random')">🎲 Zufällige gelernte Karten</button><div style="margin-top:10px;padding-top:10px;border-top:1px solid #2c2c3e"><div class="settings-row" style="padding:0;border:none;background:transparent;margin-bottom:8px"><div class="settings-row-info"><div class="settings-row-title">Neuer Fun-Modus</div><div class="settings-row-sub">Deck oder Parent-Deck wählen</div></div><select class="s-input" id="funModeDeckSelect" onchange="updateCustomFunDeck(this.value)" style="max-width:180px">${renderFunDeckOptions()}</select></div><div class="segment" id="funCustomOrderSegment"><button class="seg-btn ${s.funModeCustomOrder!=='ordered'?'active':''}" onclick="setCustomFunOrder('random')">Zufällig</button><button class="seg-btn ${s.funModeCustomOrder==='ordered'?'active':''}" onclick="setCustomFunOrder('ordered')">Geordnet</button></div><button class="s-btn accent" onclick="startCustomFunMode()">🕹️ Deck-Fun-Modus starten</button></div><div class="s-hint">Fun-Modi beeinflussen weder Hauptscore noch Intervalle.</div></div></div>
<div class="settings-group"><div class="settings-group-title">☁️ GitHub Sync</div><div class="settings-card" style="padding:16px"><div style="font-size:13px;color:#8888aa;margin-bottom:14px;line-height:1.6">Fortschritt, Deck-Reihenfolge und Deck-Aktivierung werden synchronisiert.</div><div style="display:flex;flex-direction:column;gap:12px"><div><label class="s-label">GitHub Benutzername</label><input class="s-input" id="ghUser" placeholder="deinusername" value="${esc(ghConfig.user||'')}"></div><div><label class="s-label">Repository Name</label><input class="s-input" id="ghRepo" placeholder="kanji" value="${esc(ghConfig.repo||'')}"></div><div><label class="s-label">Personal Access Token</label><input class="s-input" id="ghToken" type="password" placeholder="ghp_xxxxxxxxxxxx" value="${esc(ghConfig.token||'')}"></div></div><button class="s-btn accent" onclick="saveGHConfig()">Speichern & verbinden</button>${syncOk?`<button class="s-btn" onclick="ghPull().then(()=>renderHome())">⬇️ Jetzt synchronisieren</button><button class="s-btn" onclick="ghPush()">⬆️ Jetzt hochladen</button>`:''}<div id="syncTestResult"></div></div></div>
<div class="settings-group"><div class="settings-group-title">💾 Fortschritt</div><div class="settings-card" style="padding:16px"><div id="progressSummary" style="margin-bottom:14px"></div><button class="s-btn" onclick="showInsights()">📈 Lernvorschau öffnen</button><div style="display:flex;flex-direction:column;gap:8px;margin-top:8px"><button class="s-btn accent" onclick="exportProgress()">📤 Backup exportieren (.json)</button><button class="s-btn" onclick="document.getElementById('importProgressInput').click()">📥 Backup importieren</button><input type="file" id="importProgressInput" accept=".json" style="display:none" onchange="importProgressFile(event)"><button class="s-btn" onclick="testProgressIntegrity()">🔍 Backup testen</button><button class="s-btn danger" onclick="confirmReset()">🗑️ Fortschritt zurücksetzen</button></div></div></div>`;
openModal('settingsModal');
setTimeout(()=>{
  const sel = document.getElementById('funModeDeckSelect');
  if(sel) sel.value = userSettings.funModeCustomDeck || '';
  renderProgressSummary();
}, 50);
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
const input = document.getElementById('newPerDeckInput');
if(input) input.value = userSettings.newPerDeck;
}
function setNewPerDeckFromInput(val){
userSettings.newPerDeck = Math.max(1, Math.min(100, num(val, userSettings.newPerDeck||20)));
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
function adjustFunModeCount(delta){
userSettings.funModeCount = Math.max(5, Math.min(200, (userSettings.funModeCount||30) + delta));
saveLocal();
const el = document.getElementById('funModeCountVal');
if(el) el.textContent = userSettings.funModeCount;
const input = document.getElementById('funModeCountInput');
if(input) input.value = userSettings.funModeCount;
}
function setFunModeCountFromInput(val){
userSettings.funModeCount = Math.max(5, Math.min(200, num(val, userSettings.funModeCount||30)));
saveLocal();
const el = document.getElementById('funModeCountVal');
if(el) el.textContent = userSettings.funModeCount;
}
function setFunDeckFilter(v){
userSettings.funModeDeckFilter = v === 'all' ? 'all' : 'active';
saveLocal();
document.querySelectorAll('#funDeckFilterSegment .seg-btn').forEach((b,i)=>{
b.classList.toggle('active', ['active','all'][i]===userSettings.funModeDeckFilter);
});
}

function renderFunDeckOptions(){
const tree = buildDeckTree();
const opts = ['<option value="">Alle berechtigten Decks</option>'];
function walk(node, depth=0){
const pad = '&nbsp;'.repeat(depth*3);
opts.push(`<option value="group:${esc(node.fullName)}">${pad}📂 ${esc(node.fullName)}</option>`);
if(node.did){
  opts.push(`<option value="deck:${node.did}">${pad}&nbsp;&nbsp;📘 ${esc(decks[node.did].name)}</option>`);
}
for(const [,child] of getOrderedEntries(node.children, node.fullName)) walk(child, depth+1);
}
for(const [,node] of getOrderedEntries(tree, '__root__')) walk(node, 0);
return opts.join('');
}

function setCustomFunOrder(order){
userSettings.funModeCustomOrder = order === 'ordered' ? 'ordered' : 'random';
saveLocal();
document.querySelectorAll('#funCustomOrderSegment .seg-btn').forEach((b,i)=>{
b.classList.toggle('active', ['random','ordered'][i]===userSettings.funModeCustomOrder);
});
}

function updateCustomFunDeck(v){
userSettings.funModeCustomDeck = v || '';
saveLocal();
}

function showDeckActivationModal(){
const tree = buildDeckTree();
const html = [];
function row(title, fullName, depth, onClass, partial, cnt){
const indent = depth * 20;
const ind = partial ? 'toggle-partial' : '';
html.push(`<div class="settings-row deck-tree-row" style="padding-left:${16+indent}px"><div class="settings-row-info"><div class="settings-row-title">${esc(title)}</div><div class="settings-row-sub">${cnt} Karten</div></div><button class="toggle ${onClass?'on':''} ${ind}" onclick="toggleDeckBranch('${esc(fullName)}')"></button></div>`);
}
function walk(node, depth=0){
const leafNames = getDeckNamesForBranch(node.fullName);
const enabledN = leafNames.filter(isDeckEnabled).length;
const allN = leafNames.length;
row(node.displayName, node.fullName, depth, enabledN===allN && allN>0, enabledN>0 && enabledN<allN, node.allCards.length);
for(const [,child] of getOrderedEntries(node.children, node.fullName)) walk(child, depth+1);
if(node.did){
  const d = decks[node.did];
  row(d.name.split('::').pop(), d.name, depth+1, isDeckEnabled(d.name), false, d.cards.length);
}
}
for(const [,node] of getOrderedEntries(tree, '__root__')) walk(node, 0);
document.getElementById('settingsContent').innerHTML = `<div class="settings-group"><div class="settings-group-title">Decks aktiv/deaktiv</div><div class="settings-card">${html.join('') || '<div class="settings-row"><div class="settings-row-sub">Keine Decks gefunden.</div></div>'}</div><button class="s-btn accent" onclick="showSettings()" style="margin-top:10px">Zurück</button></div>`;
}

function getDeckNamesForBranch(fullName){
return Object.values(decks).filter(d => d.name===fullName || d.name.startsWith(fullName + '::')).map(d=>d.name);
}

function toggleDeckBranch(fullName){
const names = getDeckNamesForBranch(fullName);
if(!names.length) names.push(fullName);
const allEnabled = names.every(isDeckEnabled);
for(const name of names) userSettings.deckEnabled[name] = !allEnabled;
saveLocal();
schedulePush();
renderHome();
showDeckActivationModal();
}

function showDeckOrderModal(){
const tree = buildDeckTree();
const selectors = ['<option value="__root__">Top-Level</option>'];
function walk(node){
if(Object.keys(node.children).length > 0){
  selectors.push(`<option value="${esc(node.fullName)}">${esc(node.fullName)}</option>`);
}
for(const [,child] of getOrderedEntries(node.children, node.fullName)) walk(child);
}
for(const [,node] of getOrderedEntries(tree, '__root__')) walk(node);
document.getElementById('settingsContent').innerHTML = `<div class="settings-group"><div class="settings-group-title">Subdeck-Reihenfolge</div><div class="settings-card" style="padding:16px"><div class="s-label">Bereich</div><select class="s-input" id="deckOrderParent" onchange="renderDeckOrderList(this.value)">${selectors.join('')}</select><div id="deckOrderListWrap" style="margin-top:12px"></div></div><button class="s-btn accent" onclick="showSettings()" style="margin-top:10px">Zurück</button></div>`;
setTimeout(()=>renderDeckOrderList('__root__'), 0);
}

function renderDeckOrderList(parent){
const tree = buildDeckTree();
let entries = [];
if(parent === '__root__'){
  entries = getOrderedEntries(tree, '__root__').map(([k])=>k);
}else{
  const parts = parent.split('::');
  let nodeMap = tree; let cur = null;
  for(const p of parts){ cur = nodeMap[p]; if(!cur) break; nodeMap = cur.children; }
  if(!cur){ document.getElementById('deckOrderListWrap').innerHTML='Nicht gefunden'; return; }
  entries = getOrderedEntries(cur.children, cur.fullName).map(([k])=>k);
}
const rows = entries.map((name, i)=>`<div class="sortable-item" draggable="true" ondragstart="deckOrderDragStart(event,'${esc(name)}')" ondragover="deckOrderDragOver(event)" ondrop="deckOrderDrop(event,'${esc(name)}')" data-name="${esc(name)}"><span class="field-drag">⠿</span><div class="field-info"><div class="field-name">${esc(name)}</div></div><button class="field-action-btn" onclick="moveDeckOrder('${esc(parent)}','${esc(name)}',-1)">↑</button><button class="field-action-btn" onclick="moveDeckOrder('${esc(parent)}','${esc(name)}',1)">↓</button></div>`).join('');
document.getElementById('deckOrderListWrap').innerHTML = `<div class="sortable-list">${rows || '<div class="settings-row"><div class="settings-row-sub">Keine Subdecks.</div></div>'}</div>`;
}

let _deckOrderDrag = null;
function deckOrderDragStart(e,name){ _deckOrderDrag = name; e.dataTransfer?.setData('text/plain', name); }
function deckOrderDragOver(e){ e.preventDefault(); }
function deckOrderDrop(e, targetName){
e.preventDefault();
const parent = document.getElementById('deckOrderParent')?.value || '__root__';
if(!_deckOrderDrag || _deckOrderDrag===targetName) return;
const arr = Array.isArray(userSettings.deckOrder[parent]) ? [...userSettings.deckOrder[parent]] : [];
if(!arr.includes(_deckOrderDrag)) arr.push(_deckOrderDrag);
if(!arr.includes(targetName)) arr.push(targetName);
arr.splice(arr.indexOf(_deckOrderDrag),1);
arr.splice(arr.indexOf(targetName),0,_deckOrderDrag);
userSettings.deckOrder[parent] = arr;
saveLocal(); schedulePush(); renderHome(); renderDeckOrderList(parent);
}

function moveDeckOrder(parent, name, dir){
const arr = Array.isArray(userSettings.deckOrder[parent]) ? [...userSettings.deckOrder[parent]] : [];
if(!arr.includes(name)) arr.push(name);
const i = arr.indexOf(name);
const j = i + dir;
if(j < 0 || j >= arr.length) return;
[arr[i], arr[j]] = [arr[j], arr[i]];
userSettings.deckOrder[parent] = arr;
saveLocal(); schedulePush(); renderHome(); renderDeckOrderList(parent);
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

function getDueForecast(days=7){
const start = startOfDay(Date.now());
const result = [];
for(let i=0;i<days;i++){
  const dayStart = start + i*86400000;
  const dayEnd = dayStart + 86400000;
  let count = 0;
  for(const st of Object.values(progress)){
    if(!st?.due) continue;
    if(st.due >= dayStart && st.due < dayEnd) count++;
  }
  result.push({
    label: new Date(dayStart).toLocaleDateString('de-DE',{weekday:'short', day:'2-digit', month:'2-digit'}),
    count
  });
}
return result;
}

function showInsights(){
const forecast = getDueForecast(14);
const total = forecast.reduce((acc,d)=>acc+d.count,0);
const max = Math.max(1, ...forecast.map(f=>f.count));
const bars = forecast.map(f=>`<div style="display:flex;align-items:center;gap:8px"><div style="width:64px;font-size:11px;color:#8888aa">${f.label}</div><div style="flex:1;background:#20202c;height:8px;border-radius:6px;overflow:hidden"><div style="height:100%;width:${Math.round((f.count/max)*100)}%;background:#6e66ff"></div></div><div style="width:26px;text-align:right;font-size:12px">${f.count}</div></div>`).join('');
document.getElementById('insightsContent').innerHTML = `<div class="settings-group"><div class="settings-group-title">Nächste 14 Tage</div><div class="settings-card" style="padding:14px"><div style="font-size:13px;color:#8888aa;margin-bottom:10px">Gesamt fällig im Zeitraum: <b style="color:#f0f0f8">${total}</b></div><div style="display:flex;flex-direction:column;gap:6px">${bars}</div></div></div>`;
openModal('insightsModal');
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
