// =============================================================================
// Firebase 設定ファイル
// -----------------------------------------------------------------------------
// Firebase コンソール → プロジェクト設定 → 「マイアプリ」の firebaseConfig。
// apiKey は Web では公開前提の識別子なので、貼って共有しても問題ありません。
// =============================================================================
window.firebaseConfig = {
  apiKey: "AIzaSyCHJxHISWyqulKjfE3aduNpXhy60Jge4oA",
  authDomain: "quiz-event-d.firebaseapp.com",
  projectId: "quiz-event-d",
  storageBucket: "quiz-event-d.firebasestorage.app",
  messagingSenderId: "784802362228",
  appId: "1:784802362228:web:072e04321966cb2a45f221",
  measurementId: "G-2ZTKRN67CR",
};

// 1イベント運用のための固定ID（通常は変更不要）
window.EVENT_ID = "main";
