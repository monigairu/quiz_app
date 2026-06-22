// =============================================================================
// 共通モジュール：Firebase 初期化・参照・採点ロジック・ユーティリティ
// =============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import * as FS from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const fs = FS; // Firestore の各関数をまとめて再エクスポート

// ---- ルームコード（クイズごとのURL）---------------------------------------
// 参加/表示は URL の ?r=CODE で対象イベントを決める。
export const urlEventId = new URLSearchParams(location.search).get("r");
export function genEventCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい 0/O/1/I を除外
  let s = "";
  for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

// ---- 設定未投入の検知 -------------------------------------------------------
export const configReady =
  window.firebaseConfig && window.firebaseConfig.apiKey &&
  window.firebaseConfig.apiKey !== "PASTE_HERE";

let app, auth, db;
if (configReady) {
  app = initializeApp(window.firebaseConfig);
  auth = getAuth(app);
  // 社内ネットワーク/プロキシがストリーミングを塞ぐ環境でもリアルタイム更新が
  // 届くよう、ロングポーリングを自動検出して使う。
  db = FS.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
}
export { auth, db };

// 接続が不安定なときに気づけるバナー（更新が止まったら再読み込みを促す）
let bannerShown = false;
export function showReconnectBanner() {
  if (bannerShown || !document.body) return;
  bannerShown = true;
  const d = document.createElement("div");
  d.id = "reconnectBanner";
  d.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:10000;background:#ef4444;color:#fff;" +
    "padding:10px 14px;text-align:center;font-weight:700;font-family:sans-serif";
  d.innerHTML = '⚠️ 接続が不安定です ' +
    '<button onclick="location.reload()" style="margin-left:8px;width:auto;padding:6px 12px;' +
    'border:none;border-radius:8px;background:#fff;color:#ef4444;font-weight:800;cursor:pointer">再読み込み</button>';
  document.body.appendChild(d);
}

// ---- Firestore 参照（データ構造の定義）-------------------------------------
//   events/{code}                … イベント本体（phase, currentIndex 等）
//   events/{code}/questions/q{n} … 問題文・選択肢（公開）
//   events/{code}/keys/q{n}      … 正解インデックス（採点用）
//   events/{code}/tables/t{n}    … テーブル定義＋ロック状態
//   events/{code}/answers/{tableId}_{qIndex} … 回答（重複防止のため決定的ID）
//   meta/admins                  … 管理者リスト（イベント横断・グローバル）
export const metaAdmins = configReady ? FS.doc(db, "meta", "admins") : null;

export function buildRefs(eventId) {
  if (!configReady || !eventId) return null;
  return {
    eventId,
    event: FS.doc(db, "events", eventId),
    questions: FS.collection(db, "events", eventId, "questions"),
    keys: FS.collection(db, "events", eventId, "keys"),
    tables: FS.collection(db, "events", eventId, "tables"),
    answers: FS.collection(db, "events", eventId, "answers"),
    questionDoc: (i) => FS.doc(db, "events", eventId, "questions", "q" + i),
    keyDoc: (i) => FS.doc(db, "events", eventId, "keys", "q" + i),
    tableDoc: (id) => FS.doc(db, "events", eventId, "tables", id),
    answerDoc: (tableId, i) => FS.doc(db, "events", eventId, "answers", tableId + "_" + i),
  };
}

// ---- 認証：参加者（匿名ログイン）-------------------------------------------
export function ensureAuth() {
  return new Promise((resolve, reject) => {
    if (!configReady) return reject(new Error("Firebase 未設定"));
    onAuthStateChanged(auth, (user) => { if (user) resolve(user); });
    signInAnonymously(auth).catch(reject);
  });
}

// ---- 認証：主催者（Google ログイン）---------------------------------------
export function watchAuth(cb) { return onAuthStateChanged(auth, cb); }

export function googleSignIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return signInWithPopup(auth, provider);
}

export function signOutHost() { return signOut(auth); }

// 管理者リスト（Firestore: meta/admins）を購読。
// セキュリティルールにより「リストに載っている管理者だけ」が読み取れるため、
// onData が呼ばれた＝自分は管理者、onError（権限なし/未作成）＝管理者ではない、を意味する。
export function watchAdmins(onData, onError) {
  return FS.onSnapshot(metaAdmins,
    (snap) => {
      const d = snap.exists() ? snap.data() : {};
      const emails = Array.isArray(d.emails) ? d.emails.map((e) => String(e).trim().toLowerCase()) : [];
      onData({ exists: snap.exists(), emails, owner: (d.owner || "").toLowerCase() });
    },
    (err) => onError && onError(err));
}

export const normEmail = (e) => String(e || "").trim().toLowerCase();

// ---- 採点ロジック ----------------------------------------------------------
// scoringMode: 'correct'（正解数のみ）/ 'speed'（正解＋早押し順で加点）
export const SCORE = { BASE: 100, SPEED_MAX: 50, SPEED_STEP: 10 };

// 1問ぶんの採点。correctEntries は { tableId, answeredAt(ms) } の配列（正解者のみ）。
// 戻り値: Map<tableId, points>
export function gradeQuestion(scoringMode, correctEntries) {
  const points = new Map();
  if (scoringMode === "speed") {
    const sorted = [...correctEntries].sort((a, b) => a.answeredAt - b.answeredAt);
    sorted.forEach((e, rank) => {
      const bonus = Math.max(SCORE.SPEED_MAX - rank * SCORE.SPEED_STEP, 0);
      points.set(e.tableId, SCORE.BASE + bonus);
    });
  } else {
    for (const e of correctEntries) points.set(e.tableId, SCORE.BASE);
  }
  return points;
}

// ---- フェーズ定義 ----------------------------------------------------------
export const PHASE = {
  SETUP: "setup",       // 主催者が作問中
  LOBBY: "lobby",       // 受付（テーブル選択）
  QUESTION: "question", // 出題中
  REVEAL: "reveal",     // 締切・正誤表示（順位は隠す）
  FINISHED: "finished", // 最終結果発表
};

export const phaseLabel = {
  setup: "準備中", lobby: "受付中", question: "出題中",
  reveal: "正誤確認", finished: "結果発表",
};

// ---- ユーティリティ --------------------------------------------------------
export const $ = (id) => document.getElementById(id);

export function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

export function ms(ts) {
  // Firestore Timestamp -> ミリ秒（未確定なら Infinity 扱い）
  return ts && typeof ts.toMillis === "function" ? ts.toMillis() : Number.MAX_SAFE_INTEGER;
}

// 設定未投入なら全画面に警告を出す
export function guardConfig() {
  if (configReady) return true;
  document.body.innerHTML =
    '<div style="max-width:560px;margin:60px auto;padding:24px;font-family:sans-serif;' +
    'background:#1e293b;color:#f1f5f9;border-radius:16px;line-height:1.7">' +
    '<h2>⚠️ Firebase が未設定です</h2>' +
    '<p><code>public/firebase-config.js</code> に Firebase コンソールで取得した ' +
    '<code>firebaseConfig</code> を貼り付けてください。</p></div>';
  return false;
}
