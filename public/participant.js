// =============================================================================
// 参加者（代表者）画面：テーブル選択・回答・正誤確認・結果
// =============================================================================
import {
  fs, db, refs, ensureAuth, guardConfig, PHASE, $, esc,
} from "/common.js";

let myUid = null;
let myTableId = null;
let ev = null;
let tables = [];
let questions = [];
let myAnswers = new Map(); // qIndex -> answer doc
let unsubAnswers = null;

if (guardConfig()) init();

async function init() {
  myUid = (await ensureAuth()).uid;
  fs.onSnapshot(refs.event, (s) => { ev = s.exists() ? s.data() : null; render(); });
  fs.onSnapshot(refs.questions, (s) => {
    questions = s.docs.map((d) => d.data()).sort((a, b) => a.order - b.order);
    render();
  });
  fs.onSnapshot(refs.tables, (s) => {
    tables = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.id.localeCompare(b.id));
    const mine = tables.find((t) => t.claimedByUid === myUid);
    const newId = mine ? mine.id : null;
    if (newId !== myTableId) { myTableId = newId; watchMyAnswers(); }
    render();
  });
}

function watchMyAnswers() {
  if (unsubAnswers) { unsubAnswers(); unsubAnswers = null; }
  myAnswers = new Map();
  if (!myTableId) { render(); return; }
  const q = fs.query(refs.answers, fs.where("tableId", "==", myTableId));
  unsubAnswers = fs.onSnapshot(q, (s) => {
    myAnswers = new Map(s.docs.map((d) => [d.data().qIndex, d.data()]));
    render();
  });
}

// ---- テーブル確保（先着ロック） --------------------------------------------
async function claim(tableId) {
  try {
    await fs.runTransaction(db, async (tx) => {
      const ref = refs.tableDoc(tableId);
      const snap = await tx.get(ref);
      const d = snap.data() || {};
      if (d.claimedByUid && d.claimedByUid !== myUid) throw new Error("taken");
      tx.update(ref, { claimedByUid: myUid, claimedAt: fs.serverTimestamp() });
    });
    // 以前に確保していた別テーブルは解放
    for (const t of tables) {
      if (t.id !== tableId && t.claimedByUid === myUid) {
        await fs.updateDoc(refs.tableDoc(t.id), { claimedByUid: null, claimedAt: null });
      }
    }
  } catch (e) {
    alert("このテーブルは既に他の方が参加しています。別のテーブルを選んでください。");
  }
}
window.claim = claim;

// ---- 回答送信 --------------------------------------------------------------
async function answer(choice) {
  const idx = ev.currentIndex;
  if (ev.phase !== PHASE.QUESTION || !myTableId) return;
  if (myAnswers.has(idx)) return; // 二重回答防止
  await fs.setDoc(refs.answerDoc(myTableId, idx), {
    tableId: myTableId, qIndex: idx, choice,
    answeredAt: fs.serverTimestamp(), correct: null, points: 0,
  });
}
window.answer = answer;

// =============================================================================
// 描画
// =============================================================================
function render() {
  const c = $("content");
  if (!ev) {
    $("title").textContent = "クイズ大会";
    c.innerHTML = `<div class="card center"><p class="big">📣</p>
      <p>主催者の準備が完了するまでお待ちください。</p></div>`;
    return;
  }
  $("title").textContent = ev.title;

  // テーブル未選択（受付/準備/出題中いつでも選べる。結果発表時は不要）
  if (!myTableId && ev.phase !== PHASE.FINISHED) { renderTableSelect(); return; }

  if (ev.phase === PHASE.SETUP || ev.phase === PHASE.LOBBY) { renderLobby(); return; }
  if (ev.phase === PHASE.QUESTION) { renderQuestion(false); return; }
  if (ev.phase === PHASE.REVEAL) { renderQuestion(true); return; }
  if (ev.phase === PHASE.FINISHED) { renderFinished(); return; }
}

function myTableName() {
  const t = tables.find((x) => x.id === myTableId);
  return t ? t.name : "";
}

function renderTableSelect() {
  let html = `<div class="card"><p>あなたのテーブルを選んでください。<br>
    <span class="muted">先に選んだ方がそのテーブルの代表になります。</span></p></div>
    <div class="choices">`;
  tables.forEach((t) => {
    const taken = !!t.claimedByUid;
    html += `<button class="choice" ${taken ? "disabled" : ""} onclick="claim('${t.id}')">
      ${esc(t.name)}${taken ? '<span class="badge">参加済み</span>' : ""}</button>`;
  });
  html += `</div>`;
  if (!tables.length) html = `<div class="card center"><p class="muted">テーブルの準備中です…</p></div>`;
  $("content").innerHTML = html;
}

function renderLobby() {
  $("content").innerHTML = `<div class="card center">
    <span class="pill">あなたのテーブル：${esc(myTableName())}</span>
    <p class="big" style="margin:18px 0">📣</p>
    <p>まもなく開始します。主催者の合図をお待ちください。</p>
    <button class="ghost" onclick="claim('')" style="display:none"></button>
  </div>
  <p class="muted center"><a href="#" onclick="window.changeTable();return false">テーブルを選び直す</a></p>`;
}
window.changeTable = () => { myTableId = null; render(); };

function renderQuestion(reveal) {
  const idx = ev.currentIndex;
  const q = questions[idx];
  if (!q) { $("content").innerHTML = '<div class="card center"><p class="muted">―</p></div>'; return; }
  const mine = myAnswers.get(idx);
  const answered = !!mine;

  let html = `<div class="card center" style="padding:10px">
    <span class="pill">${esc(myTableName())}</span>
    <span class="pill">第${idx + 1}問 / ${ev.questionCount}</span></div>`;
  html += `<div class="card"><p class="q-text">${esc(q.text)}</p></div><div class="choices quiz4">`;
  q.choices.forEach((c, i) => {
    let cls = "choice";
    if (reveal) {
      // 自分の回答が正解だったかは answer doc の correct で判定（正解選択肢は非公開）
      if (mine && mine.choice === i) cls += mine.correct ? " correct" : " wrong";
    } else if (mine && mine.choice === i) {
      cls += " selected";
    }
    const disabled = reveal || answered ? "disabled" : "";
    html += `<button class="${cls}" ${disabled} onclick="answer(${i})">${esc(c)}</button>`;
  });
  html += `</div>`;

  if (!reveal) {
    html += answered
      ? `<div class="card center"><p class="big">✅</p><p>回答を受け付けました！</p></div>`
      : `<p class="muted center">選択肢をタップして回答</p>`;
  } else {
    const txt = !answered ? "⏰ 時間切れ" : (mine.correct ? "🎉 正解！" : "😢 不正解");
    html += `<div class="card center"><p class="big">${txt}</p>
      <p class="muted">最終順位は最後にまとめて発表します。</p></div>`;
  }
  $("content").innerHTML = html;
}

function renderFinished() {
  const s = ev.standings || [];
  let html = `<div class="card center"><p class="big">🏆 最終結果</p></div><ol class="standings">`;
  s.forEach((g, i) => {
    const medal = ["🥇", "🥈", "🥉"][i] || (i + 1);
    const top = i < 3 ? `top${i + 1}` : "";
    const me = g.tableId === myTableId ? ' style="outline:2px solid var(--accent)"' : "";
    html += `<li class="${top}"${me}><span class="rank">${medal}</span>
      <b>${esc(g.name)}</b><span class="score">${g.score}点</span></li>`;
  });
  html += `</ol><div class="card center"><p class="muted">ご参加ありがとうございました！</p></div>`;
  $("content").innerHTML = html;
}
