// =============================================================================
// 会場表示（プロジェクタ）：問題・回答状況・最終順位を大画面に
// =============================================================================
import { fs, refs, ensureAuth, guardConfig, PHASE, $, esc, showReconnectBanner } from "/common.js";
import { launchConfetti } from "/confetti.js";

let ev = null, questions = [], tables = [], answers = [];
let celebratedFinish = false;
const joinUrl = location.origin + "/";

if (guardConfig()) init();

async function init() {
  await ensureAuth();
  fs.onSnapshot(refs.event, (s) => { ev = s.exists() ? s.data() : null; render(); }, showReconnectBanner);
  fs.onSnapshot(refs.questions, (s) => {
    questions = s.docs.map((d) => d.data()).sort((a, b) => a.order - b.order); render();
  });
  fs.onSnapshot(refs.tables, (s) => { tables = s.docs.map((d) => d.data()); render(); });
  fs.onSnapshot(refs.answers, (s) => { answers = s.docs.map((d) => d.data()); render(); });
  setInterval(tickTimer, 250);
}

// QRコード描画（qrcode-generator が読み込まれていれば使用）
function qrHtml(url) {
  try {
    if (typeof window.qrcode === "function") {
      const qr = window.qrcode(0, "M");
      qr.addData(url);
      qr.make();
      return `<div class="qrbox">${qr.createImgTag(6, 0)}</div>`;
    }
  } catch (_) { /* フォールバックへ */ }
  return "";
}

function tickTimer() {
  const wrap = document.getElementById("timerWrap");
  if (!wrap || !ev || ev.phase !== PHASE.QUESTION || !ev.timeLimit || !ev.questionStartedAt) return;
  const start = ev.questionStartedAt.toMillis ? ev.questionStartedAt.toMillis() : 0;
  if (!start) return;
  const total = ev.timeLimit * 1000;
  const remain = Math.max(0, total - (Date.now() - start));
  document.getElementById("tnum").textContent = Math.ceil(remain / 1000);
  document.getElementById("tbarFill").style.width = (remain / total * 100) + "%";
  wrap.classList.toggle("urgent", remain <= 5000);
}

function render() {
  const c = $("content");
  if (!ev) { c.innerHTML = '<h1>クイズ大会</h1><p class="muted">準備中…</p>'; return; }
  $("title") && ($("title").textContent = ev.title);
  $("progress").textContent = ev.currentIndex >= 0
    ? `第${ev.currentIndex + 1}問 / ${ev.questionCount}`
    : `参加 ${tables.filter((t) => t.claimedByUid).length}/${tables.length} テーブル`;

  if (ev.phase === PHASE.SETUP || ev.phase === PHASE.LOBBY) {
    c.innerHTML = `<h1>${esc(ev.title)}</h1>
      <p>スマホで下のQRコードを読み取って参加してください</p>
      ${qrHtml(joinUrl)}
      <p class="joinurl">${esc(joinUrl)}</p>
      <p class="big" style="margin:6px 0">📣</p>
      <p>${tables.filter((t) => t.claimedByUid).length} / ${tables.length} テーブルが参加中</p>`;
    return;
  }
  if (ev.phase === PHASE.QUESTION || ev.phase === PHASE.REVEAL) {
    const q = questions[ev.currentIndex];
    if (!q) { c.innerHTML = "―"; return; }
    const forThis = answers.filter((a) => a.qIndex === ev.currentIndex);
    const answerIndex = ev.phase === PHASE.REVEAL ? ev.revealIndex : null;
    let html = "";
    if (ev.phase === PHASE.QUESTION && ev.timeLimit) {
      html += `<div class="timer" id="timerWrap">
        <div class="tnum"><span id="tnum">${ev.timeLimit}</span> 秒</div>
        <div class="tbar"><span id="tbarFill" style="width:100%"></span></div></div>`;
    }
    html += `<p class="q-text">${esc(q.text)}</p><div class="choices quiz4">`;
    q.choices.forEach((ch, i) => {
      const correct = ev.phase === PHASE.REVEAL && i === answerIndex;
      const n = forThis.filter((a) => a.choice === i).length;
      html += `<div class="choice ${correct ? "correct" : ""}">${esc(ch)}${
        ev.phase === PHASE.REVEAL ? ` <span class="badge">${n}</span>` : ""}</div>`;
    });
    html += `</div>`;
    if (ev.phase === PHASE.QUESTION) html += `<p class="muted">回答 ${forThis.length}/${tables.length} テーブル</p>`;
    c.innerHTML = html;
    return;
  }
  if (ev.phase === PHASE.FINISHED) {
    const s = ev.standings || [];
    let html = `<p class="big">🏆 最終結果</p><ol class="standings">`;
    s.forEach((g, i) => {
      const medal = ["🥇", "🥈", "🥉"][i] || (i + 1);
      const top = i < 3 ? `top${i + 1}` : "";
      html += `<li class="${top}"><span class="rank">${medal}</span>
        <b>${esc(g.name)}</b><span class="score">${g.score}点</span></li>`;
    });
    html += `</ol>`;
    c.innerHTML = html;
    if (!celebratedFinish) { celebratedFinish = true; launchConfetti(160); }
  }
}
