# 懇親会 テーブル対抗 クイズアプリ 🎉（Firebase版）

懇親会で、テーブル（グループ）対抗のクイズ大会ができるリアルタイムWebアプリです。
主催者がホスト画面で進行を操作すると、各テーブルの代表者のスマホに次の問題や結果が
**即時に同期表示**されます。サーバ不要（Firebase Hosting + Firestore）で動きます。

## 確定要件

- **利用者**：主催者1名＋各グループ代表者（最大10〜15名）／全体100名規模
- **流れ**：① 主催者が作問・保存 → ② 共通リンク（QR）で代表者が参加し一覧から
  自分のテーブルを選択（先着でロック・重複参加を防止）→ ③ 主催者の操作で全員同期して
  進行（締切は手動）→ ④ 最後に総合順位を発表
- **識別**：参加者は匿名ログイン（個人情報なし）。主催者は枠を解放して交代も可能
- **作問権限**：主催者の作問・進行は **Google ログイン必須**。許可した Google アカウント
  （作成者＋共同作成者）のみ作業ワークスペースに入れる。共同作成者はホスト画面で追加
- **得点**：開始時に「正解数のみ」か「正解＋早押し順で加点」を選択
- **問題**：選択肢2〜4個・正解1つ
- **各問後**：代表者には正誤のみ表示、順位は最後にまとめて
- **基盤**：Firebase（無料 Spark プラン）

## 画面構成

| 画面 | URL | 用途 |
|------|-----|------|
| 参加者（代表者） | `/` | テーブルを選んで参加・回答 |
| 主催者 | `/host` | 作問・進行操作・採点・テーブル管理 |
| 会場表示 | `/display` | プロジェクタ投影用の大画面表示 |

## セットアップ（初回・約5分）

### 1. Firebase プロジェクトを作成
[console.firebase.google.com](https://console.firebase.google.com) で
「プロジェクトを追加」（Google アナリティクスはオフでOK）。

### 2. ウェブアプリを登録して設定を取得
プロジェクト画面の `</>`（ウェブ）アイコンからアプリを登録すると
`firebaseConfig` が表示されます。その6項目を **`public/firebase-config.js`** に貼り付け。

### 3. Firestore Database を作成
左メニュー「Firestore Database」→「データベースを作成」→ **テストモードで開始**、
ロケーションは `asia-northeast1（東京）`。

### 4. ログイン方法を2つ有効化
左メニュー「Authentication」→「Sign-in method」で、以下の **両方** を有効化：
- **匿名（Anonymous）**：参加者（代表者）用
- **Google**：主催者（作問・進行）用

### 5. オーナー（作成者）の Google アカウントを設定
作問できるルートのオーナーを、次の2か所に **同じ小文字メール** で設定します：
- `public/admins.js` の `window.OWNER_EMAIL`
- `firestore.rules` の `ownerEmail()`

共同作成者は、オーナーがホスト画面の「管理者設定」から Google メールで追加できます
（Firestore の `meta/admins` に保存。コード変更・再デプロイ不要）。

## 起動・公開

### ローカルで試す
```bash
npx firebase emulators:start --only hosting   # http://localhost:5000
```
（または `public/` を任意の静的サーバで配信。例：`npx serve public`）

### 本番公開（Firebase Hosting・無料）
```bash
npx firebase login
# .firebaserc の "YOUR_PROJECT_ID" を実際のプロジェクトIDに変更
npx firebase deploy --only hosting
```
公開URL（例 `https://<project-id>.web.app/`）の QR コードを配れば、参加者は
スマホで読み取って参加できます。

## 当日の進め方

1. 主催者が `/host` を開く（会場スクリーンには `/display` を投影）。
2. **作問**：タイトル・採点方式・テーブル名（1行に1つ）・問題を入力 →「保存して受付を開始」。
3. 代表者は公開URL（QR）にアクセスし、一覧から**自分のテーブルを選択**（先着ロック）。
4. 主催者が「▶ クイズを開始 / 次の問題」→ 全員に問題表示。
5. 代表者が回答 → 主催者が「⏱ 締切＆採点」→ 各代表者に**正誤のみ**表示。
6. 全問終えたら「🏆 最終結果を発表」→ テーブル別の総合順位を全画面表示。

- 代表者の交代：主催者画面の「解放」でそのテーブルの枠を空け、別の人が選び直せます。
- やり直し：「⟲ 得点リセット」で回答を消去し受付状態へ。「← 作問に戻る」で問題を編集。

## 採点ルール

- **正解数のみ**：1問正解 = 100点。
- **正解＋早押し**：正解 = 100点 ＋ 早押しボーナス（1位 +50 / 2位 +40 … 0まで）。
  回答の到達時刻（サーバ時刻）で順位付け。
- 総合順位は各テーブルの合計点で決定。

## データ構造（Firestore）

```
events/{EVENT_ID}                 イベント本体（phase, currentIndex, scoringMode, standings…）
events/{EVENT_ID}/questions/q{n}  問題文・選択肢（公開）
events/{EVENT_ID}/keys/q{n}       正解インデックス（採点用・参加者には未公開）
events/{EVENT_ID}/tables/t{n}     テーブル定義＋ロック状態（claimedByUid）
events/{EVENT_ID}/answers/{tableId}_{qIndex}  回答（決定的IDで重複防止）
meta/admins                       共同作成者の許可リスト { emails: [...] }
```
`EVENT_ID` は `public/firebase-config.js` の `window.EVENT_ID`（既定 `"main"`）。

## セキュリティ

- `apiKey` は Web では公開前提の識別子です（秘密鍵ではありません）。
- **作業ワークスペースの保護は2段構え**：
  1. UIゲート … 許可Googleアカウント以外はホスト画面に入れない
  2. Firestoreルール … 許可アカウント以外は問題・進行を書き込めない／正解(keys)も読めない
- 当日前に **テストモードを卒業**し、同梱の `firestore.rules` をデプロイしてください
  （`ownerEmail()` を実メールに設定後）：
  ```bash
  npx firebase deploy --only firestore:rules
  ```
  ※ デプロイするまではテストモード（誰でも読み書き可）のままなので、サーバ側の
  　 権限チェックは効きません。本番前に必ずデプロイしてください。

## 技術構成

- 静的サイト（HTML / CSS / Vanilla JS, ES Modules）
- Firebase JS SDK v10（CDN）：Firestore（リアルタイム同期）＋ Anonymous Auth
- ビルド不要・サーバ不要
