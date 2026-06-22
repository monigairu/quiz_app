// =============================================================================
// 主催者画面：作問・進行・採点・集計
// =============================================================================
import {
  fs, db, auth, refs, ensureAuth, gradeQuestion, guardConfig,
  PHASE, phaseLabel, $, esc, ms,
} from "/common.js";

if (guardConfig()) init();

// ---- ローカルキャッシュ（onSnapshot で更新）-------------------------------
let ev = null;                 // event ドキュメント
let questions = [];            // [{order, text, choices[]}]
let keys = new Map();          // order -> answerIndex
let tables = [];               // [{id, name, claimedByUid, claimedAt}]
let answers = [];              // [{tableId, qIndex, choice, answeredAt, correct, points}]
let hostUid = null;

async function init() {
  hostUid = (await ensureAuth()).uid;
  buildSetupUI();
  subscribe();
  $("joinUrl").textContent = location.origin + "/";
  $("dispUrl").textContent = location.origin + "/display";
}

// =============================================================================
// 1. 作問 UI
// =============================================================================
function buildSetupUI() {
  $("addQ").onclick = () => addQuestionRow();
  $("saveBtn").onclick = saveAndStart;
  addQuestionRow(); // 初期1問
}

function addQuestionRow(data) {
  const wrap = document.createElement("div");
  wrap.className = "card qrow";
  const gid = "g" + Math.random().toString(36).slice(2, 8);
  wrap.innerHTML = `
    <div class="row" style="align-items:center">
      <input class="q-text-input" placeholder="問題文" maxlength="120" />
      <button class="danger del" style="flex:0 0 auto;width:auto;padding:10px 14px">削除</button>
    </div>
    <p class="muted" style="margin:8px 0 2px">選択肢（2〜4個・正解を選択）</p>
    ${[0, 1, 2, 3].map((i) => `
      <label class="choice-edit">
        <input type="radio" name="${gid}" value="${i}" ${i === 0 ? "checked" : ""}>
        <input class="c-input" data-i="${i}" placeholder="選択肢${i + 1}${i < 2 ? "（必須）" : "（任意）"}" maxlength="60">
      </label>`).join("")}
  `;
  $("questions").appendChild(wrap);
  wrap.querySelector(".del").onclick = () => wrap.remove();
  if (data) {
    wrap.querySelector(".q-text-input").value = data.text;
    wrap.querySelectorAll(".c-input").forEach((el, i) => { el.value = data.choices[i] || ""; });
    const r = wrap.querySelector(`input[name="${gid}"][value="${data.answer}"]`);
    if (r) r.checked = true;
  }
}

function readSetupForm() {
  const title = $("title").value.trim() || "クイズ大会";
  const scoringMode = document.querySelector('input[name="scoring"]:checked').value;
  const tableNames = $("tables").value.split("\n").map((s) => s.trim()).filter(Boolean);

  const qrows = [...document.querySelectorAll(".qrow")];
  const qs = [];
  for (const [idx, row] of qrows.entries()) {
    const text = row.querySelector(".q-text-input").value.trim();
    const rawChoices = [...row.querySelectorAll(".c-input")].map((el) => el.value.trim());
    const correctSlot = Number(row.querySelector('input[type="radio"]:checked').value);
    if (!text && rawChoices.every((c) => !c)) continue; // 空行スキップ

    // 空欄を詰めつつ、正解スロットの新インデックスを求める
    const choices = [];
    let answer = -1;
    rawChoices.forEach((c, slot) => {
      if (!c) return;
      if (slot === correctSlot) answer = choices.length;
      choices.push(c);
    });
    if (!text) throw new Error(`問題${idx + 1}：問題文が空です`);
    if (choices.length < 2) throw new Error(`問題${idx + 1}：選択肢は2個以上必要です`);
    if (answer < 0) throw new Error(`問題${idx + 1}：正解の選択肢が空欄です`);
    qs.push({ text, choices, answer });
  }
  if (!tableNames.length) throw new Error("テーブルを1つ以上入力してください");
  if (!qs.length) throw new Error("問題を1問以上入力してください");
  return { title, scoringMode, tableNames, qs };
}

async function saveAndStart() {
  let form;
  try { form = readSetupForm(); }
  catch (e) { $("setupMsg").textContent = "⚠️ " + e.message; return; }

  $("setupMsg").textContent = "保存中…";
  const batch = fs.writeBatch(db);

  // 既存データを全削除（再保存・やり直し対応）
  for (const col of [refs.questions, refs.keys, refs.tables, refs.answers]) {
    const snap = await fs.getDocs(col);
    snap.forEach((d) => batch.delete(d.ref));
  }
  // 新規書き込み
  form.qs.forEach((q, i) => {
    batch.set(refs.questionDoc(i), { order: i, text: q.text, choices: q.choices });
    batch.set(refs.keyDoc(i), { order: i, answerIndex: q.answer });
  });
  form.tableNames.forEach((name, i) => {
    batch.set(refs.tableDoc("t" + i), { name, claimedByUid: null, claimedAt: null });
  });
  batch.set(refs.event, {
    title: form.title,
    scoringMode: form.scoringMode,
    phase: PHASE.LOBBY,
    currentIndex: -1,
    questionCount: form.qs.length,
    standings: null,
    hostUid,
    updatedAt: fs.serverTimestamp(),
  });
  await batch.commit();
  $("setupMsg").textContent = "✅ 受付を開始しました。";
}

// =============================================================================
// 2. リアルタイム購読
// =============================================================================
function subscribe() {
  fs.onSnapshot(refs.event, (snap) => { ev = snap.exists() ? snap.data() : null; render(); });
  fs.onSnapshot(refs.questions, (snap) => {
    questions = snap.docs.map((d) => d.data()).sort((a, b) => a.order - b.order);
    render();
  });
  fs.onSnapshot(refs.keys, (snap) => {
    keys = new Map(snap.docs.map((d) => [d.data().order, d.data().answerIndex]));
    render();
  });
  fs.onSnapshot(refs.tables, (snap) => {
    tables = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.id.localeCompare(b.id));
    render();
  });
  fs.onSnapshot(refs.answers, (snap) => {
    answers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
}

// =============================================================================
// 3. 進行コントロール
// =============================================================================
function bindControls() {
  $("nextBtn").onclick = nextQuestion;
  $("closeBtn").onclick = closeAndGrade;
  $("finishBtn").onclick = () => { if (confirm("最終結果を発表しますか？")) finish(); };
  $("backBtn").onclick = () => { if (confirm("作問画面に戻ります。進行状況は保持されます。")) fs.updateDoc(refs.event, { phase: PHASE.SETUP }); };
  $("resetBtn").onclick = resetScores;
}

async function nextQuestion() {
  const next = (ev.currentIndex ?? -1) + 1;
  if (next >= ev.questionCount) return;
  await fs.updateDoc(refs.event, { phase: PHASE.QUESTION, currentIndex: next });
}

async function closeAndGrade() {
  if (ev.phase !== PHASE.QUESTION) return;
  const idx = ev.currentIndex;
  // まず締切（参加者の回答を止める）
  await fs.updateDoc(refs.event, { phase: PHASE.REVEAL });

  const answerIndex = keys.get(idx);
  const forThis = answers.filter((a) => a.qIndex === idx);
  const correctEntries = forThis
    .filter((a) => a.choice === answerIndex)
    .map((a) => ({ tableId: a.tableId, answeredAt: ms(a.answeredAt) }));
  const points = gradeQuestion(ev.scoringMode, correctEntries);

  const batch = fs.writeBatch(db);
  for (const a of forThis) {
    const correct = a.choice === answerIndex;
    batch.update(refs.answerDoc(a.tableId, idx), { correct, points: points.get(a.tableId) || 0 });
  }
  await batch.commit();
}

function computeStandings() {
  const totals = new Map(); // tableId -> score
  for (const a of answers) totals.set(a.tableId, (totals.get(a.tableId) || 0) + (a.points || 0));
  return tables.map((t) => ({
    tableId: t.id, name: t.name, score: totals.get(t.id) || 0,
  })).sort((a, b) => b.score - a.score);
}

async function finish() {
  await fs.updateDoc(refs.event, { phase: PHASE.FINISHED, standings: computeStandings() });
}

async function resetScores() {
  if (!confirm("全テーブルの得点を消去して受付状態に戻します。よろしいですか？")) return;
  const batch = fs.writeBatch(db);
  const snap = await fs.getDocs(refs.answers);
  snap.forEach((d) => batch.delete(d.ref));
  batch.update(refs.event, { phase: PHASE.LOBBY, currentIndex: -1, standings: null });
  await batch.commit();
}

async function releaseTable(id) {
  if (!confirm("このテーブルの枠を解放しますか？（代表者の交代が可能になります）")) return;
  await fs.updateDoc(refs.tableDoc(id), { claimedByUid: null, claimedAt: null });
}
window.releaseTable = releaseTable;

// =============================================================================
// 4. 描画
// =============================================================================
let controlsBound = false;

function render() {
  if (!ev) { // 未保存：作問画面
    $("setup").style.display = "block";
    $("control").style.display = "none";
    $("phasePill").textContent = phaseLabel[PHASE.SETUP];
    return;
  }
  $("phasePill").textContent = phaseLabel[ev.phase] || ev.phase;

  if (ev.phase === PHASE.SETUP) {
    $("setup").style.display = "block";
    $("control").style.display = "none";
    return;
  }
  // 進行画面
  $("setup").style.display = "none";
  $("control").style.display = "block";
  if (!controlsBound) { bindControls(); controlsBound = true; }

  $("ctlTitle").textContent = ev.title;
  const modeLabel = ev.scoringMode === "speed" ? "正解＋早押し加点" : "正解数のみ";
  $("ctlMeta").textContent =
    `採点: ${modeLabel} / 全${ev.questionCount}問` +
    (ev.currentIndex >= 0 ? `（第${ev.currentIndex + 1}問）` : "");

  // ボタン活性
  const last = ev.currentIndex + 1 >= ev.questionCount;
  $("nextBtn").disabled = ev.phase === PHASE.QUESTION || (last && ev.phase !== PHASE.LOBBY);
  $("nextBtn").textContent = ev.currentIndex < 0 ? "▶ クイズを開始" : "▶ 次の問題";
  $("closeBtn").disabled = ev.phase !== PHASE.QUESTION;

  renderLive();
  renderTableStatus();
  renderStandings();
}

function renderLive() {
  const a = $("liveArea");
  if (ev.phase === PHASE.LOBBY) {
    const claimed = tables.filter((t) => t.claimedByUid).length;
    a.innerHTML = `<p class="muted">受付中… ${claimed}/${tables.length} テーブルが参加しています。</p>`;
    return;
  }
  if (ev.phase === PHASE.FINISHED) { a.innerHTML = '<p class="big center">🏆 結果発表中</p>'; return; }

  const q = questions[ev.currentIndex];
  if (!q) { a.innerHTML = '<p class="muted">―</p>'; return; }
  const forThis = answers.filter((x) => x.qIndex === ev.currentIndex);
  const counts = q.choices.map((_, i) => forThis.filter((x) => x.choice === i).length);
  const answerIndex = keys.get(ev.currentIndex);

  let html = `<p class="q-text">${esc(q.text)}</p>`;
  html += `<p class="muted">回答 ${forThis.length}/${tables.length} テーブル</p>`;
  q.choices.forEach((c, i) => {
    const correct = ev.phase === PHASE.REVEAL && i === answerIndex;
    const pct = tables.length ? Math.round((counts[i] / tables.length) * 100) : 0;
    html += `<div class="statrow"><div>${correct ? "✅ " : ""}<b>${esc(c)}</b>
      <span class="muted">${counts[i]}</span></div>
      <div class="bar"><span style="width:${pct}%;${correct ? "background:#22c55e" : ""}"></span></div></div>`;
  });
  if (ev.phase === PHASE.REVEAL && answerIndex != null) {
    html += `<p class="center" style="margin-top:8px"><span class="pill">正解：${esc(q.choices[answerIndex])}</span></p>`;
  }
  a.innerHTML = html;
}

function renderTableStatus() {
  const el = $("tableStatus");
  if (!tables.length) { el.innerHTML = '<p class="muted">―</p>'; return; }
  el.innerHTML = tables.map((t) => {
    const taken = !!t.claimedByUid;
    return `<div class="statrow" style="display:flex;align-items:center;gap:10px">
      <span class="pill" style="${taken ? "background:#14532d" : ""}">${taken ? "参加中" : "空き"}</span>
      <b>${esc(t.name)}</b>
      ${taken ? `<button class="ghost" style="margin-left:auto;width:auto;padding:8px 14px"
         onclick="releaseTable('${t.id}')">解放</button>` : ""}
    </div>`;
  }).join("");
}

function renderStandings() {
  const card = $("standingsCard");
  if (ev.phase !== PHASE.FINISHED || !ev.standings) { card.style.display = "none"; return; }
  card.style.display = "block";
  $("standings").innerHTML = ev.standings.map((g, i) => {
    const medal = ["🥇", "🥈", "🥉"][i] || (i + 1);
    const top = i < 3 ? `top${i + 1}` : "";
    return `<li class="${top}"><span class="rank">${medal}</span>
      <b>${esc(g.name)}</b><span class="score">${g.score}点</span></li>`;
  }).join("");
}
