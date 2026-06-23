// =============================================================================
// 主催者画面：作問・進行・採点・集計
// =============================================================================
import {
  fs, db, buildRefs, userDoc, urlEventId, genEventCode, gradeQuestion, guardConfig,
  watchAuth, googleSignIn, signOutHost, normEmail,
  PHASE, phaseLabel, $, esc, ms, showReconnectBanner,
} from "/common.js";

// ---- ルームコードの決定（クイズごとのURL）----------------------------------
let refs = null;
let EID = null;

if (guardConfig()) boot();

function boot() {
  EID = urlEventId;
  if (!EID) {
    // コード無しで開いたら、前回のコードを再開 or 新規発行して URL に付与
    EID = localStorage.getItem("lastEventCode") || genEventCode();
    location.replace(location.pathname + "?r=" + EID);
    return;
  }
  localStorage.setItem("lastEventCode", EID);
  refs = buildRefs(EID);
  init();
}

function startNewQuiz() {
  if (!confirm("新しいクイズ（別の参加URL）を作成します。よろしいですか？")) return;
  const code = genEventCode();
  localStorage.setItem("lastEventCode", code);
  location.href = location.pathname + "?r=" + code;
}

// ---- クイズ履歴（Googleアカウント単位・Firestore users/{uid}）---------------
let myQuizzes = [];          // [{code,title,updatedAt}]
let unsubUser = null;

function watchMyQuizzes() {
  if (unsubUser) { unsubUser(); unsubUser = null; }
  unsubUser = fs.onSnapshot(userDoc(me.uid), (snap) => {
    const d = snap.exists() ? snap.data() : {};
    myQuizzes = Array.isArray(d.quizzes) ? d.quizzes : [];
    renderSidebar();
  }, () => { /* 取得失敗は無視 */ });
}

async function persistMyQuizzes() {
  try { await fs.setDoc(userDoc(me.uid), { quizzes: myQuizzes }, { merge: true }); } catch (_) { /* noop */ }
}

async function upsertMyQuiz(code, title) {
  const list = myQuizzes.slice();
  const i = list.findIndex((x) => x.code === code);
  if (i >= 0) { if (title) list[i].title = title; list[i].updatedAt = Date.now(); }
  else list.unshift({ code, title: title || "(無題のクイズ)", updatedAt: Date.now() });
  myQuizzes = list.slice(0, 100);
  renderSidebar();
  await persistMyQuizzes();
}

window.removeQuizFromList = async (code) => {
  if (!confirm("このクイズを一覧から消しますか？（参加データ自体は消えません）")) return;
  myQuizzes = myQuizzes.filter((x) => x.code !== code);
  renderSidebar();
  await persistMyQuizzes();
};
window.openQuiz = (code) => { location.href = location.pathname + "?r=" + code; };

function renderSidebar() {
  const el = $("quizList");
  if (!el) return;
  const list = myQuizzes.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) { el.innerHTML = '<p class="muted" style="font-size:.85rem">まだありません</p>'; return; }
  el.innerHTML = list.map((it) => `
    <button class="quizitem ${it.code === EID ? "active" : ""}" onclick="openQuiz('${it.code}')">
      <span class="qt">${esc(it.title || "(無題のクイズ)")}</span>
      <span class="qc">🔑 ${esc(it.code)}</span>
      <span class="qx" title="一覧から削除" onclick="event.stopPropagation();removeQuizFromList('${it.code}')">✕</span>
    </button>`).join("");
}

// ---- ローカルキャッシュ（onSnapshot で更新）-------------------------------
let ev = null;                 // event ドキュメント
let eventLoaded = false;       // event の初回スナップショットを受信したか
let questions = [];            // [{order, text, choices[]}]
let keys = new Map();          // order -> answerIndex
let tables = [];               // [{id, name, claimedByUid, claimedAt}]
let answers = [];              // [{tableId, qIndex, choice, answeredAt, correct, points}]

// ---- 認証・所有権 ----------------------------------------------------------
// ログインは Google アカウントがあれば誰でも。各クイズに ownerUid を持たせ、
// 自分のクイズは自分だけ／共有(editors)した相手だけが編集・進行できる。
let me = null;                 // 現在の Google ユーザー
let workspaceBooted = false;
let amOwner = false;           // 自分がこのクイズのオーナー
let amEditor = false;          // 共同編集者
let accessDenied = false;      // 自分のクイズでも共有先でもない

function init() {
  $("googleLogin").onclick = () => googleSignIn().catch((e) => {
    $("gateMsg").textContent = "ログインに失敗しました：" + (e.code || e.message);
  });
  $("logoutBtn").onclick = () => signOutHost();
  watchAuth((user) => { me = user; renderGate(); });
}

function renderGate() {
  const authed = me && !me.isAnonymous;
  if (authed) {
    $("gate").style.display = "none";
    $("workspace").style.display = "block";
    $("userEmail").textContent = me.email;
    if (!workspaceBooted) { bootWorkspace(); workspaceBooted = true; }
    return;
  }
  $("gate").style.display = "block";
  $("workspace").style.display = "none";
  $("gateMsg").textContent = "";
}

function bootWorkspace() {
  buildSetupUI();
  watchMyQuizzes();
  subscribe();
  bindSharePanel();
  $("joinUrl").textContent = location.origin + "/?r=" + EID;
  $("dispUrl").textContent = location.origin + "/display?r=" + EID;
  $("roomCode").textContent = EID;
  $("newQuizBtn").onclick = startNewQuiz;
  $("newQuizBtn2").onclick = startNewQuiz;
  $("denyNew").onclick = startNewQuiz;
  $("sidebarToggle").onclick = () => $("sidebar").classList.toggle("open");
}

// このクイズに対する自分の権限を判定
function computeAccess() {
  if (!ev) { amOwner = true; amEditor = false; accessDenied = false; return; } // 新規（保存時に自分がオーナー）
  amOwner = ev.ownerUid ? ev.ownerUid === me.uid : true;                       // 旧データ(owner無し)は許可
  amEditor = Array.isArray(ev.editors) && ev.editors.includes(normEmail(me.email));
  accessDenied = !(amOwner || amEditor);
}

// ---- 共有（このクイズの共同編集者）-----------------------------------------
function bindSharePanel() {
  $("adminToggle").onclick = () => {
    const p = $("adminPanel");
    p.style.display = p.style.display === "none" ? "block" : "none";
  };
  $("addAdmin").onclick = addEditor;
}

async function addEditor() {
  if (!amOwner) { $("adminMsg").textContent = "共有できるのはオーナーだけです"; return; }
  const email = normEmail($("newAdmin").value);
  if (!email || !email.includes("@")) { $("adminMsg").textContent = "⚠️ メールアドレスを入力してください"; return; }
  $("adminMsg").textContent = "追加中…";
  try {
    await fs.updateDoc(refs.event, { editors: fs.arrayUnion(email) });
    $("newAdmin").value = "";
    $("adminMsg").textContent = "✅ 共有しました";
  } catch (e) { $("adminMsg").textContent = "⚠️ " + (e.code || e.message); }
}

window.removeEditor = async (email) => {
  if (!confirm(`${email} の共有を解除しますか？`)) return;
  try { await fs.updateDoc(refs.event, { editors: fs.arrayRemove(email) }); }
  catch (e) { $("adminMsg").textContent = "⚠️ " + (e.code || e.message); }
};

function renderSharePanel() {
  const list = $("adminList");
  if (!list) return;
  const editors = (ev && Array.isArray(ev.editors)) ? ev.editors : [];
  const ownerEmail = (ev && ev.ownerEmail) || (amOwner && me ? normEmail(me.email) : "");
  const rows = [];
  if (ownerEmail) rows.push(`<li><b>${esc(ownerEmail)}</b><span class="score">オーナー</span></li>`);
  for (const e of editors) {
    rows.push(`<li><b>${esc(e)}</b>${
      amOwner ? `<button class="ghost" style="margin-left:auto;width:auto;padding:6px 12px"
                   onclick="removeEditor('${esc(e)}')">解除</button>`
              : '<span class="score">共同編集者</span>'}</li>`);
  }
  list.innerHTML = rows.join("") || '<p class="muted">―</p>';
}

// =============================================================================
// 1. 作問 UI
// =============================================================================
function buildSetupUI() {
  $("addQ").onclick = () => {
    const row = addQuestionRow();
    scheduleSaveDraft();
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.querySelector(".q-text-input").focus();
  };
  $("saveBtn").onclick = saveAndStart;
  $("clearDraft").onclick = clearDraft;
  buildTableCountSelect();

  // フォームの初期化はデータ到着後に maybeInitForm() で行う。
  // この端末に未保存の下書きがあれば、それを優先的に復元。
  if (loadDraft()) formInitialized = true;

  // 入力のたびに自動保存（デバウンス）
  $("setup").addEventListener("input", scheduleSaveDraft);
  $("setup").addEventListener("change", scheduleSaveDraft);
}

// 保存済み or 下書き or 空、のどれでフォームを埋めるかをデータ確定後に判断
let formInitialized = false;

function maybeInitForm() {
  if (formInitialized || accessDenied || !eventLoaded) return;
  if (ev) {
    // 保存済みクイズ：問題と正解キーが揃ったらフォームへ読み込む
    if (questions.length && keys.size >= questions.length) {
      loadSavedIntoForm();
      formInitialized = true;
    }
  } else {
    // 新規クイズ：空の1問でスタート
    addQuestionRow();
    formInitialized = true;
  }
}

// Firestore の保存済み内容を作問フォームに読み込む（共同編集・別端末対応）
function loadSavedIntoForm() {
  $("title").value = ev.title || "懇親会クイズ大会";
  const r = document.querySelector(`input[name="scoring"][value="${ev.scoringMode}"]`);
  if (r) r.checked = true;
  if (ev.timeLimit != null) $("timeLimit").value = ev.timeLimit;
  $("tables").value = tables.map((t) => t.name).join("\n");
  $("questions").innerHTML = "";
  questions.forEach((q) => addQuestionRow({ text: q.text, choices: q.choices, answer: keys.get(q.order) ?? 0 }));
  $("draftStatus").textContent = "📥 保存済みの内容を読み込みました";
}

// ---- 下書きの自動保存（localStorage・クイズ単位）---------------------------
const DRAFT_KEY = () => "quizDraft:v1:" + EID;
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
      timeLimit: $("timeLimit").value,
      tables: $("tables").value,
      questions: serializeQuestions(),
      savedAt: Date.now(),
    };
    localStorage.setItem(DRAFT_KEY(), JSON.stringify(draft));
    const t = new Date(draft.savedAt);
    $("draftStatus").textContent =
      `💾 自動保存しました（${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}）`;
  } catch (_) { /* localStorage 不可環境は無視 */ }
}

function loadDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY())); } catch (_) { return false; }
  if (!draft || !Array.isArray(draft.questions) || !draft.questions.length) return false;

  $("title").value = draft.title || "懇親会クイズ大会";
  const r = document.querySelector(`input[name="scoring"][value="${draft.scoring}"]`);
  if (r) r.checked = true;
  if (draft.timeLimit != null) $("timeLimit").value = draft.timeLimit;
  $("tables").value = draft.tables || "";
  $("questions").innerHTML = "";
  draft.questions.forEach((q) => addQuestionRow(q));
  $("draftStatus").textContent = "✅ この端末の下書きを復元しました（自動保存中）";
  return true;
}

function clearDraft() {
  if (!confirm("この端末の下書きを消して、保存済みの内容に戻します。よろしいですか？")) return;
  localStorage.removeItem(DRAFT_KEY());
  $("questions").innerHTML = "";
  $("tableCount").value = "";
  formInitialized = false;
  maybeInitForm();
  if (!formInitialized) { addQuestionRow(); formInitialized = true; } // 保存前データなし
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

function addQuestionRow(data, afterNode) {
  const wrap = document.createElement("div");
  wrap.className = "card qrow";
  const gid = "g" + Math.random().toString(36).slice(2, 8);
  wrap.innerHTML = `
    <div class="qrow-head">
      <span class="pill qnum">問題</span>
      <div class="qrow-actions">
        <button class="ghost up" title="上へ">↑</button>
        <button class="ghost down" title="下へ">↓</button>
        <button class="ghost dup" title="複製">複製</button>
        <button class="danger del" title="削除">削除</button>
      </div>
    </div>
    <input class="q-text-input" placeholder="問題文" maxlength="120" />
    <p class="muted" style="margin:8px 0 2px">選択肢（2〜4個・ラジオで正解を選択）</p>
    ${[0, 1, 2, 3].map((i) => `
      <label class="choice-edit">
        <input type="radio" name="${gid}" value="${i}" ${i === 0 ? "checked" : ""}>
        <input class="c-input" data-i="${i}" placeholder="選択肢${i + 1}${i < 2 ? "（必須）" : "（任意）"}" maxlength="60">
      </label>`).join("")}
  `;
  if (afterNode && afterNode.nextSibling) $("questions").insertBefore(wrap, afterNode.nextSibling);
  else if (afterNode) $("questions").appendChild(wrap);
  else $("questions").appendChild(wrap);

  wrap.querySelector(".del").onclick = () => { wrap.remove(); renumberQuestions(); scheduleSaveDraft(); };
  wrap.querySelector(".up").onclick = () => moveQuestion(wrap, -1);
  wrap.querySelector(".down").onclick = () => moveQuestion(wrap, 1);
  wrap.querySelector(".dup").onclick = () => {
    addQuestionRow(readQuestionRow(wrap), wrap);
    renumberQuestions(); scheduleSaveDraft();
  };

  if (data) {
    wrap.querySelector(".q-text-input").value = data.text || "";
    wrap.querySelectorAll(".c-input").forEach((el, i) => { el.value = (data.choices && data.choices[i]) || ""; });
    const r = wrap.querySelector(`input[name="${gid}"][value="${data.answer}"]`);
    if (r) r.checked = true;
  }
  renumberQuestions();
  return wrap;
}

// 1つの問題カードの内容を読み出す（複製・下書き用）
function readQuestionRow(wrap) {
  return {
    text: wrap.querySelector(".q-text-input").value,
    choices: [...wrap.querySelectorAll(".c-input")].map((el) => el.value),
    answer: Number(wrap.querySelector('input[type="radio"]:checked').value),
  };
}

// 「問題 N」を振り直す＋先頭/末尾の↑↓を無効化
function renumberQuestions() {
  const rows = [...document.querySelectorAll(".qrow")];
  rows.forEach((row, i) => {
    row.querySelector(".qnum").textContent = "問題 " + (i + 1);
    row.querySelector(".up").disabled = i === 0;
    row.querySelector(".down").disabled = i === rows.length - 1;
  });
}

function moveQuestion(wrap, dir) {
  const rows = [...document.querySelectorAll(".qrow")];
  const i = rows.indexOf(wrap);
  const j = i + dir;
  if (j < 0 || j >= rows.length) return;
  if (dir < 0) $("questions").insertBefore(wrap, rows[j]);
  else $("questions").insertBefore(rows[j], wrap);
  renumberQuestions(); scheduleSaveDraft();
}

function readSetupForm() {
  const title = $("title").value.trim() || "クイズ大会";
  const scoringMode = document.querySelector('input[name="scoring"]:checked').value;
  const timeLimit = Number($("timeLimit").value) || 0;
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
  return { title, scoringMode, timeLimit, tableNames, qs };
}

async function saveAndStart() {
  let form;
  try { form = readSetupForm(); }
  catch (e) { $("setupMsg").textContent = "⚠️ " + e.message; return; }

  $("setupMsg").textContent = "保存中…";
  // 所有者・共有先は維持（再保存でも引き継ぐ）。新規なら自分がオーナー。
  const ownerUid = (ev && ev.ownerUid) || me.uid;
  const ownerEmail = (ev && ev.ownerEmail) || normEmail(me.email);
  const editors = (ev && Array.isArray(ev.editors)) ? ev.editors : [];

  try {
    // 1) イベント本体を先に作成/更新（サブコレクションのルール評価に必要）
    await fs.setDoc(refs.event, {
      title: form.title,
      scoringMode: form.scoringMode,
      timeLimit: form.timeLimit,
      questionStartedAt: null,
      phase: PHASE.LOBBY,
      currentIndex: -1,
      questionCount: form.qs.length,
      standings: null,
      revealIndex: null,
      ownerUid, ownerEmail, editors,
      updatedAt: fs.serverTimestamp(),
    });

    // 2) サブコレクションを入れ替え
    const batch = fs.writeBatch(db);
    for (const col of [refs.questions, refs.keys, refs.tables, refs.answers]) {
      const snap = await fs.getDocs(col);
      snap.forEach((d) => batch.delete(d.ref));
    }
    form.qs.forEach((q, i) => {
      batch.set(refs.questionDoc(i), { order: i, text: q.text, choices: q.choices });
      batch.set(refs.keyDoc(i), { order: i, answerIndex: q.answer });
    });
    form.tableNames.forEach((name, i) => {
      batch.set(refs.tableDoc("t" + i), { name, claimedByUid: null, claimedAt: null });
    });
    await batch.commit();
  } catch (e) {
    $("setupMsg").textContent = "⚠️ 保存できませんでした：" + (e.code || e.message);
    return;
  }
  await upsertMyQuiz(EID, form.title);
  $("setupMsg").textContent = "✅ 受付を開始しました。";
}

// =============================================================================
// 2. リアルタイム購読
// =============================================================================
function subscribe() {
  fs.onSnapshot(refs.event, (snap) => {
    ev = snap.exists() ? snap.data() : null;
    eventLoaded = true;
    computeAccess();
    render();
  }, showReconnectBanner);
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
  await fs.updateDoc(refs.event, {
    phase: PHASE.QUESTION, currentIndex: next, revealIndex: null,
    questionStartedAt: fs.serverTimestamp(),
  });
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
let sidebarTitle = "";

function render() {
  // 権限のないクイズ → 専用画面
  if (accessDenied) {
    $("accessDenied").style.display = "block";
    $("setup").style.display = "none";
    $("control").style.display = "none";
    $("phasePill").textContent = "権限なし";
    if ($("roleBadge")) $("roleBadge").textContent = "";
    return;
  }
  $("accessDenied").style.display = "none";
  if ($("roleBadge")) $("roleBadge").textContent = amOwner ? "オーナー" : (amEditor ? "共同編集者" : "");
  renderSharePanel();
  maybeInitForm(); // 保存済み/下書き/空 を判断して作問フォームを初期化

  // 自分のクイズ一覧（履歴）にタイトルを反映
  if (ev && ev.title && ev.title !== sidebarTitle) {
    sidebarTitle = ev.title;
    upsertMyQuiz(EID, ev.title);
  }
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
