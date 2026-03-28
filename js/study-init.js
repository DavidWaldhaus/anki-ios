// ══════════════════════════════════════════════
//  STUDY SESSION
// ══════════════════════════════════════════════
function buildStudyQueue(cards, opts={}) {
window._sessionStart = Date.now();
const seen = new Set();
const learning = [], due = [], newCards = [];
const perDeckNew = {};

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
const selectedNew = [];
for(const c of newCards){
const deckName = decks[c.did]?.name;
if(!deckName) continue;
const used = perDeckNew[deckName] || 0;
const seenToday = getNewSeenTodayForDeck(deckName);
const remaining = Math.max(0, maxNew - seenToday);
if(used >= remaining) continue;
perDeckNew[deckName] = used + 1;
selectedNew.push(c);
}
// Learning cards first (already in progress), then reviews, then new
return [...learning, ...due, ...selectedNew];
}

function getEligibleDecksForFunMode(){
const filter = userSettings.funModeDeckFilter === 'all' ? 'all' : 'active';
return Object.values(decks).filter(d => filter === 'all' || isDeckEnabled(d.name));
}

function buildFunQueue(mode, count){
const eligibleCards = [];
for(const deck of getEligibleDecksForFunMode()) eligibleCards.push(...deck.cards);
const learned = eligibleCards.filter(c => !!getState(c.nid, c.ord));
if(!learned.length) return [];
let pool = learned.slice();
if(mode === 'worst'){
  pool.sort((a,b)=>{
    const sa = getState(a.nid,a.ord) || {};
    const sb = getState(b.nid,b.ord) || {};
    const wa = (num(sa.lapses,0)*2) + (2.5-num(sa.ease,2.5))*4 + (num(sa.interval,0)<7?2:0);
    const wb = (num(sb.lapses,0)*2) + (2.5-num(sb.ease,2.5))*4 + (num(sb.interval,0)<7?2:0);
    return wb-wa;
  });
  pool = pool.slice(0, Math.min(pool.length, count*4));
}
shuffle(pool);
return pool.slice(0, Math.min(count, pool.length));
}

function startFunMode(mode){
const count = Math.max(5, Math.min(200, userSettings.funModeCount || 30));
const queue = buildFunQueue(mode, count);
if(!queue.length){
  toast('Keine gelernten Karten für diesen Modus gefunden');
  return;
}
sessionMode = mode === 'worst' ? 'fun-worst' : 'fun-random';
sessionStats={again:0,hard:0,good:0,easy:0};
window._sessionRequeues = {};
studyQueue = queue;
studyIdx = 0;
document.getElementById('studyTitle').textContent = mode === 'worst' ? '🎯 Schwächste Karten (Fun)' : '🎲 Zufallsmodus (Fun)';
closeModal('settingsModal');
showScreen('studyScreen');
nextCard();
}

function getCardsForCustomFunSelection(sel){
if(!sel) return Object.values(decks).flatMap(d=>d.cards);
if(sel.startsWith('deck:')){
  const did = sel.slice(5);
  return decks[did]?.cards ? [...decks[did].cards] : [];
}
if(sel.startsWith('group:')){
  return getAllCardsForNodeByName(sel.slice(6));
}
return [];
}

function startCustomFunMode(){
const count = Math.max(5, Math.min(200, userSettings.funModeCount || 30));
const selection = userSettings.funModeCustomDeck || '';
let cards = getCardsForCustomFunSelection(selection);
if(userSettings.funModeDeckFilter !== 'all'){
  cards = cards.filter(c => isDeckEnabled(decks[c.did]?.name));
}
const learned = cards.filter(c => !!getState(c.nid, c.ord));
if(!learned.length){ toast('Keine passenden gelernten Karten gefunden'); return; }
if(userSettings.funModeCustomOrder === 'random') shuffle(learned);
const queue = learned.slice(0, Math.min(count, learned.length));
sessionMode = 'fun-custom';
sessionStats={again:0,hard:0,good:0,easy:0};
window._sessionRequeues = {};
studyQueue = queue;
studyIdx = 0;
document.getElementById('studyTitle').textContent = '🕹️ Deck-Fun-Modus';
closeModal('settingsModal');
showScreen('studyScreen');
nextCard();
}

function startStudy(did){
const deck = decks[did];
if(!deck) return;
sessionMode = 'normal';
sessionStats={again:0,hard:0,good:0,easy:0};
window._sessionRequeues = {};
studyQueue=buildStudyQueue(deck.cards, {singleDeck: deck.name});
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
sessionMode = 'normal';
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
sessionStats[rk]++;
let newSt = oldSt;

if(sessionMode === 'normal'){
newSt = schedule(oldSt, rating);
setState(c.nid, c.ord, newSt);
if(!oldSt || oldSt.type===undefined){
  const deckName = decks[c.did]?.name;
  bumpNewSeenTodayForDeck(deckName, 1);
}
recordStudied(1);
schedulePush();
}else{
// Fun mode: keep asking until each card gets rated "Leicht" once.
if(rating !== R.easy){
const reinsertAt = Math.min(studyIdx + 4, studyQueue.length);
studyQueue.splice(reinsertAt, 0, c);
}
}

// Re-queue learning cards within session (until graduated)
if(!window._sessionRequeues) window._sessionRequeues = {};
const reqKey = `${c.cid}_${c.ord}`;
if(sessionMode === 'normal' && newSt.type < 2){
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
if(sessionMode === 'normal') setState(card.nid, card.ord, oldSt);
sessionStats.again = Math.max(0, sessionStats.again - (R['again']===1?1:0));
// Re-insert card at previous position
studyQueue.splice(prevIdx, 0, card);
studyIdx = prevIdx;
if(sessionMode === 'normal') recordStudied(-1); // undo the count
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
const fun = sessionMode !== 'normal';
document.getElementById('cardStage').innerHTML=`<div class="done-wrap"> <div class="done-icon">${allDone?'🎌':'🎉'}</div> <div class="done-title">${allDone?'Alles erledigt!':'Sitzung beendet!'}</div> <div class="done-sub">${allDone?'Für heute alle Karten fertig. Bis morgen!':total+' Karten gelernt'}</div> ${total?`<div class="done-row">
<div class="done-stat"><div class="done-stat-val" style="color:#ff4d6d">${sessionStats.again}</div><div class="done-stat-lbl">Nochmal</div></div>
<div class="done-stat"><div class="done-stat-val" style="color:#3ecf8e">${correct}</div><div class="done-stat-lbl">Richtig</div></div>
<div class="done-stat"><div class="done-stat-val">${pct}%</div><div class="done-stat-lbl">Quote</div></div>
</div>
<div style="font-size:13px;color:#8888aa;margin-top:4px">🔥 ${streak} Tage Streak</div>`:''}
${fun?'<div style="font-size:12px;color:#8888aa">Fun-Modus: Kein Einfluss auf Karten-Intervalle.</div>':''}
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
function goHome(){sessionMode='normal'; showScreen('homeScreen');renderHome()}

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
