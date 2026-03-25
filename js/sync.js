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

// Push settings (includes deck activation + fun mode settings)
const existingSettings = await ghRequest('GET', 'kanji-settings.json');
await ghPushFile('kanji-settings.json', userSettings, existingSettings?.sha);

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

// Pull settings - remote wins
const settingsFile = await ghRequest('GET', 'kanji-settings.json');
if(settingsFile?.content){
  const remoteSettings = decodeFromGH(settingsFile.content);
  userSettings = {
    ...userSettings,
    ...remoteSettings,
    deckEnabled: remoteSettings.deckEnabled && typeof remoteSettings.deckEnabled === 'object' ? remoteSettings.deckEnabled : (userSettings.deckEnabled || {}),
  };
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
