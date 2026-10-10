/* Oncology Charge Nurse Dashboard — prototype v1
 * Operational notes and highlights are SESSION ONLY (not saved).
 * Review CONFIG.navigation with your existing working mPage before pilot.
 */
(function () {
  'use strict';
  const CONFIG = {
    cclProgram: 'mrd_onc_charge_nurse_mpage:group1',
    autoRefreshMs: 180000,
    // Adjust to the date format your CCL prompt accepts. Common Cerner format: MM/DD/YYYY.
    cclDateFormat: 'MM/DD/YYYY',
    // Keep false for deployment. Demo is automatically used outside PowerChart.
    forceDemo: false,
    navigation: {
      // Chart launch: validate with the working Pending Cycles / APS mPage.
      chartApplication: 'PowerChart.exe',
      chartArguments: function (a) { return '/PERSONID=' + a.personId + ' /ENCNTRID=' + a.encntrId; },
      // REQUIRED CONFIGURATION: replace this with your proven custom Patient Schedule tab navigation.
      // Function should return true only if it actually launched the schedule.
      openPatientSchedule: null
    }
  };
  const $ = id => document.getElementById(id);
  const state = { appointments: [], attending: 'all', search: '', date: '', collapsed: new Set(), edits: new Map(), demo: false, loading: false };
  const excludedTypes = new Set([
    'Chemo Clinic Lab Visit', 'Chemo Clinic Pharm Counselling',
    'Chemo Clinic Pharm Counselling Virtual', 'Chemo Clinic Nurse Assess Visit',
    'Chemo Clinic Nurse Assess Visit Virtual', 'Chemo Clinic MD Visit F/U',
    'Chemo Clinic MD Visit NP Satellite', 'Chemo Clinic MD Visit F/U Satellite'
  ]);
  const demoAppointments = [
    {schedEventId:901001,personId:101,encntrId:201,schApptId:301,ptName:'SAMPLE, PATIENT A',mrn:'DEMO001',apptDttm:'2026-OCT-09 08:30',apptType:'Chemo Clinic Infusion Visit',apptStatus:'Confirmed',attending:'Glenns, Vivian',attendingPersonId:501,pplanName:'ONCP BR KADC Q21D Cycle 1',regimenName:'ONCP BR KADC Q21D',dot:'Day 1',resource:'Chair 1'},
    {schedEventId:901002,personId:102,encntrId:202,schApptId:302,ptName:'SAMPLE, PATIENT B',mrn:'DEMO002',apptDttm:'2026-OCT-09 09:15',apptType:'Chemo Clinic Infusion Visit',apptStatus:'Confirmed',attending:'Glenns, Vivian',attendingPersonId:501,pplanName:'',regimenName:'',dot:'',resource:'Chair 2'},
    {schedEventId:901003,personId:103,encntrId:203,schApptId:303,ptName:'SAMPLE, PATIENT C',mrn:'DEMO003',apptDttm:'2026-OCT-09 10:30',apptType:'Chemo Clinic Injection Visit',apptStatus:'Confirmed',attending:'Glenns, Vivian',attendingPersonId:501,pplanName:'ONCP BR GOSE Q28D',regimenName:'',dot:'Day 1',resource:'Chair 3'},
    {schedEventId:901004,personId:104,encntrId:204,schApptId:304,ptName:'SAMPLE, PATIENT D',mrn:'DEMO004',apptDttm:'2026-OCT-09 11:45',apptType:'Chemo Clinic Oral Treatment Visit',apptStatus:'Confirmed',attending:'Other, Physician',attendingPersonId:502,pplanName:'Oral treatment plan',regimenName:'',dot:'Day 1',resource:''}
  ];
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function todayLocal() { const d = new Date(); return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'); }
  function formatPromptDate(iso) {
    const months = [
        'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
        'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'
    ];

    const parts = iso.split('-');

    return parts[2] + '-' +
           months[Number(parts[1]) - 1] + '-' +
           parts[0];
}
  function displayDate(iso) { const [y,m,d]=iso.split('-').map(Number); return new Date(y,m-1,d).toLocaleDateString('en-CA',{weekday:'long',year:'numeric',month:'long',day:'numeric'}); }
  function dateFromAppointment(a) { const m=String(a.apptDttm||'').match(/^(\d{4})-([A-Za-z]{3})-(\d{2})/); if(!m) return ''; const months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']; return m[1]+'-'+String(months.indexOf(m[2].toUpperCase())+1).padStart(2,'0')+'-'+m[3]; }
  function timeOf(a) { const m=String(a.apptDttm||'').match(/\b(\d{2}:\d{2})\b/); return m?m[1]:'—'; }
  function notice(message, error) { const n=$('notice'); n.textContent=message; n.className='notice'+(message?' visible':'')+(error?' error':''); }
  function normalized(raw) {
    const x={}; Object.keys(raw||{}).forEach(k=>{x[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()).replace(/^([A-Z])/,c=>c.toLowerCase())]=raw[k];});
    return {
      ...x, schedEventId:Number(x.schedEventId||0),personId:Number(x.personId||0),encntrId:Number(x.encntrId||0),
      attendingPersonId:Number(x.attendingPersonId||0),ptName:String(x.ptName||''),mrn:String(x.mrn||''),
      attending:String(x.attending||'Unassigned attending'),apptType:String(x.apptType||'Other'),
      apptDttm:String(x.apptDttm||''),pplanName:String(x.pplanName||''),regimenName:String(x.regimenName||''),
      dot:String(x.dot||''),resource:String(x.resource||'')
    };
  }
  function parseReply(text) {
    let data=JSON.parse(text);
    if(typeof data==='string') data=JSON.parse(data);
    const root=data.REPLY||data.reply||data;
    let list=root.LIST||root.list||[];
    if(list && !Array.isArray(list)) list=list.APPOINTMENT||list.appointment||list.ITEM||list.item||[list];
    if(!Array.isArray(list)) throw new Error('Unexpected CCL reply: LIST is not an array');
    return list.map(normalized).filter(a=>a.schedEventId && !excludedTypes.has(a.apptType));
  }
  function getCclRequest() {
    try { if(typeof window.XMLCclRequest==='function') return new window.XMLCclRequest(); } catch(e){}
    try { if(window.external && typeof window.external.DiscernObjectFactory==='function') return window.external.DiscernObjectFactory('XMLCCLREQUEST'); } catch(e){}
    return null;
  }
  function fetchCcl(date) {
    return new Promise((resolve,reject)=>{
      const request=getCclRequest();
      if(!request) return reject(new Error('XMLCCLREQUEST is unavailable outside PowerChart'));
  const d = formatPromptDate(date);

  const args =
    '^MINE^,^' +
    d +
    '^,^' +
    d + ' 23:59:59' +
    '^';
      try {
        request.onreadystatechange=function(){
          if(request.readyState!==4) return;
          const status=Number(request.status||0);
          if(status && status!==200) return reject(new Error('CCL request returned status '+status));
          try { resolve(parseReply(request.responseText||'')); }
          catch(e) { reject(new Error('Unable to parse CCL JSON: '+e.message)); }
        };
        request.open('GET',CONFIG.cclProgram,true);
        request.send(args);
      } catch(e) { reject(e); }
    });
  }
  function editsFor(a) { const k=String(a.schedEventId); if(!state.edits.has(k)) state.edits.set(k,{note:'',highlight:''}); return state.edits.get(k); }
  function visible() { const q=state.search.toLowerCase(); return state.appointments.filter(a=>(state.attending==='all'||String(a.attendingPersonId||a.attending)===state.attending) && (!q||a.ptName.toLowerCase().includes(q)||a.mrn.toLowerCase().includes(q))); }
  function allAttendingOptions() { const map=new Map(); state.appointments.forEach(a=>{ const key=String(a.attendingPersonId||a.attending); if(!map.has(key)) map.set(key,a.attending); }); return [...map].sort((a,b)=>a[1].localeCompare(b[1])); }
  function setOptions() {
    const options=allAttendingOptions();
    const selected=state.attending;
    $('attendingFilter').innerHTML='<option value="all">All Attendings</option>'+options.map(([k,n])=>'<option value="'+esc(k)+'">'+esc(n)+'</option>').join('');
    state.attending=options.some(([k])=>k===selected)?selected:'all'; $('attendingFilter').value=state.attending;
    $('printAttending').innerHTML='<option value="current">Use dashboard selection</option><option value="all">All Attendings</option>'+options.map(([k,n])=>'<option value="'+esc(k)+'">'+esc(n)+'</option>').join('');
  }
  function grouped(list) {
    const groups=new Map();
    list.forEach(a=>{const physician=a.attending||'Unassigned attending';if(!groups.has(physician))groups.set(physician,new Map());const types=groups.get(physician);if(!types.has(a.apptType))types.set(a.apptType,[]);types.get(a.apptType).push(a);});
    return [...groups].sort((a,b)=>a[0].localeCompare(b[0])).map(([name,types])=>({name,types:[...types].sort((a,b)=>a[0].localeCompare(b[0])).map(([type,items])=>({type,items:items.sort((a,b)=>a.apptDttm.localeCompare(b.apptDttm))}))}));
  }
  function render() {
    const list=visible(), groups=grouped(list);
    $('appointmentCount').textContent=list.length;
    $('attendingCount').textContent=groups.length;
    $('notesCount').textContent=list.filter(a=>editsFor(a).note.trim()).length;
    $('completedCount').textContent=list.filter(a=>/checked[ -]?in/i.test(a.apptStatus||'')).length;
    $('filterSummary').textContent=displayDate(state.date)+' · '+(state.attending==='all'?'All Attendings':($('attendingFilter').selectedOptions[0]?.textContent||''))+' · '+list.length+' appointments';
    if(!list.length){$('appointmentGroups').innerHTML='<div class="empty">No appointments match the selected date and filters.</div>';return;}
    const showNotes=$('showNotes').checked;
    $('appointmentGroups').innerHTML=groups.map(g=>{
      const closed=state.collapsed.has(g.name), count=g.types.reduce((s,t)=>s+t.items.length,0);
      return '<article class="physician-group"><button type="button" class="physician-heading" data-toggle="'+esc(g.name)+'" aria-expanded="'+(!closed)+'"><span>'+(closed?'▸':'▾')+' '+esc(g.name)+'</span><span class="count">'+count+' appointments</span></button>'+(closed?'':'<div>'+g.types.map(t=>'<section class="type-group"><div class="type-heading">'+esc(t.type)+' ('+t.items.length+')</div><div class="table-scroll"><table class="appointment-table"><thead><tr><th>Appointment</th><th>Patient</th><th>MRN</th><th>Regimen / Plan</th><th>DoT</th><th>Nurse comments / Highlight</th><th>Appointment status</th></tr></thead><tbody>'+t.items.map(a=>{
        const edit=editsFor(a),id=esc(a.schedEventId),plan=a.pplanName||a.regimenName||'—';
        return '<tr class="'+(edit.highlight?'highlight-'+edit.highlight:'')+'"><td><button type="button" class="link-button" data-schedule="'+id+'">'+esc(timeOf(a))+'</button><div class="patient-sub">'+esc(a.apptStatus||'')+'</div></td><td><button type="button" class="link-button" data-chart="'+id+'">'+esc(a.ptName)+'</button></td><td>'+esc(a.mrn)+'</td><td class="regimen-cell">'+esc(plan)+(a.resource?'<div class="patient-sub">'+esc(a.resource)+'</div>':'')+'</td><td>'+esc(a.dot||'—')+'</td><td>'+(showNotes?'<textarea class="note-input" data-note="'+id+'" rows="1" placeholder="Add temporary note...">'+esc(edit.note)+'</textarea>':'')+'<div class="highlight-controls" aria-label="Highlight appointment"><button type="button" class="highlight-button yellow '+(edit.highlight==='yellow'?'active':'')+'" data-highlight="'+id+'" data-color="yellow" title="Yellow highlight" aria-label="Yellow highlight"></button><button type="button" class="highlight-button green '+(edit.highlight==='green'?'active':'')+'" data-highlight="'+id+'" data-color="green" title="Green highlight" aria-label="Green highlight"></button><button type="button" class="highlight-button pink '+(edit.highlight==='pink'?'active':'')+'" data-highlight="'+id+'" data-color="pink" title="Pink highlight" aria-label="Pink highlight"></button><button type="button" class="highlight-button clear" data-highlight="'+id+'" data-color="" title="Remove highlight" aria-label="Remove highlight">×</button></div></td><td>'+esc(a.apptStatus||'—')+'</td></tr>';
      }).join('')+'</tbody></table></div></section>').join('')+'</div>')+'</article>';
    }).join('');
  }
  function findAppointment(id) { return state.appointments.find(a=>String(a.schedEventId)===String(id)); }
  function applink(app,args) {
    if(typeof window.APPLINK==='function') { window.APPLINK(0,app,args); return true; }
    return false;
  }
  function openChart(a) {
    if(!a||!a.personId||!a.encntrId) return notice('Patient/encounter identifier is missing; cannot open chart.',true);
    try { if(!applink(CONFIG.navigation.chartApplication,CONFIG.navigation.chartArguments(a))) notice('Chart navigation requires PowerChart APPLINK. Confirm your working mPage launch syntax.',true); }
    catch(e) { notice('Chart launch failed: '+e.message,true); }
  }
  function openSchedule(a) {
    if(!a) return;
    try {
      if(typeof CONFIG.navigation.openPatientSchedule==='function' && CONFIG.navigation.openPatientSchedule(a)===true) return;
      notice('Patient Schedule navigation is not configured yet. Copy the proven launch code from your existing ONC Patient Schedule mPage into CONFIG.navigation.openPatientSchedule.',true);
    } catch(e) { notice('Patient Schedule launch failed: '+e.message,true); }
  }
  function selectedPrintList() {
    const value=$('printAttending').value;
    const key=value==='current'?state.attending:value;
    const q=state.search.toLowerCase();
    return state.appointments.filter(a=>(key==='all'||String(a.attendingPersonId||a.attending)===key)&&(!q||a.ptName.toLowerCase().includes(q)||a.mrn.toLowerCase().includes(q)));
  }
  function printOptions() { return {layout:document.querySelector('input[name="printLayout"]:checked').value,notes:$('printNotes').checked,highlights:$('printHighlights').checked,statuses:$('printStatuses').checked}; }
  function buildPrint() {
    const opts=printOptions(), list=selectedPrintList(), groups=grouped(list), compact=opts.layout==='simple', worksheet=opts.layout==='worksheet';
    const printAttending=$('printAttending').value;
    const physicianLabel=printAttending==='all'?'All Attendings':printAttending==='current'?(state.attending==='all'?'All Attendings':$('attendingFilter').selectedOptions[0]?.textContent):$('printAttending').selectedOptions[0]?.textContent;
    const columns=['Time','Patient','MRN','Regimen / Plan','DoT'];
    if(opts.layout==='detailed')columns.push('Appointment type','Resource','Appt status');
    if(opts.statuses && opts.layout!=='detailed')columns.push('Appt status');
    if(opts.notes)columns.push('Nurse comments');
    if(worksheet)columns.push('Handwritten notes');
    const widths=opts.layout==='detailed'?[7,15,10,26,7,17,10,8]:[10,21,13,42,14];
    const extra=columns.length-widths.length; for(let i=0;i<extra;i++) widths.push(14);
    const total=widths.reduce((a,b)=>a+b,0);
    const table=(items)=>'<table class="print-table"><colgroup>'+widths.map(w=>'<col style="width:'+(w/total*100).toFixed(3)+'%">').join('')+'</colgroup><thead><tr>'+columns.map(c=>'<th>'+esc(c)+'</th>').join('')+'</tr></thead><tbody>'+items.map(a=>{
      const e=editsFor(a),cells=[timeOf(a),a.ptName,a.mrn,a.pplanName||a.regimenName||'',a.dot||''];
      if(opts.layout==='detailed')cells.push(a.apptType,a.resource||'',a.apptStatus||'');
      if(opts.statuses && opts.layout!=='detailed')cells.push(a.apptStatus||'');
      if(opts.notes)cells.push(e.note);
      if(worksheet)cells.push('');
      return '<tr class="'+(opts.highlights&&e.highlight?'highlight-'+e.highlight:'')+(worksheet?' worksheet-row':'')+'">'+cells.map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>';
    }).join('')+'</tbody></table>';
    let body='';
    if(opts.layout==='attending'||opts.layout==='detailed'||opts.layout==='worksheet') {
      body=groups.map(g=>'<section class="print-group"><h2>'+esc(g.name)+'</h2>'+g.types.map(t=>'<h3>'+esc(t.type)+' ('+t.items.length+')</h3>'+table(t.items)).join('')+'</section>').join('');
    } else {
      body=groups.map(g=>'<section class="print-group"><h2>'+esc(g.name)+'</h2>'+g.types.map(t=>'<h3>'+esc(t.type)+'</h3>'+table(t.items)).join('')+'</section>').join('');
    }
    $('printArea').innerHTML='<div class="print-sheet"><h1>Oncology Clinic — '+esc(({simple:'Simple Daily Appointment List',detailed:'Detailed Appointment List',attending:'Appointments by Attending',worksheet:'Nurse Worksheet'})[opts.layout])+'</h1><div class="print-meta"><span>'+esc(displayDate(state.date))+' · '+esc(physicianLabel||'All Attendings')+'</span><span>'+list.length+' appointments · Printed '+esc(new Date().toLocaleString('en-CA'))+'</span></div>'+(list.length?body:'<p>No appointments match the selected filters.</p>')+'<div class="print-footer">Oncology Clinic · Operational appointment list · Handle as confidential patient information</div></div>';
  }
  async function load() {
    if(state.loading)return;
    state.loading=true; $('refreshButton').disabled=true;notice('Loading appointments...');
    try {
    state.demo = false;
      if(state.demo) {
        state.appointments=demoAppointments.map(a=>normalized({...a,apptDttm:a.apptDttm.replace('2026-OCT-09',state.date.slice(0,4)+'-'+['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][Number(state.date.slice(5,7))-1]+'-'+state.date.slice(8,10))}));
        notice('DEMO MODE: Sample patients only. Notes and highlights are temporary and are not saved.');
      } else {
        state.appointments=await fetchCcl(state.date);
        notice('Prototype: nurse notes and highlights are temporary and are not saved to Cerner. They remain during automatic refresh but disappear when the page closes.');
      }
      $('modeBadge').textContent=state.demo?'Demo data':'PowerChart CCL';$('modeBadge').className='badge '+(state.demo?'demo':'live');
      $('lastUpdated').textContent='Refreshed '+new Date().toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit'});
      setOptions();render();
    } catch(e) {
      // Preserve the last successfully loaded list and any in-session notes on refresh failure.
      $('modeBadge').textContent='Refresh failed';$('modeBadge').className='badge';notice(e.message+' — Previous appointment data remains visible; it may be outdated.',true);
    } finally {state.loading=false;$('refreshButton').disabled=false;}
  }
  function bind() {
    $('appointmentDate').addEventListener('change',e=>{if(!e.target.value)return;state.date=e.target.value;state.collapsed.clear();load();});
    $('attendingFilter').addEventListener('change',e=>{state.attending=e.target.value;render();});
    $('searchBox').addEventListener('input',e=>{state.search=e.target.value.trim();render();});
    $('showNotes').addEventListener('change',render);
    $('refreshButton').addEventListener('click',load);
    $('expandAll').addEventListener('click',()=>{state.collapsed.clear();render();});
    $('collapseAll').addEventListener('click',()=>{grouped(visible()).forEach(g=>state.collapsed.add(g.name));render();});
    $('appointmentGroups').addEventListener('click',e=>{
      const toggle=e.target.closest('[data-toggle]');if(toggle){const k=toggle.dataset.toggle;state.collapsed.has(k)?state.collapsed.delete(k):state.collapsed.add(k);render();return;}
      const chart=e.target.closest('[data-chart]');if(chart){openChart(findAppointment(chart.dataset.chart));return;}
      const schedule=e.target.closest('[data-schedule]');if(schedule){openSchedule(findAppointment(schedule.dataset.schedule));return;}
      const highlight=e.target.closest('[data-highlight]');if(highlight){const a=findAppointment(highlight.dataset.highlight);if(a){editsFor(a).highlight=highlight.dataset.color;render();}}
    });
    $('appointmentGroups').addEventListener('input',e=>{if(e.target.matches('[data-note]')){const a=findAppointment(e.target.dataset.note);if(a){editsFor(a).note=e.target.value;$('notesCount').textContent=visible().filter(x=>editsFor(x).note.trim()).length;}}});
    const dialog=$('printDialog');
    $('printOptionsButton').addEventListener('click',()=>dialog.showModal());
    $('closePrint').addEventListener('click',()=>dialog.close());$('cancelPrint').addEventListener('click',()=>dialog.close());
    $('previewPrint').addEventListener('click',()=>{buildPrint();document.body.classList.add('print-preview-visible');dialog.close();$('printArea').scrollIntoView({behavior:'smooth'});});
    $('doPrint').addEventListener('click',()=>{buildPrint();dialog.close();window.print();});
    $('printForm').addEventListener('submit',e=>e.preventDefault());
  }
  state.date=todayLocal();$('appointmentDate').value=state.date;bind();load();
  // Skip refresh while the nurse is typing, a print dialog is open, or the page is hidden.
  setInterval(()=>{
    const active=document.activeElement;
    const editing=active && (active.matches('textarea, input[type="text"]') || active.isContentEditable);
    if(state.loading || editing || document.hidden || $('printDialog').open) return;
    load();
  },CONFIG.autoRefreshMs);
})();
