// =============================================================================
// 参加者（代表者）画面：テーブル選択・回答・正誤確認・結果
// =============================================================================
import {
  fs, db, buildRefs, urlEventId, ensureAuth, guardConfig, PHASE, $, esc, showReconnectBanner,
} from "/common.js";
import { launchConfetti } from "/confetti.js";

let refs = null;
let myUid = null;
let myTableId = null;
let ev = null;
let tables = [];
let questions = [];
let celebratedReveal = -1;   // 紙吹雪を出した問題index
let celebratedFinish = false;
let editing = false;         // 「選び直す」中か
let lastIdx = -1;            // 問題が変わったら editing をリセット
let myAnswers = new Map(); // qIndex -> answer doc
let unsubAnswers = null;

if (guardConfig()) boot();

function boot() {
  if (!urlEventId) {
    $("content").innerHTML = `<div class="card center"><p class="big">🔗</p>
      <p>主催者から共有された<br><b>参加用リンク／QRコード</b>から開いてください。</p></div>`;
    return;
  }
  refs = buildRefs(urlEventId);
  init();
}

async function init() {
  myUid = (await ensureAuth()).uid;
  fs.onSnapshot(refs.event, (s) => { ev = s.exists() ? s.data() : null; render(); }, showReconnectBanner);
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
  setInterval(tickTimer, 250);
}

// カウントダウン（締切は手動。視覚的な「残り時間」演出）
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

// ---- 回答送信（即時送信＋締切前なら選び直し可）-----------------------------
async function answer(choice) {
  const idx = ev.currentIndex;
  if (ev.phase !== PHASE.QUESTION || !myTableId) return;
  editing = false;
  await fs.setDoc(refs.answerDoc(myTableId, idx), {
    tableId: myTableId, qIndex: idx, choice, uid: myUid,
    answeredAt: fs.serverTimestamp(), correct: null, points: 0,
  });
}
window.answer = answer;

// 「選び直す」：締切前のみ。選択肢を再びタップ可能にする
window.editAnswer = () => { editing = true; render(); };

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
  if (idx !== lastIdx) { editing = false; lastIdx = idx; } // 問題が変わったら選び直し状態を解除
  const q = questions[idx];
  if (!q) { $("content").innerHTML = '<div class="card center"><p class="muted">―</p></div>'; return; }
  const mine = myAnswers.get(idx);
  const answered = !!mine;
  const locked = answered && !editing; // 回答済みで選び直していない
  // 締切と同時に公開される正解番号で判定（採点到着を待たない＝チラつき防止）
  const correctIdx = (reveal && ev.revealIndex != null) ? ev.revealIndex : -1;
  const iGotIt = answered && (correctIdx >= 0 ? mine.choice === correctIdx : mine.correct === true);

  let html = `<div class="card center" style="padding:10px">
    <span class="pill">${esc(myTableName())}</span>
    <span class="pill">第${idx + 1}問 / ${ev.questionCount}</span></div>`;
  if (!reveal && ev.timeLimit) {
    html += `<div class="timer" id="timerWrap">
      <div class="tnum"><span id="tnum">${ev.timeLimit}</span> 秒</div>
      <div class="tbar"><span id="tbarFill" style="width:100%"></span></div></div>`;
  }
  html += `<div class="card"><p class="q-text">${esc(q.text)}</p></div><div class="choices quiz4">`;
  q.choices.forEach((c, i) => {
    const isMine = mine && mine.choice === i;
    let cls = "choice";
    if (reveal) {
      if (i === correctIdx) cls += " correct";                 // 正解を緑でハイライト
      else if (isMine) cls += " wrong";                        // 自分の誤答を赤
    }
    if (isMine) cls += " mine";                                // 自分の選択を枠で囲む（常時）
    const badge = isMine ? '<span class="badge">あなたの回答</span>' : "";
    const disabled = reveal || locked ? "disabled" : "";
    html += `<button class="${cls}" ${disabled} onclick="answer(${i})">${esc(c)}${badge}</button>`;
  });
  html += `</div>`;

  if (!reveal) {
    if (locked) {
      html += `<div class="card center"><p class="big pop">✅</p>
        <p>回答を受け付けました！</p>
        <button class="ghost" style="max-width:240px;margin:6px auto 0" onclick="window.editAnswer()">選び直す</button>
        <p class="muted" style="margin-top:8px">締切まで変更できます</p></div>`;
    } else if (editing) {
      html += `<p class="muted center">選び直し中：新しい選択肢をタップしてください</p>`;
    } else {
      html += `<p class="muted center">選択肢をタップして回答</p>`;
    }
  } else {
    const txt = !answered ? "⏰ 時間切れ" : (iGotIt ? "🎉 正解！" : "😢 不正解");
    html += `<div class="card center"><p class="big pop">${txt}</p>
      <p class="muted">最終順位は最後にまとめて発表します。</p></div>`;
    if (iGotIt && celebratedReveal !== idx) {
      celebratedReveal = idx;
      launchConfetti();
    }
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
  if (!celebratedFinish) { celebratedFinish = true; launchConfetti(140); }
}
