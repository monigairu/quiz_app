// =============================================================================
// 主催者画面：作問・進行・採点・集計
// =============================================================================
import {
  fs, db, refs, gradeQuestion, guardConfig,
  watchAuth, googleSignIn, signOutHost, watchAdmins, normEmail,
  PHASE, phaseLabel, $, esc, ms,
} from "/common.js";

if (guardConfig()) init();

// ---- ローカルキャッシュ（onSnapshot で更新）-------------------------------
let ev = null;                 // event ドキュメント
let questions = [];            // [{order, text, choices[]}]
let keys = new Map();          // order -> answerIndex
let tables = [];               // [{id, name, claimedByUid, claimedAt}]
let answers = [];              // [{tableId, qIndex, choice, answeredAt, correct, points}]

// ---- 認証・認可 ------------------------------------------------------------
// 管理者(オーナー＋共同作成者)のメールはコードに持たず、Firestore(meta/admins)で管理。
// セキュリティルールにより「管理者だけ」が meta/admins を読めるので、
// 読み取り成功＝自分は管理者、エラー＝権限なし(または未初期化)、と判定できる。
let me = null;                 // 現在の Google ユーザー
let isAdmin = false;           // 管理者として読み取りに成功したか
let coAdmins = [];             // 管理者メール一覧
let owner = "";                // オーナーのメール
let unsubAdmins = null;
let workspaceBooted = false;

function init() {
  $("googleLogin").onclick = () => googleSignIn().catch((e) => {
    $("gateMsg").textContent = "ログインに失敗しました：" + (e.code || e.message);
  });
  $("logoutBtn").onclick = () => signOutHost();
  watchAuth((user) => { me = user; onAuthChange(); });
}

function onAuthChange() {
  if (unsubAdmins) { unsubAdmins(); unsubAdmins = null; }
  isAdmin = false; coAdmins = []; owner = "";
  if (me && !me.isAnonymous) subscribeAdmins();
  renderGate();
}

function subscribeAdmins() {
  unsubAdmins = watchAdmins(
    (data) => { // 読めた＝自分は管理者
      isAdmin = true; coAdmins = data.emails; owner = data.owner;
      renderGate(); renderAdminPanel();
    },
    () => { // 権限なし or 未初期化
      isAdmin = false; renderGate();
    });
}

const amOwner = () => me && owner && normEmail(me.email) === owner;

function renderGate() {
  if (isAdmin) {
    $("gate").style.display = "none";
    $("workspace").style.display = "block";
    $("userEmail").textContent = me.email;
    $("roleBadge").textContent = amOwner() ? "オーナー" : "共同作成者";
    if (!workspaceBooted) { bootWorkspace(); workspaceBooted = true; }
    renderAdminPanel();
    return;
  }
  $("gate").style.display = "block";
  $("workspace").style.display = "none";
  const authed = me && !me.isAnonymous;
  if (!authed) { $("gateMsg").textContent = ""; return; }
  // ログイン済みだが管理者ではない（または初回・未初期化）
  $("gateMsg").innerHTML =
    `ログイン中：<b>${esc(me.email)}</b><br>` +
    `このアカウントには作成権限がありません。<br>` +
    `<button class="green" id="bootBtn" style="max-width:340px;margin:14px auto 6px">` +
    `初回セットアップ：このアカウントをオーナーとして登録</button>` +
    `<br><span class="muted">※ 既にオーナーがいる場合は、その方に共同作成者として追加してもらってください。</span>` +
    `<br><button class="ghost" id="switchAcc" style="max-width:240px;margin:12px auto 0">別のアカウントでログイン</button>`;
  $("bootBtn").onclick = registerAsOwner;
  $("switchAcc").onclick = () => signOutHost().then(() => googleSignIn());
}

// 初回のみ：自分をオーナーとして登録（ルールでオーナー本人以外は拒否される）
async function registerAsOwner() {
  if (!confirm("このGoogleアカウントを、このクイズのオーナー（作成者）として登録します。よろしいですか？")) return;
  const email = normEmail(me.email);
  try {
    await fs.setDoc(refs.metaAdmins, { emails: [email], owner: email }, { merge: true });
    if (unsubAdmins) { unsubAdmins(); unsubAdmins = null; }
    subscribeAdmins(); // 登録後に再購読 → 管理者として入れる
  } catch (e) {
    alert("オーナー登録できませんでした。\n" +
      "（既に別のオーナーが登録済み、またはこのアカウントは許可されていません）\n" + (e.code || e.message));
  }
}

function bootWorkspace() {
  buildSetupUI();
  subscribe();
  bindAdminPanel();
  $("joinUrl").textContent = location.origin + "/";
  $("dispUrl").textContent = location.origin + "/display";
}

// ---- 管理者設定パネル ------------------------------------------------------
function bindAdminPanel() {
  $("adminToggle").onclick = () => {
    const p = $("adminPanel");
    p.style.display = p.style.display === "none" ? "block" : "none";
  };
  $("addAdmin").onclick = addCoAdmin;
}

async function addCoAdmin() {
  const email = normEmail($("newAdmin").value);
  if (!email || !email.includes("@")) { $("adminMsg").textContent = "⚠️ メールアドレスを入力してください"; return; }
  if (coAdmins.includes(email)) { $("adminMsg").textContent = "すでに管理者です"; return; }
  $("adminMsg").textContent = "追加中…";
  try {
    await fs.updateDoc(refs.metaAdmins, { emails: fs.arrayUnion(email) });
    $("newAdmin").value = "";
    $("adminMsg").textContent = "✅ 追加しました";
  } catch (e) { $("adminMsg").textContent = "⚠️ " + (e.code || e.message); }
}

async function removeCoAdmin(email) {
  if (email === owner) { alert("オーナーは削除できません。"); return; }
  if (!confirm(`${email} を管理者から外しますか？`)) return;
  try { await fs.updateDoc(refs.metaAdmins, { emails: fs.arrayRemove(email) }); }
  catch (e) { $("adminMsg").textContent = "⚠️ " + (e.code || e.message); }
}
window.removeCoAdmin = removeCoAdmin;

function renderAdminPanel() {
  const list = $("adminList");
  if (!list) return;
  list.innerHTML = coAdmins.map((e) => {
    const isOwner = e === owner;
    return `<li><b>${esc(e)}</b>${
      isOwner ? '<span class="score">オーナー</span>'
              : `<button class="ghost" style="margin-left:auto;width:auto;padding:6px 12px"
                   onclick="removeCoAdmin('${esc(e)}')">削除</button>`}</li>`;
  }).join("");
}

// =============================================================================
// 1. 作問 UI
// =============================================================================
function buildSetupUI() {
  $("addQ").onclick = () => addQuestionRow();
  $("saveBtn").onclick = saveAndStart;
  $("clearDraft").onclick = clearDraft;
  buildTableCountSelect();

  // 下書きの復元（あれば）。無ければ空の1問でスタート
  const restored = loadDraft();
  if (!restored) addQuestionRow();

  // 入力のたびに自動保存（デバウンス）
  $("setup").addEventListener("input", scheduleSaveDraft);
  $("setup").addEventListener("change", scheduleSaveDraft);
}

// ---- 下書きの自動保存（localStorage）--------------------------------------
const DRAFT_KEY = "quizDraft:v1";
let draftTimer = null;

function scheduleSaveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 500);
}

function serializeQuestions() {
  return [...document.querySelectorAll(".qrow")].map((row) => ({
    text: row.querySelector(".q-text-input").value,
    choices: [...row.querySelectorAll(".c-input")].map((el) => el.value),
    answer: Number(row.querySelector('input[type="radio"]:checked').value),
  }));
}

function saveDraft() {
  try {
    const draft = {
      title: $("title").value,
      scoring: document.querySelector('input[name="scoring"]:checked').value,
      tables: $("tables").value,
      questions: serializeQuestions(),
      savedAt: Date.now(),
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    const t = new Date(draft.savedAt);
    $("draftStatus").textContent =
      `💾 自動保存しました（${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}）`;
  } catch (_) { /* localStorage 不可環境は無視 */ }
}

function loadDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (_) { return false; }
  if (!draft || !Array.isArray(draft.questions)) return false;

  $("title").value = draft.title || "懇親会クイズ大会";
  const r = document.querySelector(`input[name="scoring"][value="${draft.scoring}"]`);
  if (r) r.checked = true;
  $("tables").value = draft.tables || "";
  $("questions").innerHTML = "";
  if (draft.questions.length) draft.questions.forEach((q) => addQuestionRow(q));
  else addQuestionRow();
  $("draftStatus").textContent = "✅ 前回の下書きを復元しました（自動保存中）";
  return true;
}

function clearDraft() {
  if (!confirm("下書きを消して、入力を最初からやり直しますか？")) return;
  localStorage.removeItem(DRAFT_KEY);
  $("title").value = "懇親会クイズ大会";
  document.querySelector('input[name="scoring"][value="correct"]').checked = true;
  $("tables").value = "";
  $("tableCount").value = "";
  $("questions").innerHTML = "";
  addQuestionRow();
  $("draftStatus").textContent = "🗑️ 下書きを消しました";
}

// グループ数プルダウン（1〜20）。選ぶとテーブル名欄に「グループ1〜N」を自動入力
function buildTableCountSelect() {
  const sel = $("tableCount");
  sel.innerHTML = '<option value="">選択してください…</option>' +
    Array.from({ length: 20 }, (_, i) => `<option value="${i + 1}">${i + 1} グループ</option>`).join("");
  sel.onchange = () => {
    const n = Number(sel.value);
    if (!n) return;
    $("tables").value = Array.from({ length: n }, (_, i) => "グループ" + (i + 1)).join("\n");
  };
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
    revealIndex: null,
    hostUid: me ? me.uid : null,
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
  await fs.updateDoc(refs.event, { phase: PHASE.QUESTION, currentIndex: next, revealIndex: null });
}

async function closeAndGrade() {
  if (ev.phase !== PHASE.QUESTION) return;
  const idx = ev.currentIndex;
  const answerIndex = keys.get(idx);
  // 締切（参加者の回答を止める）＋ 会場表示用に正解インデックスを公開
  await fs.updateDoc(refs.event, { phase: PHASE.REVEAL, revealIndex: answerIndex ?? null });

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
