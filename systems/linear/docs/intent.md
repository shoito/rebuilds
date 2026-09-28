# Intent: Linear を AI エージェント主体で再構築する

- Author: shoito
- Status: draft
- Date: 2026-09-28

## Problem

ソフトウェアのチームは、イシュー・スプリント・プロジェクトを課題管理のツールで回す。多くのツールで、次のことが仕事の流れを止めている。

- 画面の操作のたびにサーバーを待つ。状態の変更や並べ替えに数百ミリ秒かかり、まとめて整理する気が起きない。
- マウス中心で、キーボードだけで素早く操作できない。
- 回線が切れると何もできない。移動中や不安定な回線で、作業が止まる。
- 他の人の変更が、再読み込みするまで見えない。

本家 Linear は、この問題を「ローカルファースト」の同期エンジンで解いている。クライアントがワークスペースのデータを手元に持ち、操作はまず手元で反映し、後からサーバーの順序で確定する（[Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine)、2023-06-29）。この同期エンジンを中心に、小さなチームと AI エージェントでどこまで作り直せるかを確かめる。

## Proposed outcome

ソフトウェアのチームが、キーボードだけで、待たずに、課題を管理できるツールを作り直す。次の 3 つの価値を満たす。

1. **待たない**：ローカルの操作は、入力から描画まで p99 50ms 以内（NFR-001）。サーバーの応答を待たない。
2. **全員が同じものを見る**：他の人の変更は、1 秒以内に全員の画面に届く（NFR-002）。切断・オフライン・同時の編集の後も、全クライアントがサーバーと同じ状態に収束する（NFR-005）。
3. **失わない**：オフラインで行った変更は、再起動をまたいでも失わず、つながったときに 1 回だけ反映する（NFR-004）。

### MVP（S1）に含める

- **ワークスペースとチーム**：ワークスペースを契約とデータの単位にする。チームごとにワークフロー・サイクル・識別子の接頭辞（`ENG-123` の `ENG`）を持つ。公開のチームと非公開のチーム
- **イシュー**：
  - ワークフローの状態。種類は本家と同じく Triage・Backlog・Unstarted・Started・Completed・Canceled（と、システムが使う Duplicate）
  - 優先度（なし・Low・Medium・High・Urgent）、ラベル（グループを含む）、見積もり（指数・フィボナッチ・線形・T シャツ）、担当者、期日
  - 親子（サブイシュー）、関連（blocks・related・duplicate）、自動で閉じる・自動でアーカイブする規則
  - 本文の同時編集（リッチテキスト）、添付ファイル
- **サイクル**：1〜8 週、クールダウン、未完了のイシューの次のサイクルへの繰り越し、先の最大 15 サイクル（本家と同じ）
- **プロジェクトとイニシアチブ**：プロジェクト（状態、リーダー、期日、マイルストーン、進捗の更新）、プロジェクトを束ねるイニシアチブ
- **ビューとフィルター**：条件の組み合わせでの絞り込み、グループ化と並べ方、一覧とボード、保存したビュー（個人・チーム・ワークスペース）
- **コメントと通知**：コメント（スレッド、メンション、リアクション）、購読、インボックス、メール・デスクトップの通知
- **キーボード中心の画面**：すべての主要な操作にショートカット、コマンドメニュー、手元での即時の反映
- **オフライン**：Web とデスクトップ（Electron）で、読める・書ける。つながったら送る
- **リアルタイムの同期**：複数のタブ・端末・利用者の間で、変更を即座に反映する
- **検索**：イシュー・プロジェクト・コメントの全文検索（日本語を含む）
- **連携**：
  - GitHub・GitLab：ブランチ名・PR（MR）のタイトル・本文の「閉じる語」でイシューと結び、PR の状態でイシューの状態を進める
  - Slack：チャンネルへの通知、個人への通知、メッセージからイシューを作る
- **公開 API と Webhook**：GraphQL の公開 API（API キーと OAuth 2.0）、Webhook（署名付き、再試行つき）
- **インポート**：Jira、GitHub Issues、Asana、Shortcut、CSV から、イシュー・ラベル・利用者の対応付けを取り込む。CSV への書き出し

### MVP の後の Epic で扱う

| 機能 | 理由 |
| --- | --- |
| ロードマップの表示、インサイト（集計・ダッシュボード） | 同期したデータの上の読み出しの機能。同期エンジンが安定してから足す |
| トリアージの自動化（ルール、振り分けの提案） | MVP は Triage の状態と手動の振り分けだけにする。自動化は規則のエンジンが要る |
| AI の機能（要約、重複の検出、振り分けの提案、エージェントへの委任、MCP のサーバー） | データを外部のモデルへ送る扱い（法務の L6）と、評価の仕組みが要る |
| 顧客の要望（Customer requests）、SLA | 外部の窓口（サポートのツール）との連携と、期限の計算が要る |
| モバイルのアプリ（iOS・Android） | ローカルの保存と同期のクライアントを、ネイティブかクロスプラットフォームで別に作る必要がある。MVP は Web と Electron に絞る |
| ゲスト、サブチーム（入れ子のチーム）、チームをまたぐ共有 | 権限の組み合わせが増える。同期グループの設計（ADR-0003・0004）の上に足す |
| SAML・SCIM、監査ログ、細かな管理の設定 | 大口の要件。E4 の認証と E12 の監査の上に足す |
| ドキュメント（プロジェクト・チームの文書）、Linear Asks に相当する外部からの受付、リリースの管理 | MVP の後に、需要を見て扱う |
| 海外のリージョン | S3。本家と同じく、ワークスペースをリージョンに固定する形で足す（[How we built multi-region support for Linear](https://linear.app/now/how-we-built-multi-region-support-for-linear)、2024-05-23） |

### 守るべき振る舞い

- あるワークスペースの利用者は、他のワークスペースのデータを一切見られない。
- 非公開のチームのイシュー・コメント・添付は、そのチームのメンバー以外のクライアントへ、差分・ブートストラップ・検索・通知・Webhook・API のどの経路でも届かない。
- クライアントが outbox に書いたトランザクションは、再起動・長いオフライン・クライアントの更新をまたいでも失われない。サーバーでは 1 回だけ効く。
- すべてのクライアントは、変更が止んだ後、サーバーの状態と同じ状態に収束する。
- サーバーが拒否した変更（権限がない、削除されたものへの変更）は、送ったクライアントの画面から取り消され、理由が本人に示される。
- 他の人の変更を上書きしたときは、上書きした事実が履歴に残る。

### 成功の基準

| # | 基準 | 目標 | 測り方 |
| --- | --- | --- | --- |
| K1 | ローカルの操作の速さ | 入力から描画まで p99 50ms 以内（NFR-001） | 実ユーザーの計測（RUM）と、CI のベンチマーク（基準の端末、イシュー 50 万件のワークスペース） |
| K2 | 同期の伝播 | 確定から他のオンラインのクライアントへの反映 p99 1 秒以内（NFR-002） | 合成監視の 2 つのクライアントと、確定と適用の時刻の計測 |
| K3 | 起動の速さ | 2 回目以降の起動で操作できるまで p95 1.5 秒以内。大きなワークスペース（イシュー 50 万件）の初回でも p95 10 秒以内（NFR-003） | RUM |
| K4 | オフラインの耐久性 | outbox に入った変更の喪失 0 件。7 日のオフラインの後も送れる（NFR-004） | 性質ベーステスト、オフラインの耐久試験、本番の outbox の監視 |
| K5 | 収束 | 本番の抜き取りの検査（クライアントとサーバーのモデルのハッシュの突き合わせ）で、説明のつかない不一致 0 件（NFR-005） | 収束の監査 |
| K6 | 可用性 | 書き込みの経路（トランザクションの受け付け）と差分の配信が、月間 99.9%（NFR-006） | 合成監視と 5xx の割合 |
| K7 | テナントと非公開チームの分離 | 権限のないデータがクライアントへ届いた事象 0 件（NFR-008） | 性質ベーステスト、本番の配信の監査 |
| K8 | 移行のしやすさ | Jira のプロジェクト（イシュー 1 万件）の取り込みが 30 分以内に終わり、対応付けの誤り 0 件 | E11 の受け入れ試験 |

## Affected users and systems

- **ソフトウェアのチーム**（主な利用者）：開発者、PM、デザイナー、エンジニアリングのマネージャー。日本のスタートアップと、ソフトウェアの開発部門を持つ中堅の事業者を最初の対象にする。日本語の画面、日本語の検索、日本語の入力（IME）を前提にする。
- **ワークスペースの管理者**：チーム・メンバー・連携・請求を設定する人。
- **外部のシステム**：GitHub（github.com）、GitLab（gitlab.com と、公開された自前のホスト）、Slack、インポートの元（Jira、Asana、Shortcut、GitHub Issues）、メールの送信事業者、公開 API と Webhook の利用者。
- **社内の運用**：サポート、障害の対応、データの復元の依頼への対応。

## Constraints

- **同期エンジンを自前で設計する。** 本家の SDK やコードを核に使わない。第三者の汎用の部品（IndexedDB のラッパー、反応型のストア、CRDT のライブラリ）は、理由を ADR に書いて使ってよい（[リポジトリ共通の ADR-0007](../../../docs/decisions/0007-no-reuse-of-original-implementation.md)、[ADR-0001](decisions/0001-platform-and-stack.md)）。
- 実行基盤と技術は、rebuilds の他の題材の決定（AWS 東京・大阪、TypeScript、Aurora PostgreSQL 18、Valkey、Terraform、OpenTelemetry）を引き継ぐ（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- クライアントは、TypeScript の SPA（Web）と、それを包む Electron のデスクトップのアプリ。ローカルの保存は IndexedDB（[ADR-0005](decisions/0005-client-persistence-and-offline.md)）。
- 本家の名前は識別子に使わない。ドメインは `<brand>.<domain>`、Webhook の署名のヘッダーは `<Brand>-Signature` の形で書く（[リポジトリ共通の ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家の API・SDK とそのまま互換にすることは目標にしない。
- データは日本（東京、DR は大阪）に置く。
- 日本の法令（個人情報保護法、電気通信事業法）への対応は、法務の確認を前提に設計する。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の「規模の段階」）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| 自前のホスト（オンプレミス）での提供 | 運用の形が別になる。本家も提供していない（未検証） |
| 本家の GraphQL の API・SDK・Webhook との完全な互換 | 形は寄せるが、名前と識別子は独自にする（リポジトリ共通の ADR-0006） |
| P2P での同期、サーバーなしの共同編集 | サーバーの順序で決める設計（[ADR-0002](decisions/0002-sync-model.md)）と合わない |
| 汎用のプロジェクト管理（ガントチャートの依存の計算、工数の実績、請求の管理） | ソフトウェアのチームの課題管理に絞る |
| 汎用のチャット | 議論はコメントと Slack の連携で扱う |

## Open questions

### 法務の確認待ち

設計はどの結論にも対応できる形にするが、結論は出さない。**下の表の「承認を止める spec」は、確認が済むまで PM・QA が承認しない。**

| # | 問い | 関係する設計 | 承認を止める spec |
| --- | --- | --- | --- |
| L1 | 個人情報保護法：ワークスペースのデータ（イシューの本文、コメント、利用者の名前・メールアドレス）を、顧客からの委託として扱うか。外国にある第三者への提供（GitHub・GitLab・Slack の連携、メールの送信事業者）の扱いと、本人への情報の提供。漏えい等の報告の義務を負う者と手順 | integrations、notifications-and-inbox、security の各領域 | E9 のメールの送信、E10 の GitHub・GitLab・Slack の連携 |
| L2 | 電気通信事業法：コメント・メンション・通知で利用者の間の意思の伝達を媒介することが、届出の要る電気通信事業に当たるか。Web の画面で分析のために端末の情報を外部へ送る場合の外部送信規律の公表 | notifications-and-inbox、client-app の各領域 | E5 のコメント、E9 の通知の公開 |
| L3 | インポート：顧客の資格情報で他社のツール（Jira、Asana、Shortcut、GitHub）から取り込むことが、それぞれの利用規約・API の規約に反しないか。取り込んだ個人データ（他社のツールの利用者の名前・メールアドレス）の扱い | import-export の領域 | E11 のインポート |
| L4 | データの所在：「日本のデータを国外に出さない」をどこまで約束するか。バックアップ、DR（大阪は国内）、サポートでの参照、サブプロセッサー、Electron の自動更新の配信、デスクトップの通知の扱い | infrastructure の領域 | E1 のリージョンの構成、E12 の契約の文書 |
| L5 | 保持の期間：同期のログ（sync action）、イシューの履歴、削除・アーカイブしたデータ、解約したワークスペースのデータ、クライアントの端末に残るデータを、何日持つか | sync-engine、security の各領域、[ADR-0003](decisions/0003-bootstrap-and-partial-sync.md) | E2 の同期のログの保持、E12 の GA の判定 |
| L6 | AI の機能（MVP の後）：イシューのデータを外部のモデルの提供者へ送ることの同意、学習への利用の禁止の契約、出力の責任 | MVP の後の AI の Epic | AI の Epic の着手 |
| L7 | 顧客との契約：委託の契約（DPA）の雛形、サブプロセッサーの一覧と変更の通知、SLA の文言、利用者からの開示・削除の請求の窓口 | security の領域 | E12 の GA の判定 |
| L8 | 画面の見た目とショートカットを本家に寄せる範囲：不正競争防止法（商品等表示、商品の形態の模倣）と著作権の観点で、どこまで似せてよいか | client-app の領域 | E6 の画面の Story |

### 選定・計測で決めるもの（法務以外）

- 本文の同時編集の CRDT の部品（Yjs を第一の候補にする）：E5 の着手前に、editor-and-descriptions の領域で決める。→ 2026-09-28 に Yjs と y-prosemirror に決めた（[ADR-0021](decisions/0021-description-crdt-yjs-in-sync-log.md)）。
- 日本語の全文検索の方式（PostgreSQL の `pg_bigm` か、OpenSearch か）：E8 の着手前に決める。Aurora PostgreSQL 18 で `pg_bigm` が使えるかは未検証。→ 2026-09-28 に S1 から OpenSearch に決めた（[ADR-0030](decisions/0030-search-engine-opensearch.md)）。費用は E8 の PoC で確かめる。
- 反応型のストアを MobX にするか、自前の細かな購読にするか：E2 の PoC で、イシュー 50 万件の描画の速さとメモリーを計測して決める（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- 全体のブートストラップと部分のブートストラップを切り替える閾値：E3 の PoC で計測して決める（[ADR-0003](decisions/0003-bootstrap-and-partial-sync.md)）。
- 本家の可用性の SLA の値：未検証。Enterprise の契約の条件として公開の資料で確かめられなかった。
- 本家のオフラインの振る舞いの詳細：本家の文書は、オフラインを「完全な機能ではなく、失敗への備え」と説明し、オフラインでの多くの編集は他の人の変更を上書きしうると書いている（[Download Linear](https://linear.app/docs/get-the-app)、2026-09-28 に確認）。本システムはこれより強い保証（上書きの記録、7 日のオフライン）を目標にする。

## 出典

いずれも 2026-09-28 に確認。

- Linear, [Pricing](https://linear.app/pricing)：プランの構成（Free はチーム 2・イシュー 250、非公開のチームは Business 以上、SAML・SCIM・監査ログは Enterprise）。「40,000 社以上」が使っているという記載
- Linear Docs, [Configuring workflows](https://linear.app/docs/configuring-workflows)、[Cycles](https://linear.app/docs/use-cycles)、[Estimates](https://linear.app/docs/estimates)、[Priority](https://linear.app/docs/priority)、[Private teams](https://linear.app/docs/private-teams)
- Linear Docs, [GitHub](https://linear.app/docs/github)、[GitLab](https://linear.app/docs/gitlab)、[Slack](https://linear.app/docs/slack)、[Import issues](https://linear.app/docs/import-issues)
- Linear Developers, [GraphQL](https://linear.app/developers/graphql)、[Webhooks](https://linear.app/developers/webhooks)、[Rate limiting](https://linear.app/developers/rate-limiting)
- Linear, [Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine)（Tuomas Artman の講演、2023-06-29）
- Linear, [How we built multi-region support for Linear](https://linear.app/now/how-we-built-multi-region-support-for-linear)（2024-05-23）
- 第三者の解析：[wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine)、[Reverse engineering Linear's sync magic](https://marknotfound.com/posts/reverse-engineering-linears-sync-magic/)（2022-12-20）
