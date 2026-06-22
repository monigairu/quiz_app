// =============================================================================
// 会場表示（プロジェクタ）：問題・回答状況・最終順位を大画面に
// =============================================================================
import { fs, refs, ensureAuth, guardConfig, PHASE, $, esc } from "/common.js";

let ev = null, questions = [], tables = [], keys = new Map(), answers = [];

if (guardConfig()) init();

async function init() {
  await ensureAuth();
  fs.onSnapshot(refs.event, (s) => { ev = s.exists() ? s.data() : null; render(); });
  fs.onSnapshot(refs.questions, (s) => {
    questions = s.docs.map((d) => d.data()).sort((a, b) => a.order - b.order); render();
  });
  fs.onSnapshot(refs.keys, (s) => {
    keys = new Map(s.docs.map((d) => [d.data().order, d.data().answerIndex])); render();
  });
  fs.onSnapshot(refs.tables, (s) => { tables = s.docs.map((d) => d.data()); render(); });
  fs.onSnapshot(refs.answers, (s) => { answers = s.docs.map((d) => d.data()); render(); });
}

function render() {
  const c = $("content");
  if (!ev) { c.innerHTML = '<h1>クイズ大会</h1><p class="muted">準備中…</p>'; return; }
  $("title") && ($("title").textContent = ev.title);
  $("progress").textContent = ev.currentIndex >= 0
    ? `第${ev.currentIndex + 1}問 / ${ev.questionCount}`
    : `参加 ${tables.filter((t) => t.claimedByUid).length}/${tables.length} テーブル`;

  if (ev.phase === PHASE.SETUP || ev.phase === PHASE.LOBBY) {
    c.innerHTML = `<h1>${esc(ev.title)}</h1><p class="big">📣</p>
      <p>${tables.filter((t) => t.claimedByUid).length} / ${tables.length} テーブルが参加中</p>`;
    return;
  }
  if (ev.phase === PHASE.QUESTION || ev.phase === PHASE.REVEAL) {
    const q = questions[ev.currentIndex];
    if (!q) { c.innerHTML = "―"; return; }
    const forThis = answers.filter((a) => a.qIndex === ev.currentIndex);
    const answerIndex = keys.get(ev.currentIndex);
    let html = `<p class="q-text">${esc(q.text)}</p><div class="choices">`;
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
  }
}
