# Plan: チャンネルの画面（E1、リアルタイムなし）

- Change: 260926-web-channel-view
- Spec: [spec.md](spec.md)
- Quality: [quality.md](quality.md)
- Status: approved

## 依存

| 依存先 | 必要なもの | 揃っていないとき |
| --- | --- | --- |
| [260926-post-and-list-messages](../260926-post-and-list-messages/plan.md) | 投稿・履歴の API、`packages/api-client`、seed、`scripts/lib/decision-table.ts` | 着手できない |
| 260926 の契約の追加（spec の Open questions） | メッセージの応答の `client_msg_id`・`created_at`・投稿者の `member_id` | 順序 5 以降の重複の除去（PROP-WEB-010 の `client_msg_id` の部分）と REQ-WEB-037 を止める。契約の変更は Dev の承認が要る |
| [260926-web-app-shell-routing](../260926-web-app-shell-routing/plan.md) | チャンネルの枠、API の呼び出し口と DT-WEB-003、「見つかりません」の画面、クエリのキー、フラグの受け取り、i18n・a11y の土台 | 着手できない |
| `message-body-ast-v1` | `BodySchema`、`parsePlainText`、`isBlankBody`、`countBodyChars`、`packages/ui` の `MessageBody` | 順序 6（入力欄）と 8（描画）を止める |
| `feature-flags-appconfig` | `packages/flags` への `release.web_channel_view` の定義（`client: true`）、テストでの上書き（REQ-FLAG-010 の `FLAGS_OVERRIDE`） | フラグの定義ができるまでマージしない（AGENTS.md「未完成の振る舞いは release フラグの裏に置く」）。ブートストラップの API は骨格の変更が作る |
| `ci-pipeline`、骨格の変更 | `ci-gate`、フラグの両方の状態でのテスト（`test:flags`）。Vitest の browser mode・Playwright・axe の CI の段は骨格の変更が足す | 手元の確認ループだけで進め、マージは CI の段ができてから |

## Release flags

| フラグ | 種類 | 既定値 | 無効のとき | 段階 |
| --- | --- | --- | --- | --- |
| `release.web_channel_view` | release | 無効 | チャンネルの枠に「準備中」を出し、メッセージの API を呼ばない | 開発用・社内のワークスペース → E1 の完了で 100%（本番の利用者は E1 ではいない前提）。100% の 2 週間後に削除のタスク（順序 13） |

## Files that change

パスは `systems/slack/` からの相対パス。

- `apps/web/src/features/channel/timeline-store.ts`（新規）：窓・併合・上限・確定待ちの整理（DT-WEB-011、DT-WEB-012、REQ-WEB-032）。React に依存しない
- `apps/web/src/features/channel/use-timeline.ts`（新規）：`useSyncExternalStore` と TanStack Query の `queryFn` の接続、取り直しのきっかけ（REQ-WEB-026）
- `apps/web/src/features/channel/MessageList.tsx`、`MessageRow.tsx`（新規）：TanStack Virtual、スクロールの位置の保持（DT-WEB-013）、`role="feed"`
- `apps/web/src/features/channel/scroll-anchor.ts`（新規）：先頭の行の `seq` と位置を覚えて戻す
- `apps/web/src/features/channel/ChannelView.tsx`、`ChannelStates.tsx`（新規）：空・失敗・「準備中」・「チャンネルの始まり」・「最新へ移動」（REQ-WEB-022、REQ-WEB-025、REQ-WEB-035、REQ-WEB-036、DT-WEB-015）
- `apps/web/src/features/channel/MessageBodyCell.tsx`（新規）：`packages/ui` の `MessageBody` に、表示名を引く関数とチャンネル名を引く関数（骨格のチャンネル一覧）を渡す（REQ-WEB-033）。再読み込みの案内（REQ-WEB-034）
- `apps/web/src/features/composer/Composer.tsx`（新規）：`<textarea>` と DT-WEB-014
- `apps/web/src/features/composer/send-queue.ts`（新規）：チャンネルごとの列と DT-WEB-010 の純関数、`Retry-After` の解釈
- `apps/web/src/features/composer/uuidv7.ts`（新規。`packages/` に既存の実装があればそれを使う）
- `apps/web/src/i18n/messages/{ja,en}/channel.json`（新規）
- `apps/web/src/app/routes/channel.tsx`（変更）：枠の中身を `ChannelView` にし、`release.web_channel_view` で分ける
- `apps/web/eslint.config.js`（変更）：`innerHTML`・`outerHTML`・`insertAdjacentHTML`・`new Function` の禁止、メッセージのクエリへの `setQueryData` をストアの外で禁止
- `apps/web/test/timeline-store.test.ts`、`send-queue.test.ts`（新規）：単体・表駆動
- `apps/web/test/timeline.property.test.ts`、`send-queue.property.test.ts`（新規）：性質ベース
- `apps/web/test/support/fake-messages-server.ts`（新規）：性質ベーステスト用のサーバーのモデル（[quality.md](quality.md) の 2 節）
- `apps/web/test/browser/{message-list,composer}.test.tsx`（新規）：Vitest の browser mode
- `apps/web/e2e/channel-view.spec.ts`（新規）：実 API での E2E
- `packages/db/seed.ts`（変更）：`seq` 1〜120 のチャンネル、0 件のチャンネル、1,200 件のチャンネル、`v: 2` の本文を持つ行（REQ-WEB-034 の E2E 用。seed で直接入れる）
- `packages/flags/`（変更。`feature-flags-appconfig` の後）：`release.web_channel_view` の定義

## Order of work

- [ ] 1. Timeline ストアの窓と併合、上限（REQ-WEB-020、REQ-WEB-021、REQ-WEB-022、REQ-WEB-025、REQ-WEB-026、DT-WEB-011、DT-WEB-012、PROP-WEB-011）
- [ ] 2. サーバーのモデルと、窓の性質ベーステスト（PROP-WEB-010、PROP-WEB-011）
- [ ] 3. 送信の列と状態遷移（REQ-WEB-029、REQ-WEB-030、REQ-WEB-031、DT-WEB-010、PROP-WEB-012、PROP-WEB-014）
- [ ] 4. 楽観表示と重複の除去（REQ-WEB-028、REQ-WEB-032、PROP-WEB-013）
- [ ] 5. 送信と取得を混ぜた性質ベーステスト（PROP-WEB-010〜013 をまとめたモデルで）
- [ ] 6. 入力欄（REQ-WEB-027、DT-WEB-014）※ `message-body-ast-v1` の後
- [ ] 7. 仮想化した一覧とスクロールの位置（REQ-WEB-023、REQ-WEB-024、DT-WEB-013、PROP-WEB-015）
- [ ] 8. 本文の描画を `MessageBody` につなぐ、再読み込みの案内（REQ-WEB-033、REQ-WEB-034）※ `message-body-ast-v1` の後
- [ ] 9. 投稿者と時刻（REQ-WEB-037）
- [ ] 10. 空・失敗の表示（REQ-WEB-035、REQ-WEB-036、DT-WEB-015）
- [ ] 11. a11y（REQ-WEB-038）と文言の ja・en
- [ ] 12. `release.web_channel_view` の裏に置き、E2E を両方の状態で回す
- [ ] 13. （100% にして 2 週間後）`release.web_channel_view` をコードから消す

1〜5 は React に依存しないので、骨格の変更と並行して進められる。

## Risks

- **窓のつながりの判定**：`seq` の連続（`+1`）で判定すると、E3 で履歴に出ない `seq`（編集・スレッドの返信）が入ったときに誤って「つながらない」と判定し、窓を置き換え続ける。DT-WEB-011 は重なりと `has_more` で判定する。
- **タブの復帰での置き換え**：過去を読んでいる間に最新ページで窓を置き換えると、読んでいる位置が飛ぶ。DT-WEB-011 の 4 行目で捨てる。
- **確定待ちの表示の揺れ**：`POST` の応答で確定したメッセージを窓へ直接入れると、他の人の投稿の分の欠けを作る（PROP-WEB-011 に反する）。確定待ちとして末尾に残し、最新ページの併合で置き換える。取り直しが続けて失敗すると、確定待ちが長く残る。
- **応答に `client_msg_id` がない場合**：応答を失った送信と、取り直したページの同じメッセージが一時的に二重に見える。PROP-WEB-010 はこの前提に依存する（spec の Open questions）。
- **スクロールの位置**：行の高さを描画後に測るため、画像やフォントの読み込みで高さが変わると位置がずれる。E1 は画像を出さないが、Web フォントの読み込みの差でずれうる。Vitest の browser mode で 3 エンジンを回す。Safari の実機との差は 未検証。
- **IME**：`keyCode` 229 と `isComposing` の扱いがブラウザで違う。Playwright で IME の変換を完全には再現できない（未検証）。合成したイベントでの部品テストと、リリース前の手動確認（macOS の日本語入力、Safari・Chrome・Firefox）で補う。
- **再読み込みでの喪失**：未送信のメッセージはメモリだけにあり、再読み込みで失われる。E4 までの既知の制限として、spec の概要に明記した。
- **フラグが無効な状態**：チャンネルの枠が「準備中」になり、骨格の「最後に開いた」の記憶（DT-WEB-002）が更新されない。骨格の転送が壊れないことを Proof で確かめる。

## Proof

「Vitest（browser）」は Vitest の browser mode（Playwright のプロバイダ、Chromium・Firefox・WebKit）を指す。表駆動テストは `spec.md` の表を `scripts/lib/decision-table.ts` で読み込み、テスト名に `DT-WEB-01N #行` を含める。性質ベーステストの生成器・試行回数・合否は [quality.md](quality.md) にある。

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| 最新ページの表示と最下部、キャッシュからの復帰 | REQ-WEB-020 | Playwright（seed の 120 件）。Vitest（browser）：戻ったときの即時表示と取り直し |
| 前のページの読み込み、同時に 1 つ | REQ-WEB-021 | Vitest（browser）：偽の API で要求の回数と `before_seq` を数える |
| チャンネルの始まり | REQ-WEB-022 | Playwright |
| 仮想化 | REQ-WEB-023 | Vitest（browser）：1,000 件で任意の位置の `article` の数が 150 以下 |
| スクロールの位置の保持と追従 | REQ-WEB-024 | Vitest（browser）：3 つのシナリオ、3 エンジン |
| 前に足しても位置が保たれる | PROP-WEB-015 | fast-check ＋ Vitest（browser）：行の高さと件数を生成（Chromium で 50 回、Firefox・WebKit で 20 回） |
| スクロールの動作 | DT-WEB-013 | Vitest（browser）：表駆動（6 行） |
| 窓の上限と「最新へ移動」 | REQ-WEB-025 | Vitest：ストアの単体。Playwright（seed の 1,200 件） |
| 窓の上限の規則 | DT-WEB-012 | Vitest：表駆動（3 行） |
| 取り直しと併合、つながらないときの置き換え | REQ-WEB-026 | Vitest：ストアの単体。Playwright：別のブラウザコンテキストで投稿し、`visibilitychange` の後に出る |
| 併合の規則 | DT-WEB-011 | Vitest：表駆動（7 行） |
| 窓はサーバーの列の区間と一致 | PROP-WEB-011 | fast-check：サーバーのモデルとストアに任意の操作の列を与え、各時点で比べる |
| 一覧は `seq` 順で重複がない | PROP-WEB-010 | fast-check：取得・送信・応答の喪失・順序の入れ替わりを交互に混ぜた列で、各時点の描画の順（ストアの選択関数の出力）を検査 |
| 入力欄（Enter、IME、空白、上限） | REQ-WEB-027 | Vitest（browser）：`compositionstart`・`isComposing`・`keyCode` 229 を合成。送られる AST と UUIDv7 の形を検査。リリース前の手動確認（IME） |
| キー操作の規則 | DT-WEB-014 | Vitest（browser）：表駆動（5 行） |
| 送信中の表示と並び | REQ-WEB-028 | Vitest（browser）、Playwright（応答を `page.route` で遅らせる） |
| 未確定は確定の後ろ | PROP-WEB-013 | fast-check（PROP-WEB-010 と同じモデル） |
| 送信の直列化 | REQ-WEB-029 | Vitest：送信の列の単体（偽の時刻と偽の API） |
| 自動の再試行と `Retry-After` | REQ-WEB-030 | Vitest：偽のタイマー。Playwright：`page.route` で 429 と `Retry-After: 2` を返し、再送が 2 秒以上後で、サーバーに 1 件だけ保存される |
| 送った順に 1 件ずつ投稿される | PROP-WEB-012 | fast-check：送信の列と、REQ-MSG-002 の冪等性を持つサーバーのモデルで。結合の確認として Playwright：応答をタイムアウトさせて再送し、DB に 1 件 |
| `Retry-After` を守る | PROP-WEB-014 | fast-check ＋ 偽のタイマー：429 の値を 0〜120 秒で生成 |
| 送信の結果の規則 | DT-WEB-010 | Vitest：表駆動（8 行） |
| 失敗・未送信と、編集・破棄・再送 | REQ-WEB-031 | Vitest（browser）。Playwright：404 は別のコンテキストでチャンネルから外す（seed の操作）か `page.route` で |
| 重複の除去 | REQ-WEB-032 | Vitest：ストアの単体（2 つのシナリオ） |
| 本文の描画（`MessageBody` だけを使う、チャンネル名の引き方） | REQ-WEB-033 | Vitest（browser）：シナリオの本文を一覧に入れて DOM を検査。lint が CI で通る（禁止の API、`apps/web` での本文の独自の描画）。部品そのものの安全は message-body-ast-v1 の PROP-MSG-005 で証明する |
| 再読み込みの案内 | REQ-WEB-034 | Vitest（browser）。Playwright（seed の `v: 2` の行） |
| 空の状態 | REQ-WEB-035 | Playwright（seed の 0 件のチャンネル） |
| 履歴の取得の失敗 | REQ-WEB-036 | Playwright：権限のないチャンネルの画面を、骨格の PROP-WEB-001 のテストと同じ比較にかける。Vitest（browser）：前のページの失敗 |
| 失敗の表示の規則 | DT-WEB-015 | Vitest（browser）：表駆動（6 行） |
| 投稿者と時刻 | REQ-WEB-037 | Vitest（browser）：ja・en の時刻の書式、表示名がないときの代わりの表示 |
| 一覧のアクセシビリティ | REQ-WEB-038 | `@axe-core/playwright`：3 つの状態 × ja・en で違反 0 件。`role="feed"`・`aria-busy`・`aria-setsize` の検査 |
| フラグが無効なら API を呼ばず「準備中」、骨格の転送は壊れない | ADR-0026（無効な状態） | Playwright：`release.web_channel_view` の両方の状態で主要シナリオを回す。無効のときメッセージの API への要求が 0 件 |
| チャンネルの切り替えの性能 | client.md の 11 節 | Playwright の計測（Chromium）：キャッシュなし p75 500ms、キャッシュあり 100ms。E1 では記録だけにし、失敗の条件にしない |
| すべての ID がテストから参照されている | — | ID の追跡の検査が CI で通る |
| 未送信があるときだけ離脱の確認が出る | REQ-WEB-039 | Playwright（`page.on('dialog')` で確かめる） |
