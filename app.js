/* HIIT PWA — 20-min workout, 2-min warmup, 30/30 intervals, break every 5 cycles, 1-min cooldown.
   Designed not to pause external audio. Sounds/vibration are optional. */

const el = sel => document.querySelector(sel);
const fmt = s => {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s/60).toString().padStart(2,'0');
  const r = (s%60).toString().padStart(2,'0');
  return `${m}:${r}`;
};

let plan = [];           // [{label, seconds, kind}]
let iSeg = 0;            // current segment index
let segStart = 0;        // epoch ms for current segment start
let segEnd = 0;          // epoch ms for current segment end
let running = false;
let raf = 0;
let startedAt = 0;       // session start epoch ms
let totalSeconds = 0;    // total plan duration
let wakeLock = null;
let deferredPrompt;
// ADD near other globals
let highTotal = 0;   // total number of 'high' segments in the plan
let highDone = 0;    // number completed so far
// install button
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  el('#installBtn').hidden = false;
});
el('#installBtn')?.addEventListener('click', async () => {
  el('#installBtn').hidden = true;
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  }
});

// options
function readOptions() {
  return {
    warm: +el('#optWarm').value || 0,
    workMin: +el('#optWorkMin').value || 20,
    high: +el('#optHigh').value || 30,
    low: +el('#optLow').value || 30,
    perBlock: +el('#optPerBlock').value || 5,
    blockBreak: +el('#optBreak').value || 120,
    cool: +el('#optCool').value || 60,
    soundOn: el('#soundOn').checked,
    vibrateOn: el('#vibrateOn').checked,
    ttsOn: el('#ttsOn').checked,
    keepAwake: el('#keepAwake').checked,
  };
}

function buildPlan(opts) {
  const p = [];
  const push = (label, seconds, kind) => { if (seconds>0) p.push({label, seconds, kind}); };

  // warmup
  push('Warmup', opts.warm, 'warm');

  // workout block target
  let remaining = opts.workMin * 60;

  // Repeating pattern: 5×(high+low) then 2-min break
  const oneCycle = opts.high + opts.low;     // 60s
  const fiveCycles = oneCycle * opts.perBlock; // default 300s (5 min)
  const blockTotal = fiveCycles + opts.blockBreak; // default 300 + 120 = 420s (7 min)

  while (remaining > 0) {
    if (remaining >= blockTotal) {
      for (let k=0;k<opts.perBlock;k++){
        push('High', opts.high, 'high');
        push('Low', opts.low, 'low');
      }
      push('Block Break (very low)', opts.blockBreak, 'break');
      remaining -= blockTotal;
    } else {
      // partial block to fill remaining
      // add as many 30/30 as fit, then use part of break if still time
      for (let k=0;k<opts.perBlock && remaining >= oneCycle; k++){
        push('High', opts.high, 'high');
        push('Low', opts.low, 'low');
        remaining -= oneCycle;
      }
      if (remaining > 0) {
        const b = Math.min(opts.blockBreak, remaining);
        push('Block Break (very low)', b, 'break');
        remaining -= b;
      }
    }
  }

  // cooldown
  push('Cooldown', opts.cool, 'cool');

  return p;
}

function renderPlanList(p){
  const list = el('#plan');
  list.innerHTML = '';
  p.forEach((s, idx) => {
    const li = document.createElement('li');
    li.textContent = `${idx+1}. ${s.label} — ${fmt(s.seconds)}`;
    list.appendChild(li);
  });
}

function sumSeconds(p){ return p.reduce((a,b)=>a+b.seconds,0); }

// MODIFY updateDisplays() to reflect the counter
function updateDisplays(nowMs){
  const now = nowMs ?? performance.now();
  const secLeft = Math.ceil((segEnd - now)/1000);
  el('#bigTime').textContent = fmt(secLeft);
  el('#phase').textContent = plan[iSeg]?.label ?? 'Done';
  el('#nextPhase').textContent = plan[iSeg+1]?.label ?? '—';

  const elapsed = running ? Math.floor((now - startedAt)/1000) : sumSeconds(plan.slice(0, iSeg));
  el('#elapsed').textContent = fmt(elapsed);
  el('#total').textContent = fmt(totalSeconds);

  const progress = Math.min(1, Math.max(0, elapsed / totalSeconds));
  el('#progress').style.width = (progress*100).toFixed(2)+'%';

  // NEW: high-interval counter display
  const hc = el('#highCount'), ht = el('#highTotal');
  if (hc && ht) { hc.textContent = String(highDone); ht.textContent = String(highTotal); }
}

function say(text) {
  if (!readOptions().ttsOn) return;
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function beep(pattern='tick'){
  if (!readOptions().soundOn) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.connect(g); g.connect(ctx.destination);
  o.type = 'sine';
  let freq = 880, dur = 0.12;
  if (pattern==='go'){ freq=1200; dur=0.18 }
  if (pattern==='rest'){ freq=660; dur=0.12 }
  if (pattern==='block'){ freq=420; dur=0.35 }
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  o.start(); o.stop(ctx.currentTime + dur + 0.02);
  setTimeout(()=>ctx.close(), 300);
}

function buzz(ms=200){
  if (!readOptions().vibrateOn) return;
  if (navigator.vibrate) navigator.vibrate(ms);
}

function cueFor(kind, entering=true){
  if (!entering) return;
  if (kind==='high'){ beep('go'); buzz(200); say('High'); }
  else if (kind==='low'){ beep('rest'); say('Low'); }
  else if (kind==='break'){ beep('block'); say('Block break'); }
  else if (kind==='warm'){ say('Warmup'); }
  else if (kind==='cool'){ say('Cooldown'); }
}

function startSegment(idx){
  iSeg = idx;
  const now = performance.now();
  segStart = now;
  segEnd = now + (plan[iSeg]?.seconds ?? 0)*1000;
  cueFor(plan[iSeg]?.kind, true);
  updateDisplays(now);
}

// MODIFY tick() to increment when a 'high' segment FINISHES naturally
function tick(){
  if (!running) return;
  const now = performance.now();

  if (now >= segEnd) {
    const justFinished = plan[iSeg]?.kind;

    // NEW: only count completed if we actually finished the segment
    if (justFinished === 'high') {
      highDone = Math.min(highDone + 1, highTotal);
    }

    if (plan[iSeg+1]) {
      startSegment(iSeg+1);
    } else {
      running = false;
      releaseWakeLock();
      el('#startPause').textContent = 'Start';
      updateDisplays(now);
      beep('block'); buzz([80,60,80]);
      say('Workout complete');
      return;
    }
  } else {
    updateDisplays(now);
  }
  raf = requestAnimationFrame(tick);
}

async function requestWakeLock() {
  try {
    if (readOptions().keepAwake && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch(_) {}
}
function releaseWakeLock(){ try{ wakeLock?.release(); }catch(_){ } finally { wakeLock=null; } }

function resetSession() {
  running = false;
  cancelAnimationFrame(raf);
  releaseWakeLock();
  iSeg = 0; segStart = 0; segEnd = 0; startedAt = 0;
  updateDisplays();
}

// MODIFY initPlan() to compute totals and reset count
function initPlan() {
  const opts = readOptions();
  plan = buildPlan(opts);
  totalSeconds = sumSeconds(plan);

  // NEW: count total 'high' segments and reset completed
  highTotal = plan.filter(s => s.kind === 'high').length;
  highDone = 0;

  renderPlanList(plan);
  el('#nextPhase').textContent = plan[0]?.label ?? '—';
  el('#total').textContent = fmt(totalSeconds);
  el('#elapsed').textContent = '00:00';
  el('#bigTime').textContent = fmt(plan[0]?.seconds ?? 0);
  el('#phase').textContent = 'Ready';
  el('#progress').style.width = '0%';
}

el('#apply').addEventListener('click', () => { resetSession(); initPlan(); });
el('#reset').addEventListener('click', () => { resetSession(); initPlan(); });

el('#skip').addEventListener('click', () => {
  if (!plan[iSeg+1]) return;
  startSegment(iSeg+1);
});

el('#startPause').addEventListener('click', async () => {
  if (!running) {
    if (iSeg===0 && !segEnd) {
      startSegment(0);
      startedAt = performance.now();
    }
    running = true;
    await requestWakeLock();
    el('#startPause').textContent = 'Pause';
    raf = requestAnimationFrame(tick);
  } else {
    running = false;
    releaseWakeLock();
    el('#startPause').textContent = 'Resume';
    cancelAnimationFrame(raf);
  }
});

// Build the default plan on load
initPlan();

// Optional: ask for notification permission (not required to run)
document.addEventListener('visibilitychange', () => {
  // if app goes background during a segment, keep running; browser may throttle timers
});

// Prevent accidental zoom with volume keys media playing? Browsers handle media; we do nothing here.