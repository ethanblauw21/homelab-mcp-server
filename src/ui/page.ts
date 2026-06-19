/**
 * ADR-010 §4 — deliberately boring stack. The entire frontend is ONE self-contained
 * static HTML document with inline CSS + vanilla JS (no bundler, no SPA framework,
 * no node_modules for the frontend). It fetches the renderer's /api/* JSON and, when
 * the executor is enabled, POSTs to /action/*. Keeping it a single exported string
 * means there are no static files to copy into dist/ — the sidecar stays cheap.
 *
 * The page renders cached panels with their snapshot-age labels (the honest-UI rule)
 * and disables live-action buttons in strict renderer-only mode.
 */
export const INDEX_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>homelab — local dashboard</title>
<style>
  :root { --bg:#0f1419; --panel:#1a2029; --line:#2b3340; --fg:#d7dde5; --muted:#8b97a7;
          --ok:#3fb950; --warn:#d29922; --crit:#f85149; --accent:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  header { display:flex; align-items:center; gap:12px; padding:12px 18px; border-bottom:1px solid var(--line); background:var(--panel); }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  .badge { font-size:12px; padding:2px 8px; border-radius:10px; border:1px solid var(--line); color:var(--muted); }
  .badge.live { color:var(--ok); border-color:var(--ok); }
  .badge.strict { color:var(--warn); border-color:var(--warn); }
  nav { display:flex; gap:4px; padding:8px 18px 0; border-bottom:1px solid var(--line); background:var(--panel); }
  nav button { background:none; border:none; color:var(--muted); padding:8px 14px; cursor:pointer; border-bottom:2px solid transparent; font-size:13px; }
  nav button.active { color:var(--fg); border-bottom-color:var(--accent); }
  main { padding:18px; max-width:1100px; }
  .age { color:var(--muted); font-size:12px; margin-bottom:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; margin-bottom:10px; }
  .row { display:flex; justify-content:space-between; gap:12px; align-items:center; }
  .status-ok{color:var(--ok)} .status-warn{color:var(--warn)} .status-crit{color:var(--crit)}
  .tag { font-size:11px; padding:1px 7px; border-radius:9px; border:1px solid var(--line); }
  .tag.explained { color:var(--ok); border-color:var(--ok); }
  .tag.unexplained { color:var(--crit); border-color:var(--crit); }
  code, .mono { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; }
  button.act { background:var(--accent); color:#04101f; border:none; border-radius:6px; padding:5px 10px; cursor:pointer; font-size:12px; font-weight:600; }
  button.act:disabled { background:var(--line); color:var(--muted); cursor:not-allowed; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); font-size:12px; vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  .empty { color:var(--muted); padding:24px; text-align:center; }
  .toolbar { margin-bottom:10px; display:flex; gap:8px; flex-wrap:wrap; }
  input,select { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 8px; font-size:12px; }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; overflow:auto; max-height:420px; }
</style>
</head>
<body>
<header>
  <h1>homelab</h1>
  <span class="badge" id="host">…</span>
  <span class="badge" id="tier">tier: …</span>
  <span class="badge" id="mode">…</span>
  <span style="flex:1"></span>
  <span class="age" id="clock"></span>
</header>
<nav id="tabs">
  <button data-tab="drift" class="active">Drift</button>
  <button data-tab="census">Census</button>
  <button data-tab="health">Health</button>
  <button data-tab="audit">Audit</button>
  <button data-tab="changes">Changes</button>
  <button data-tab="metrics">Metrics</button>
</nav>
<main id="view"><div class="empty">Loading…</div></main>

<script>
const view = document.getElementById('view');
let STATUS = { actionsEnabled:false, availableActions:[] };

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function getJSON(u){ const r = await fetch(u); if(!r.ok) throw new Error('HTTP '+r.status+' '+(await r.text())); return r.json(); }
async function postAction(tool, body){
  const r = await fetch('/action/'+encodeURIComponent(tool), {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body||{})});
  const txt = await r.text();
  if(!r.ok) throw new Error(txt);
  return txt ? JSON.parse(txt) : {};
}
function ageLine(p){ return '<div class="age">'+esc(p.ageLabel||'')+'</div>'; }

const tabs = {
  async drift(){
    const p = await getJSON('/api/drift');
    if(!p.available){ return '<div class="empty">No drift report cached yet. Run verify_integrity from an MCP session'+(STATUS.availableActions.includes('verify_integrity')?', or click below.':'.')+'</div>'+verifyBtn(); }
    const rep = p.data || {};
    const leaves = (rep.drift||[]);
    const flagged = leaves.filter(l => l.status==='unexplained');
    let h = ageLine(p) + verifyBtn();
    // ADR-018 §1: a seeded run did NOT detect — never let it read as "all clear".
    // mode is authoritative; pre-018 snapshots fall back to baselineSeeded.
    const seeded = rep.mode==='seeded' || (rep.mode===undefined && rep.baselineSeeded);
    if(seeded){
      const reseed = rep.seededReason==='level-changed';
      const msg = esc(rep.note || 'Baseline established — drift detection begins on the next run.');
      h += '<div class="card '+(reseed?'status-warn':'')+'"><strong>'+(reseed?'Baseline RE-SEEDED — detection was NOT running':'Baseline seeded — no detection yet')+'</strong><br>'+msg+'</div>';
      return h;
    }
    h += '<div class="toolbar">';
    if(canAct('accept_truth') && flagged.length) h += '<button class="act" onclick="acceptScope(\'\')">Accept ALL flagged ('+flagged.length+')</button>';
    h += '</div>';
    if(!leaves.length) h += '<div class="card status-ok">No drift — forest matches baseline.</div>';
    h += '<table><thead><tr><th>Path</th><th>Levels</th><th>Status</th><th></th></tr></thead><tbody>';
    for(const l of leaves){
      const lv = ['l1','l2','l3'].filter(k=>l[k]).join(' ');
      const acceptCell = (l.status==='unexplained' && canAct('accept_truth'))
        ? '<button class="act" onclick="acceptScope('+JSON.stringify(l.path)+')">Accept</button>' : '';
      h += '<tr><td class="mono">'+esc(l.path)+(l.explainedBy?'<br><span class="age">by '+esc(l.explainedBy.tool||l.explainedBy.auditId||'')+'</span>':'')+'</td>'
        + '<td class="mono">'+esc(lv)+'</td>'
        + '<td><span class="tag '+esc(l.status)+'">'+esc(l.status)+'</span></td>'
        + '<td>'+acceptCell+'</td></tr>';
    }
    h += '</tbody></table>';
    return h;
  },
  async census(){
    const p = await getJSON('/api/census');
    if(!p.available) return '<div class="empty">No census snapshot yet. Run describe_homelab from an MCP session.</div>';
    return ageLine(p) + '<pre class="mono">'+esc(JSON.stringify(p.data,null,2))+'</pre>';
  },
  async health(){
    const p = await getJSON('/api/health');
    if(!p.available) return '<div class="empty">No health snapshot yet. Run health_check from an MCP session.</div>';
    const d = p.data||{}; let h = ageLine(p);
    h += '<div class="card row"><strong>Rollup</strong><span class="status-'+esc(d.status)+'">'+esc((d.status||'').toUpperCase())+'</span></div>';
    for(const f of (d.findings||[])){
      h += '<div class="card row"><span><span class="age">'+esc(f.section)+'</span> &nbsp;'+esc(f.check)+' — '+esc(f.finding||'')+'</span><span class="status-'+esc(f.status)+'">'+esc(f.status)+'</span></div>';
    }
    for(const e of (d.errors||[])) h += '<div class="card status-warn">'+esc(e.section)+': '+esc(e.error)+'</div>';
    return h;
  },
  async audit(){
    const p = await getJSON('/api/audit?limit=100');
    const recs = p.records||[];
    let h = '<div class="card row"><span>'+ (p.summary? esc(p.summary.total)+' records':'') +'</span></div>';
    h += '<table><thead><tr><th>When</th><th>Tool</th><th>Target</th><th>Scope</th></tr></thead><tbody>';
    for(const r of recs){
      const tgt = r.path || (r.vmid!=null?('vmid '+r.vmid):'') || r.cmd || '';
      h += '<tr><td class="mono">'+esc(r.ts)+'</td><td>'+esc(r.tool)+'</td><td class="mono">'+esc(tgt)+'</td><td class="mono">'+esc(r.hashScope||'')+'</td></tr>';
    }
    h += '</tbody></table>';
    return h;
  },
  async changes(){
    const p = await getJSON('/api/changes');
    if(!p.available) return '<div class="empty">'+esc(p.ageLabel)+'</div>';
    let h = ageLine(p) + '<table><thead><tr><th>When</th><th>Author</th><th>Change</th></tr></thead><tbody>';
    for(const c of (p.data||[])) h += '<tr><td class="mono">'+esc(c.date)+'</td><td>'+esc(c.author)+'</td><td>'+esc(c.subject)+' <span class="age mono">'+esc((c.hash||'').slice(0,8))+'</span></td></tr>';
    return h + '</tbody></table>';
  },
  async metrics(){
    // ADR-015 — three derived-metric panels: audit stats, drift trend, backup health.
    const [ap, dp, bp] = await Promise.all([
      getJSON('/api/stats/audit'), getJSON('/api/stats/drift'), getJSON('/api/stats/backups')
    ]);
    let h = '';

    // Drift trend — the flagship (tamper-pressure over time).
    h += '<div class="card"><div class="row"><strong>Unexplained drift trend</strong>';
    if(dp.available){
      const d = dp.data||{};
      const arrow = d.trend==='up'?'▲':d.trend==='down'?'▼':d.trend==='flat'?'▬':'—';
      const cls = d.trend==='up'?'status-crit':d.trend==='down'?'status-ok':'';
      h += '<span class="'+cls+'">'+esc(arrow)+' latest '+esc(d.latestUnexplained)+(d.previousUnexplained!=null?(' (prev '+esc(d.previousUnexplained)+')'):'')+'</span>';
    } else h += '<span class="age">no runs cached</span>';
    h += '</div>';
    if(dp.available){
      h += ageLine(dp);
      const d = dp.data||{};
      if(d.sensitiveEverNonZero) h += '<div class="card status-crit">Sensitive-path drift observed in a retained run — investigate.</div>';
      h += '<table><thead><tr><th>When</th><th>Lvl</th><th>Total</th><th>Explained</th><th>Unexplained</th><th>L1-only</th><th>Sensitive</th></tr></thead><tbody>';
      for(const r of (d.runs||[]).slice().reverse()){
        h += '<tr><td class="mono">'+esc(r.savedAt)+'</td><td>'+esc(r.level)+(r.seeded?' <span class="age">(seeded)</span>':'')+'</td><td>'+esc(r.total)+'</td>'
          + '<td class="status-ok">'+esc(r.explained)+'</td><td class="'+(r.unexplained>0?'status-crit':'')+'">'+esc(r.unexplained)+'</td>'
          + '<td>'+esc(r.l1OnlyTouches)+'</td><td class="'+(r.sensitive>0?'status-crit':'')+'">'+esc(r.sensitive)+'</td></tr>';
      }
      h += '</tbody></table>';
    }
    h += '<div class="age">'+esc(dp.note||'')+'</div></div>';

    // Backup-store health.
    h += '<div class="card"><strong>Backup store</strong>';
    if(bp.available){
      const b = bp.data||{};
      const pct = Math.round((b.usedFraction||0)*100);
      h += '<div class="row"><span>Capacity</span><span class="'+(b.overCap?'status-crit':pct>=80?'status-warn':'status-ok')+'">'
        + esc(fmtBytes(b.totalBytes))+' / '+esc(fmtBytes(b.globalSizeCapBytes))+' ('+esc(pct)+'%)</span></div>';
      h += '<div class="row"><span>Versions / targets</span><span>'+esc(b.totalVersions)+' over '+esc(b.targetCount)+' target(s)</span></div>';
      h += '<div class="row"><span>At cap / near cap</span><span class="'+(b.targetsAtCap>0?'status-warn':'')+'">'+esc(b.targetsAtCap)+' / '+esc(b.targetsNearCap)+' (cap '+esc(b.perFileVersionCap)+')</span></div>';
      const km = b.kindMix||{};
      h += '<div class="row"><span>Kind mix</span><span>'+esc(km.delta)+' delta · '+esc(km.selfContained)+' self-contained · '+esc(km.metadataOnly)+' meta-only</span></div>';
      h += '<div class="row"><span>Re-anchors (out-of-band churn)</span><span class="'+(b.reanchorCount>0?'status-warn':'status-ok')+'">'+esc(b.reanchorCount)+' ('+Math.round((b.reanchorFraction||0)*100)+'%)</span></div>';
    } else h += '<div class="age">no backups stored yet</div>';
    h += '<div class="age">'+esc(bp.note||'')+'</div></div>';

    // Audit-derived stats.
    h += '<div class="card"><strong>Audit activity</strong>';
    if(ap.available){
      const a = ap.data||{}; const fam = a.family||{};
      h += ageLine(ap);
      h += '<div class="row"><span>Total ops (window)</span><span>'+esc(a.total)+'</span></div>';
      h += '<div class="row"><span>By family</span><span>'+esc(fam.write)+' write · '+esc(fam.exec)+' exec · '+esc(fam.read)+' read · '+esc(fam.other)+' other</span></div>';
      h += '<div class="row"><span>Large / heavy</span><span>'+esc(a.largeChangeCount)+' large · '+esc(a.heavyCount)+' heavy</span></div>';
      h += '<div class="row"><span>Gated / root-tier</span><span>'+esc(a.confirmGatedCount)+' confirm · '+esc(a.rootTierCount)+' root</span></div>';
      h += '<div class="row"><span>History misses</span><span class="'+(a.historyMissCount>0?'status-warn':'status-ok')+'">'+esc(a.historyMissCount)+' / '+esc(a.historyEligibleCount)+' ('+Math.round((a.historyMissRate||0)*100)+'%)</span></div>';
      h += '<div class="row"><span>Timeouts / signal-kills</span><span class="'+((a.timedOutCount+a.signalKillCount)>0?'status-warn':'status-ok')+'">'+esc(a.timedOutCount)+' timed out · '+esc(a.signalKillCount)+' killed</span></div>';
      h += '<div class="row"><span>Unknown-scope exec (drift blind spot)</span><span class="'+(a.unknownScopeCount>0?'status-warn':'')+'">'+esc(a.unknownScopeCount)+' / '+esc(a.execTotal)+'</span></div>';
      const tp = (a.throughput||[]);
      if(tp.length){
        h += '<div class="age">Throughput ('+esc(a.bucket)+')</div><table><thead><tr><th>Bucket</th><th>Total</th><th>Write</th><th>Exec</th><th>Read</th></tr></thead><tbody>';
        for(const t of tp.slice(-30)) h += '<tr><td class="mono">'+esc(t.bucket)+'</td><td>'+esc(t.total)+'</td><td>'+esc(t.write)+'</td><td>'+esc(t.exec)+'</td><td>'+esc(t.read)+'</td></tr>';
        h += '</tbody></table>';
      }
    } else h += '<div class="age">no audit records yet</div>';
    h += '<div class="age">'+esc(ap.note||'')+'</div></div>';

    return h;
  },
};

function fmtBytes(n){
  n = Number(n)||0; const u=['B','KB','MB','GB']; let i=0;
  while(n>=1024 && i<u.length-1){ n/=1024; i++; }
  return (i===0?n:n.toFixed(1))+' '+u[i];
}

function canAct(tool){ return STATUS.actionsEnabled && STATUS.availableActions.includes(tool); }
function verifyBtn(){
  if(!canAct('verify_integrity')) return '';
  return '<div class="toolbar"><button class="act" onclick="runVerify()">Run verify_integrity (live)</button></div>';
}
async function runVerify(){
  try { await postAction('verify_integrity', { level:'smart' }); await render('drift'); }
  catch(e){ alert('verify failed: '+e.message); }
}
async function acceptScope(scope){
  if(!confirm('Accept (bless) drift for '+(scope||'the WHOLE forest')+'? This folds the current state into the baseline.')) return;
  try { await postAction('accept_truth', { scope }); await render('drift'); }
  catch(e){ alert('accept_truth failed: '+e.message); }
}

let current = 'drift';
async function render(tab){
  current = tab;
  for(const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab===tab);
  view.innerHTML = '<div class="empty">Loading…</div>';
  try { view.innerHTML = await tabs[tab](); }
  catch(e){ view.innerHTML = '<div class="empty status-crit">'+esc(e.message)+'</div>'; }
}
document.getElementById('tabs').addEventListener('click', e=>{ if(e.target.dataset.tab) render(e.target.dataset.tab); });

async function boot(){
  try {
    STATUS = await getJSON('/api/status');
    document.getElementById('host').textContent = STATUS.host || 'host';
    document.getElementById('tier').textContent = 'tier: ' + STATUS.tier;
    const mode = document.getElementById('mode');
    mode.textContent = STATUS.actionsEnabled ? 'live actions' : 'renderer-only';
    mode.className = 'badge ' + (STATUS.actionsEnabled ? 'live' : 'strict');
  } catch(e){ /* status best-effort */ }
  render(current);
}
boot();
</script>
</body>
</html>`;
