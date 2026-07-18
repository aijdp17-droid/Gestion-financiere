let hidden = false;
let txFilter = 'all';
let debtFilter = 'lent';
let calDate = new Date(2026,6,1);
let selectedDay = 18;
let editingTxId = null;
let editingDebtId = null;
let txDateOverride = null;

/* ---------- Supabase ---------- */
const SUPABASE_URL = 'https://rpmutmocylvzjzknhsbi.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fFm0NQI0ZkxMyGjEMmOwIg_p1wls3Pv';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;   // ilay olona tafiditra (auth.users)
let queueKey = null;      // localStorage key an'ny "queue" offline an'io olona io
let refCounter = 1;       // isa an-tsokajy ho an'ny hetsika mbola tsy voarakitra any Supabase
let syncing = false;

function emptyState(){
  return {
    transactions: [],
    debts: [],
    profile: { name:'', email:'', avatar:null, pin:'0000', lastBackup:null }
  };
}

let authMode = 'login';

// state always points at the data object of whichever account is logged in.
// Before login it points at an empty template so background rendering
// (hidden behind the auth gate) has something valid to read.
let state = emptyState();

function formatAr(n){
  return new Intl.NumberFormat('fr-FR').format(Math.round(n)) + ' Ar';
}
function initials(name){
  return name.trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
}
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._h);
  showToast._h = setTimeout(()=>t.classList.remove('show'), 2400);
}

function switchTab(tab){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active', p.id==='panel-'+tab));
  if(tab==='calendar') renderCalendar();
  if(tab==='stats') renderStats();
}
document.getElementById('tabBar').addEventListener('click', e=>{
  const b = e.target.closest('.tab-btn');
  if(b) switchTab(b.dataset.tab);
});

function toggleHide(){
  hidden = !hidden;
  document.getElementById('eyeBtn').textContent = hidden ? '👁 Afficher le solde' : '👁 Masquer le solde';
  renderDashboard();
}

function computeTotals(){
  let income=0, expense=0;
  state.transactions.forEach(t=> t.type==='income' ? income+=t.amount : expense+=t.amount);
  let owed = state.debts.filter(d=>d.type==='borrowed' && d.status==='unpaid').reduce((s,d)=>s+d.amount,0);
  let due = state.debts.filter(d=>d.type==='lent' && d.status==='unpaid').reduce((s,d)=>s+d.amount,0);
  return {income, expense, balance: income-expense, owed, due};
}

/* ---------- Supabase: chargement des données ---------- */
function rowToTx(r){
  return { id:r.id, _ref:refCounter++, type:r.type, amount:Number(r.amount), category:r.category, note:r.note||'', date:new Date(r.tx_date) };
}
function rowToDebt(r){
  return { id:r.id, _ref:refCounter++, type:r.type, person:r.person, amount:Number(r.amount), status:r.status, date:new Date(r.debt_date), due: r.due_date ? new Date(r.due_date) : null };
}

async function loadUserData(user){
  currentUser = user;
  queueKey = 'lamina_queue_' + user.id;

  const [profileRes, txRes, debtRes] = await Promise.all([
    sb.from('profiles').select('*').eq('id', user.id).single(),
    sb.from('transactions').select('*').eq('user_id', user.id).order('tx_date', {ascending:false}),
    sb.from('debts').select('*').eq('user_id', user.id).order('debt_date', {ascending:false})
  ]);

  const profile = profileRes.data;
  state = {
    transactions: (txRes.data||[]).map(rowToTx),
    debts: (debtRes.data||[]).map(rowToDebt),
    profile: {
      name: (profile && profile.name) || user.user_metadata?.name || '',
      email: (profile && profile.email) || user.email,
      avatar: (profile && profile.avatar_url) || null,
      pin: (profile && profile.pin) || '0000',
      lastBackup: profile && profile.last_backup ? new Date(profile.last_backup) : null
    }
  };

  updateSyncBanner(loadQueue().length);
  if(navigator.onLine) processQueue();
}

/* ---------- Supabase: "queue" hors-ligne ---------- */
function loadQueue(){
  if(!queueKey) return [];
  try{ return JSON.parse(localStorage.getItem(queueKey) || '[]'); }
  catch(e){ return []; }
}
function saveQueueList(list){
  if(!queueKey) return;
  localStorage.setItem(queueKey, JSON.stringify(list));
  updateSyncBanner(list.length);
}
function updateSyncBanner(count){
  const el = document.getElementById('syncBanner');
  if(!el) return;
  if(count > 0){
    el.style.display = 'block';
    el.textContent = (navigator.onLine ? '⏳ Mandeha ny fandefasana… ' : '📴 Tsy misy internet — ') + count + ' hetsika mbola miandry sync';
  } else {
    el.style.display = 'none';
  }
}

function queueInsert(table, ref, payload){
  const list = loadQueue();
  list.push({table, action:'insert', ref, payload});
  saveQueueList(list);
  if(navigator.onLine) processQueue();
}
function queueUpdate(table, ref, id, payload){
  const list = loadQueue();
  const pendingInsert = list.find(op => op.table===table && op.action==='insert' && op.ref===ref);
  if(pendingInsert){
    Object.assign(pendingInsert.payload, payload);
  } else {
    list.push({table, action:'update', id, payload});
  }
  saveQueueList(list);
  if(navigator.onLine) processQueue();
}
function queueDelete(table, ref, id){
  let list = loadQueue();
  const pendingInsertIdx = list.findIndex(op => op.table===table && op.action==='insert' && op.ref===ref);
  if(pendingInsertIdx !== -1){
    list.splice(pendingInsertIdx, 1); // tsy mbola tafiditra any Supabase, koa ampy ny manafoana ilay "insert"
  } else {
    list = list.filter(op => !(op.table===table && op.action==='update' && op.id===id));
    list.push({table, action:'delete', id});
  }
  saveQueueList(list);
  if(navigator.onLine) processQueue();
}
function queueProfileUpdate(payload){
  let list = loadQueue();
  list = list.filter(op => op.table !== 'profiles');
  list.push({table:'profiles', action:'update', id: currentUser.id, payload});
  saveQueueList(list);
  if(navigator.onLine) processQueue();
}

async function processQueue(){
  if(syncing || !queueKey || !navigator.onLine || !currentUser) return;
  syncing = true;
  const list = loadQueue();
  const remaining = [];
  for(const op of list){
    try{
      if(op.action === 'insert'){
        const {data, error} = await sb.from(op.table).insert({...op.payload, user_id: currentUser.id}).select().single();
        if(error) throw error;
        const arr = op.table==='transactions' ? state.transactions : state.debts;
        const obj = arr.find(x => x._ref === op.ref);
        if(obj) obj.id = data.id;
      } else if(op.action === 'update'){
        const {error} = await sb.from(op.table).update(op.payload).eq('id', op.id);
        if(error) throw error;
      } else if(op.action === 'delete'){
        const {error} = await sb.from(op.table).delete().eq('id', op.id);
        if(error) throw error;
      }
    } catch(e){
      remaining.push(op);
    }
  }
  saveQueueList(remaining);
  syncing = false;
  if(currentUser) renderAll();
}
window.addEventListener('online', processQueue);
window.addEventListener('offline', () => updateSyncBanner(loadQueue().length));

function txIcon(cat){
  const map = {Sakafo:'🍚', Trano:'🏠', Fitaterana:'🚕', Karama:'💼', Hetsika:'🎉', Trosa:'⇄', Hafa:'•'};
  return map[cat] || '•';
}

function renderDashboard(){
  const t = computeTotals();
  document.getElementById('dashBalance').textContent = hidden ? 'Ar ••••••' : formatAr(t.balance);
  document.getElementById('mIncome').textContent = hidden ? '•••••' : formatAr(t.income);
  document.getElementById('mExpense').textContent = hidden ? '•••••' : formatAr(t.expense);
  document.getElementById('mOwed').textContent = formatAr(t.owed);
  document.getElementById('mDue').textContent = formatAr(t.due);

  const recent = [...state.transactions].sort((a,b)=>b.date-a.date).slice(0,4);
  document.getElementById('dashRecent').innerHTML = recent.map(t=>txRowHtml(t,false)).join('') || '<div class="empty">Aucune transaction pour le moment.</div>';

  renderReminders();
}

function daysUntil(d){
  const now = new Date(2026,6,18);
  const a = new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const b = new Date(d.getFullYear(),d.getMonth(),d.getDate());
  return Math.round((b-a)/86400000);
}

function renderReminders(){
  const upcoming = state.debts
    .filter(d=>d.status==='unpaid' && d.due)
    .map(d=>({...d, left: daysUntil(d.due)}))
    .filter(d=>d.left<=3)
    .sort((a,b)=>a.left-b.left);

  const box = document.getElementById('reminderBlock');
  if(!upcoming.length){ box.innerHTML=''; return; }

  box.innerHTML = `
    <div class="reminder-box">
      <div class="reminder-title">⚠ Fampahatsiahivana trosa</div>
      ${upcoming.map(d=>{
        const label = d.left<0 ? `Efa tara ${Math.abs(d.left)} andro` : d.left===0 ? "Anio ny fara-fetiny" : `Reste ${d.left} andro`;
        const cls = d.left<0 ? '' : 'soon';
        const verb = d.type==='lent' ? "tokony handray amin'i" : "tokony handoa amin'i";
        return `<div class="reminder-item"><span>${verb} ${d.person} — ${formatAr(d.amount)}</span><span class="reminder-badge ${cls}">${label}</span></div>`;
      }).join('')}
    </div>`;
}

function txRowHtml(t, actionable){
  const sign = t.type==='income' ? '+' : '−';
  const actions = actionable ? `
    <div class="row-actions">
      <button class="icon-btn" title="Hanova" onclick="event.stopPropagation();editTx(${t.id})">✎</button>
      <button class="icon-btn danger" title="Hofafana" onclick="event.stopPropagation();deleteTx(${t.id})">🗑</button>
    </div>` : '';
  return `<div class="tx-row">
    <div class="tx-row-inner">
      <div class="tx-left">
        <div class="tx-dot ${t.type}">${txIcon(t.category)}</div>
        <div>
          <div class="tx-name">${t.note || t.category}</div>
          <div class="tx-meta">${t.category} · ${t.date.toLocaleDateString('fr-FR')}</div>
        </div>
      </div>
      <div class="tx-amount ${t.type}">${sign}${formatAr(t.amount)}</div>
    </div>
    ${actions}
  </div>`;
}

function setTxFilter(f){
  txFilter = f;
  switchTab('transactions');
  document.querySelectorAll('#txChips .chip').forEach(c=>c.classList.toggle('active', c.dataset.f===f));
  renderTransactions();
}
document.getElementById('txChips').addEventListener('click', e=>{
  const b = e.target.closest('.chip'); if(!b) return;
  txFilter = b.dataset.f;
  document.querySelectorAll('#txChips .chip').forEach(c=>c.classList.toggle('active', c===b));
  renderTransactions();
});

function renderTransactions(){
  let list = [...state.transactions].sort((a,b)=>b.date-a.date);
  if(txFilter!=='all') list = list.filter(t=>t.type===txFilter);
  document.getElementById('txList').innerHTML = list.map(t=>txRowHtml(t,true)).join('') || '<div class="empty">Aucune transaction dans cette catégorie.</div>';
}

document.getElementById('debtChips').addEventListener('click', e=>{
  const b = e.target.closest('.chip'); if(!b) return;
  debtFilter = b.dataset.f;
  document.querySelectorAll('#debtChips .chip').forEach(c=>c.classList.toggle('active', c===b));
  renderDebts();
});

function renderDebts(){
  let list = state.debts.filter(d=>d.type===debtFilter).sort((a,b)=>b.date-a.date);
  document.getElementById('debtList').innerHTML = list.map(d=>{
    const left = d.due ? daysUntil(d.due) : null;
    let dueHtml = '';
    if(d.due && d.status==='unpaid'){
      dueHtml = `<div class="due-note ${left<0?'overdue':''}">Fara-fetiny: ${d.due.toLocaleDateString('fr-FR')}${left<0?' · efa tara':''}</div>`;
    }
    return `
    <div class="debt-card">
      <div>
        <div class="tx-name">${d.person}</div>
        <div class="tx-meta">${d.date.toLocaleDateString('fr-FR')} · <span class="status ${d.status}">${d.status==='paid'?'Voahefa':'Tsy voahefa'}</span></div>
        ${dueHtml}
        <div class="debt-actions">
          ${d.status==='unpaid' ? `<button class="btn-small settle" onclick="settleDebt(${d.id})">Voahefa</button>` : ''}
          <button class="btn-small" onclick="editDebt(${d.id})">Hanova</button>
          <button class="btn-small" onclick="deleteDebt(${d.id})">Hofafana</button>
        </div>
      </div>
      <div class="tx-amount ${d.type==='lent'?'income':'expense'}">${formatAr(d.amount)}</div>
    </div>`;
  }).join('') || '<div class="empty">Aucune dette dans cette catégorie.</div>';
}

function settleDebt(id){
  const d = state.debts.find(x=>x.id===id);
  if(!d) return;
  d.status = 'paid';
  queueUpdate('debts', d._ref, d.id, {status:'paid'});
  const ref = refCounter++;
  const date = new Date();
  const newTx = {
    id: 'local-'+ref, _ref: ref,
    type: d.type==='lent' ? 'income' : 'expense',
    amount: d.amount,
    category: 'Trosa',
    note: 'Famerenam-bola — ' + d.person,
    date
  };
  state.transactions.push(newTx);
  queueInsert('transactions', ref, {type:newTx.type, amount:newTx.amount, category:'Trosa', note:newTx.note, tx_date: date.toISOString()});
  showToast('Trosa voamarina ho voahefa ✓');
  renderAll();
}

function deleteDebt(id){
  if(!confirm('Hofafana tokoa ve ity trosa ity?')) return;
  const d = state.debts.find(x=>x.id===id);
  state.debts = state.debts.filter(x=>x.id!==id);
  if(d) queueDelete('debts', d._ref, d.id);
  showToast('Trosa voafafa');
  renderAll();
}

function editDebt(id){
  const d = state.debts.find(x=>x.id===id);
  if(!d) return;
  editingDebtId = id;
  document.getElementById('debtModalTitle').textContent = 'Hanova trosa';
  document.getElementById('debtType').value = d.type;
  document.getElementById('debtPerson').value = d.person;
  document.getElementById('debtAmount').value = d.amount;
  document.getElementById('debtDue').value = d.due ? d.due.toISOString().slice(0,10) : '';
  openModal('debt');
}

function deleteTx(id){
  if(!confirm('Hofafana tokoa ve ity fisoratana ity?')) return;
  const t = state.transactions.find(x=>x.id===id);
  state.transactions = state.transactions.filter(x=>x.id!==id);
  if(t) queueDelete('transactions', t._ref, t.id);
  showToast('Transaction voafafa');
  renderAll();
}

function editTx(id){
  const t = state.transactions.find(x=>x.id===id);
  if(!t) return;
  editingTxId = id;
  document.getElementById('txType').value = t.type;
  document.getElementById('txAmount').value = t.amount;
  document.getElementById('txCategory').value = t.category;
  document.getElementById('txNote').value = t.note || '';
  openModal('tx');
}

function openModal(kind){
  if(kind==='tx' && editingTxId===null){
    document.getElementById('txType').value='expense';
    document.getElementById('txAmount').value='';
    document.getElementById('txCategory').value='Sakafo';
    document.getElementById('txNote').value='';
  }
  if(kind==='tx'){
    const info = document.getElementById('txDateInfo');
    if(txDateOverride){
      info.style.display = 'block';
      info.textContent = `📅 Ho ampidirina amin'ny ${txDateOverride.toLocaleDateString('fr-FR')}`;
    } else {
      info.style.display = 'none';
    }
  }
  if(kind==='debt' && editingDebtId===null){
    document.getElementById('debtModalTitle').textContent = 'Nouvelle dette';
    document.getElementById('debtType').value='lent';
    document.getElementById('debtPerson').value='';
    document.getElementById('debtAmount').value='';
    document.getElementById('debtDue').value='';
  }
  document.getElementById('modal-'+kind).classList.add('open');
}
function closeModal(kind){
  document.getElementById('modal-'+kind).classList.remove('open');
  if(kind==='tx'){ editingTxId = null; txDateOverride = null; }
  if(kind==='debt') editingDebtId = null;
}

function saveTx(){
  const amount = parseFloat(document.getElementById('txAmount').value);
  if(!amount || amount<=0){ document.getElementById('txAmount').focus(); return; }
  const payload = {
    type: document.getElementById('txType').value,
    amount: amount,
    category: document.getElementById('txCategory').value,
    note: document.getElementById('txNote').value,
  };
  const wasFromCalendar = !!txDateOverride;
  if(editingTxId!==null){
    const t = state.transactions.find(x=>x.id===editingTxId);
    Object.assign(t, payload);
    queueUpdate('transactions', t._ref, t.id, {type:t.type, amount:t.amount, category:t.category, note:t.note||null});
    showToast('Transaction voavaozina ✓');
  } else {
    const date = txDateOverride || new Date();
    const ref = refCounter++;
    const newTx = {id:'local-'+ref, _ref: ref, date, ...payload};
    state.transactions.push(newTx);
    queueInsert('transactions', ref, {type:payload.type, amount:payload.amount, category:payload.category, note:payload.note||null, tx_date: date.toISOString()});
    showToast('Transaction voatahiry ✓');
  }
  txDateOverride = null;
  closeModal('tx');
  renderAll();
  if(wasFromCalendar){
    selectedDay = new Date(state.transactions[state.transactions.length-1] ? state.transactions[state.transactions.length-1].date : new Date()).getDate();
    switchTab('calendar');
  }
}

function saveDebt(){
  const amount = parseFloat(document.getElementById('debtAmount').value);
  const person = document.getElementById('debtPerson').value.trim();
  const dueVal = document.getElementById('debtDue').value;
  if(!amount || amount<=0 || !person){ return; }
  const payload = {
    type: document.getElementById('debtType').value,
    person: person,
    amount: amount,
    due: dueVal ? new Date(dueVal+'T00:00:00') : null,
  };
  if(editingDebtId!==null){
    const d = state.debts.find(x=>x.id===editingDebtId);
    Object.assign(d, payload);
    queueUpdate('debts', d._ref, d.id, {type:d.type, person:d.person, amount:d.amount, due_date: d.due ? d.due.toISOString() : null});
    showToast('Trosa voavaozina ✓');
  } else {
    const date = new Date();
    const ref = refCounter++;
    const newDebt = {id:'local-'+ref, _ref: ref, status:'unpaid', date, ...payload};
    state.debts.push(newDebt);
    queueInsert('debts', ref, {type:payload.type, person:payload.person, amount:payload.amount, status:'unpaid', debt_date: date.toISOString(), due_date: payload.due ? payload.due.toISOString() : null});
    showToast('Trosa voatahiry ✓');
  }
  closeModal('debt');
  renderAll();
  switchTab('debts');
}

function changeMonth(delta){
  calDate = new Date(calDate.getFullYear(), calDate.getMonth()+delta, 1);
  renderCalendar();
}

function renderCalendar(){
  const y = calDate.getFullYear(), m = calDate.getMonth();
  document.getElementById('calLabel').textContent = calDate.toLocaleDateString('fr-FR',{month:'long', year:'numeric'});
  const firstDow = (new Date(y,m,1).getDay()+6)%7;
  const daysInMonth = new Date(y,m+1,0).getDate();
  const dows = ['Lu','Ma','Me','Je','Ve','Sa','Di'];
  let html = dows.map(d=>`<div class="cal-dow">${d}</div>`).join('');
  for(let i=0;i<firstDow;i++) html += `<div class="cal-day empty-cell"></div>`;
  for(let d=1; d<=daysInMonth; d++){
    const hasTx = state.transactions.some(t=>t.date.getFullYear()===y && t.date.getMonth()===m && t.date.getDate()===d);
    const isSel = d===selectedDay;
    html += `<div class="cal-day ${isSel?'selected':''}" onclick="selectDay(${d})">${d}${hasTx?'<span class="dot"></span>':''}</div>`;
  }
  document.getElementById('calGrid').innerHTML = html;
  renderCalList();
}

function selectDay(d){ selectedDay = d; renderCalendar(); }

function openTxModalForSelectedDay(){
  const now = new Date();
  txDateOverride = new Date(calDate.getFullYear(), calDate.getMonth(), selectedDay, now.getHours(), now.getMinutes());
  openModal('tx');
}

function renderCalList(){
  const y = calDate.getFullYear(), m = calDate.getMonth();
  const list = state.transactions.filter(t=>t.date.getFullYear()===y && t.date.getMonth()===m && t.date.getDate()===selectedDay);
  document.getElementById('calListTitle').textContent = `Hetsika amin'ny ${selectedDay}`;
  document.getElementById('calList').innerHTML = list.map(t=>txRowHtml(t,true)).join('') || '<div class="empty">Tsy misy hetsika tamin\'io andro io.</div>';
}

function renderStats(){
  const cats = {};
  state.transactions.filter(t=>t.type==='expense').forEach(t=>{ cats[t.category]=(cats[t.category]||0)+t.amount; });
  const colors = ['#1D6FD6','#12805F','#C24B33','#B98A2E','#7A5FB0','#4A5D72'];
  const total = Object.values(cats).reduce((a,b)=>a+b,0) || 1;
  let acc = 0;
  const stops = Object.entries(cats).map(([cat,val],i)=>{
    const start = acc/total*360; acc+=val; const end = acc/total*360;
    return `${colors[i%colors.length]} ${start}deg ${end}deg`;
  }).join(', ');
  document.getElementById('pieChart').style.background = Object.keys(cats).length ? `conic-gradient(${stops})` : 'var(--sand)';
  document.getElementById('pieLegend').innerHTML = Object.entries(cats).map(([cat,val],i)=>`
    <div class="legend-row"><span><span class="legend-dot" style="background:${colors[i%colors.length]}"></span>${cat}</span><span>${formatAr(val)}</span></div>
  `).join('') || '<div class="empty">Aucune dépense enregistrée.</div>';

  const t = computeTotals();
  const maxV = Math.max(t.income, t.expense, 1);
  document.getElementById('barChart').innerHTML = `
    <div class="bar-row"><span class="bar-label">Niditra</span><div class="bar-track"><div class="bar-fill income" style="width:${t.income/maxV*100}%"></div></div><span class="bar-val">${formatAr(t.income)}</span></div>
    <div class="bar-row"><span class="bar-label">Nivoaka</span><div class="bar-track"><div class="bar-fill expense" style="width:${t.expense/maxV*100}%"></div></div><span class="bar-val">${formatAr(t.expense)}</span></div>
    <p style="margin-top:18px;font-size:13px;color:var(--ink-soft)">Solde net : <strong style="color:var(--ink)">${formatAr(t.balance)}</strong></p>
  `;
}

/* ---------- profile / settings ---------- */
function avatarMarkup(){
  return state.profile.avatar
    ? `<img src="${state.profile.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
    : initials(state.profile.name);
}
function renderProfile(){
  document.getElementById('profileName').textContent = state.profile.name;
  document.getElementById('profileEmail').textContent = state.profile.email;
  document.getElementById('topName').textContent = state.profile.name;
  document.getElementById('profileAvatar').innerHTML = avatarMarkup();
  document.getElementById('topAvatar').innerHTML = avatarMarkup();
  document.getElementById('backupStatus').textContent = state.profile.lastBackup
    ? '✓ ' + state.profile.lastBackup.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})
    : '›';
}

function openProfileModal(){
  document.getElementById('profName').value = state.profile.name;
  document.getElementById('profEmail').value = state.profile.email;
  document.getElementById('avatarPreview').innerHTML = avatarMarkup();
  openModal('profile');
}

function onAvatarChosen(e){
  const file = e.target.files[0];
  if(!file) return;
  if(!navigator.onLine){ showToast('Mila fifandraisana internet ny fanovana sary avatar'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    state.profile.avatar = reader.result;
    document.getElementById('avatarPreview').innerHTML = avatarMarkup();
    const {error} = await sb.from('profiles').update({avatar_url: reader.result}).eq('id', currentUser.id);
    if(error){ showToast('Tsy voatahiry ny sary — andramo indray'); return; }
    renderProfile();
  };
  reader.readAsDataURL(file);
}

function saveProfile(){
  const name = document.getElementById('profName').value.trim();
  const email = document.getElementById('profEmail').value.trim();
  if(!name){ document.getElementById('profName').focus(); return; }
  state.profile.name = name;
  state.profile.email = email;
  queueProfileUpdate({name, email});
  closeModal('profile');
  renderProfile();
  showToast('Profil voavaozina ✓');
}

function savePin(){
  const oldPin = document.getElementById('pinOld').value;
  const newPin = document.getElementById('pinNew').value;
  if(oldPin !== state.profile.pin){ showToast('Diso ny PIN taloha'); return; }
  if(!newPin || newPin.length<4){ showToast('4 isa farafahakeliny ny PIN vaovao'); return; }
  state.profile.pin = newPin;
  queueProfileUpdate({pin: newPin});
  document.getElementById('pinOld').value='';
  document.getElementById('pinNew').value='';
  closeModal('pin');
  showToast('PIN novaina ✓');
}

function backupNow(){
  state.profile.lastBackup = new Date();
  queueProfileUpdate({last_backup: state.profile.lastBackup.toISOString()});
  renderProfile();
  showToast('Sauvegarde tontosa ✓');
}

function downloadBlob(content, filename, mime){
  const blob = new Blob([content], {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportCSV(){
  const rows = [['Date','Type','Catégorie','Note','Montant (Ar)']];
  [...state.transactions].sort((a,b)=>a.date-b.date).forEach(t=>{
    rows.push([t.date.toLocaleDateString('fr-FR'), t.type==='income'?'Niditra':'Nivoaka', t.category, (t.note||'').replace(/,/g,' '), t.amount]);
  });
  const csv = rows.map(r=>r.join(',')).join('\n');
  downloadBlob('\uFEFF'+csv, 'lamina-transactions.csv', 'text/csv;charset=utf-8');
  showToast('Fichier Excel (.csv) voaesotra ✓');
}

function exportPDF(){
  const t = computeTotals();
  const win = window.open('', '_blank');
  const rowsHtml = [...state.transactions].sort((a,b)=>b.date-a.date).map(tx=>`
    <tr><td>${tx.date.toLocaleDateString('fr-FR')}</td><td>${tx.category}</td><td>${tx.note||''}</td>
    <td style="text-align:right;color:${tx.type==='income'?'#12805F':'#C24B33'}">${tx.type==='income'?'+':'−'}${formatAr(tx.amount)}</td></tr>
  `).join('');
  win.document.write(`
    <html><head><title>Lamina — Rapport</title>
    <style>
      body{font-family:Arial,sans-serif;padding:32px;color:#0B2540;}
      h1{margin-bottom:4px;} p.sub{color:#666;margin-top:0;}
      table{width:100%;border-collapse:collapse;margin-top:20px;}
      th,td{padding:8px 10px;border-bottom:1px solid #ddd;font-size:13px;text-align:left;}
      .totals{margin-top:20px;font-size:14px;}
      .totals strong{display:inline-block;width:220px;}
    </style></head><body>
    <h1>Lamina — Rapport financier</h1>
    <p class="sub">${state.profile.name} · généré le ${new Date().toLocaleDateString('fr-FR')}</p>
    <div class="totals">
      <div><strong>Vola Niditra</strong> ${formatAr(t.income)}</div>
      <div><strong>Vola Mivoaka</strong> ${formatAr(t.expense)}</div>
      <div><strong>Solde net</strong> ${formatAr(t.balance)}</div>
    </div>
    <table><thead><tr><th>Date</th><th>Catégorie</th><th>Note</th><th style="text-align:right">Montant</th></tr></thead>
    <tbody>${rowsHtml}</tbody></table>
    </body></html>
  `);
  win.document.close();
  win.focus();
  setTimeout(()=>win.print(), 300);
  showToast('Rapport PDF vonona — safidio "Enregistrer en PDF"');
}

function renderAll(){
  renderDashboard();
  renderTransactions();
  renderDebts();
  renderCalendar();
  renderStats();
  renderProfile();
}

/* ---------- authentication ---------- */
function setAuthMode(mode){
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
  document.getElementById('authNameField').style.display = mode==='signup' ? 'block' : 'none';
  document.getElementById('authSubmitBtn').textContent = mode==='signup' ? 'Créer le compte' : 'Se connecter';
  document.getElementById('authError').style.display = 'none';
}

function showAuthError(msg){
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.style.display = 'block';
}

function mapAuthError(error){
  const msg = (error && error.message) || '';
  if(/already registered|already exists/i.test(msg)) return 'Efa misy compte amin\'ity email ity.';
  if(/invalid login credentials/i.test(msg)) return 'Diso ny email na ny mot de passe.';
  if(/password/i.test(msg) && /6/.test(msg)) return '6 tarehin-tsoratra farafahakeliny ny mot de passe.';
  if(/email/i.test(msg) && /invalid/i.test(msg)) return 'Diso ny endriky ny email.';
  return 'Nisy olana teo am-panaovana — andramo indray. (' + msg + ')';
}

async function submitAuth(){
  const email = document.getElementById('authEmail').value.trim().toLowerCase();
  const password = document.getElementById('authPassword').value;

  if(!email || !password){ showAuthError('Fenoy ny email sy ny mot de passe.'); return; }
  if(!navigator.onLine){ showAuthError('Mila fifandraisana internet ny fidirana/fisoratana anarana voalohany.'); return; }

  const btn = document.getElementById('authSubmitBtn');
  btn.disabled = true;

  if(authMode === 'signup'){
    const name = document.getElementById('authName').value.trim();
    if(!name){ showAuthError('Fenoy ny anaranao.'); btn.disabled=false; return; }
    if(password.length < 6){ showAuthError('6 tarehin-tsoratra farafahakeliny ny mot de passe.'); btn.disabled=false; return; }

    const {data, error} = await sb.auth.signUp({ email, password, options:{ data:{ name } } });
    btn.disabled = false;
    if(error){ showAuthError(mapAuthError(error)); return; }
    if(!data.session){
      showAuthError('Voaforona ny kaonty — raha ilaina, hamarino aloha ny email talohan\'ny hidirana.');
      setAuthMode('login');
      return;
    }
    await loadUserData(data.user);
  } else {
    const {data, error} = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if(error){ showAuthError(mapAuthError(error)); return; }
    await loadUserData(data.user);
  }

  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authName').value = '';
  document.getElementById('authError').style.display = 'none';
  document.getElementById('authGate').style.display = 'none';
  document.getElementById('appShell').style.display = 'block';
  showToast(authMode==='signup' ? 'Compte voaforona ✓' : 'Tafiditra soa aman-tsara ✓');
  hidden = false;
  txFilter = 'all'; debtFilter = 'lent';
  enterAppMode();
  switchTab('dashboard');
  renderAll();
}

function enterAppMode(){
  document.getElementById('heroSection').style.display = 'none';
  document.getElementById('fonctions').style.display = 'none';
  document.getElementById('navLinks').style.display = 'none';
  document.getElementById('navCta').style.display = 'none';
  document.getElementById('demoHead').style.display = 'none';
  document.getElementById('apropos').style.display = 'none';
  document.getElementById('demo').scrollIntoView({behavior:'instant'});
}

function exitAppMode(){
  document.getElementById('heroSection').style.display = '';
  document.getElementById('fonctions').style.display = '';
  document.getElementById('navLinks').style.display = '';
  document.getElementById('navCta').style.display = '';
  document.getElementById('demoHead').style.display = '';
  document.getElementById('apropos').style.display = '';
}

async function logout(){
  if(!confirm('Hivoaka amin\'ny kaontinao ve ianao?')) return;
  await sb.auth.signOut();
  document.getElementById('appShell').style.display = 'none';
  document.getElementById('authGate').style.display = 'flex';
  currentUser = null;
  queueKey = null;
  state = emptyState();
  exitAppMode();
  setAuthMode('login');
  switchTab('dashboard');
}

/* ---------- fanamboarana session efa misy (tsy very ny fidirana rehefa refresh/miova téléphone) ---------- */
(async function initSession(){
  const { data } = await sb.auth.getSession();
  const session = data && data.session;
  if(session && session.user){
    await loadUserData(session.user);
    document.getElementById('authGate').style.display = 'none';
    document.getElementById('appShell').style.display = 'block';
    hidden = false; txFilter = 'all'; debtFilter = 'lent';
    enterAppMode();
    switchTab('dashboard');
    renderAll();
  } else {
    renderAll();
  }
})();

/* ===== SPLASH SCREEN ===== */
(function(){
  var MIN_SPLASH_MS = 1900; // laisse le temps à l'animation d'entrée de se jouer
  var start = Date.now();
  function hideSplash(){
    var el = document.getElementById('splashScreen');
    if(!el) return;
    var elapsed = Date.now() - start;
    var wait = Math.max(0, MIN_SPLASH_MS - elapsed);
    setTimeout(function(){
      el.classList.add('splash-hide');
      setTimeout(function(){ el.remove(); }, 650);
    }, wait);
  }
  if(document.readyState === 'complete'){
    hideSplash();
  } else {
    window.addEventListener('load', hideSplash);
  }
})();
