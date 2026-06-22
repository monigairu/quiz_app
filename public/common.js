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
export const EVENT_ID = window.EVENT_ID || "main";
export const OWNER_EMAIL = (window.OWNER_EMAIL || "").trim().toLowerCase();

// ---- 設定未投入の検知 -------------------------------------------------------
export const configReady =
  window.firebaseConfig && window.firebaseConfig.apiKey &&
  window.firebaseConfig.apiKey !== "PASTE_HERE";

let app, auth, db;
if (configReady) {
  app = initializeApp(window.firebaseConfig);
  auth = getAuth(app);
  db = FS.getFirestore(app);
}
export { auth, db };

// ---- Firestore 参照（データ構造の定義）-------------------------------------
//   events/{EVENT_ID}                … イベント本体（phase, currentIndex 等）
//   events/{EVENT_ID}/questions/q{n} … 問題文・選択肢（公開）
//   events/{EVENT_ID}/keys/q{n}      … 正解インデックス（採点用）
//   events/{EVENT_ID}/tables/t{n}    … テーブル定義＋ロック状態
//   events/{EVENT_ID}/answers/{tableId}_{qIndex} … 回答（重複防止のため決定的ID）
export const refs = configReady ? {
  event: FS.doc(db, "events", EVENT_ID),
  questions: FS.collection(db, "events", EVENT_ID, "questions"),
  keys: FS.collection(db, "events", EVENT_ID, "keys"),
  tables: FS.collection(db, "events", EVENT_ID, "tables"),
  answers: FS.collection(db, "events", EVENT_ID, "answers"),
  questionDoc: (i) => FS.doc(db, "events", EVENT_ID, "questions", "q" + i),
  keyDoc: (i) => FS.doc(db, "events", EVENT_ID, "keys", "q" + i),
  tableDoc: (id) => FS.doc(db, "events", EVENT_ID, "tables", id),
  answerDoc: (tableId, i) => FS.doc(db, "events", EVENT_ID, "answers", tableId + "_" + i),
  metaAdmins: FS.doc(db, "meta", "admins"), // 共同作成者の許可リスト
} : null;

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

// 共同作成者の許可リスト（Firestore: meta/admins.emails）を購読
export function watchAdmins(cb) {
  return FS.onSnapshot(refs.metaAdmins, (snap) => {
    const emails = (snap.exists() && Array.isArray(snap.data().emails)) ? snap.data().emails : [];
    cb(emails.map((e) => String(e).trim().toLowerCase()));
  }, () => cb([]));
}

// このメールが管理者（オーナー or 共同作成者）か判定
export function isAdminEmail(email, coAdminEmails) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  if (OWNER_EMAIL && e === OWNER_EMAIL) return true;
  return (coAdminEmails || []).includes(e);
}

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
