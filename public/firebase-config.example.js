// =============================================================================
// テンプレート：このファイルを public/firebase-config.js としてコピーし、
// Firebase コンソールで取得した firebaseConfig の値を入れてください。
//   cp public/firebase-config.example.js public/firebase-config.js
//
// public/firebase-config.js は .gitignore 済みで GitHub には push されません。
// （apiKey は Web では公開前提の識別子ですが、リポジトリには載せない方針です）
// =============================================================================
window.firebaseConfig = {
  apiKey: "PASTE_HERE",
  authDomain: "PASTE_HERE",
  projectId: "PASTE_HERE",
  storageBucket: "PASTE_HERE",
  messagingSenderId: "PASTE_HERE",
  appId: "PASTE_HERE",
};

// 1イベント運用のための固定ID（通常は変更不要）
window.EVENT_ID = "main";
