# Roadmap: X

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E5 で、`tid`・投稿の書き込み・outbox・Kinesis・Fanout Worker・Valkey の写し・`visible()`・ホームの読み出しを端から端まで貫き、2 人の利用者でフォローして投稿が届き、ブロックで消えるところまで作ってから、機能を広げる。`visible()` の 1 つの関数（[ADR-0004](decisions/0004-single-tenant-and-visibility.md)）、冪等の消費者（[ADR-0005](decisions/0005-event-log-and-outbox.md)）、写しの作り直し（[ADR-0003](decisions/0003-timeline-fanout-hybrid.md)）は、最初から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する。
  - E5 の前：fan-out の閾値と写しの形（`fanout-poc`。ソート済みの集合か詰めた列か、閾値 1 万での書き込みの量、瞬間のピークの均し）。
  - E6 の前：閲覧の数の取り込み（`view-count-poc`。Kinesis の費用、集計の誤差）。
  - E9 の前：日本語の検索（`search-poc`。kuromoji と N-gram、索引の大きさ、p99）。
- **規則は 1 つのコードに。** 見える範囲は `packages/visibility`、文字数は `packages/text`、ID は `packages/tid`、ランキングの段は `packages/ranking` にだけ書く。
- **契約を先に固定する。** 出来事の形（流れと鍵）、`tid` の形、`visible()` の決定表、公開 API の形は、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L10）。下の表で「法務：L*」と書いた Story が当たる。
- **1 変更 1 PR を目安に、差分を小さくする。** アプリは段階的に配布し、ランキングの変更は A/B で広げる。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI、Aurora と本人だけの表の RLS、`packages/tid`、outbox と Relay と Kinesis、フラグ、可観測性、監査ログ、大阪の骨格 | 設計中 |
| E2 アカウントとプロフィール | 登録、ログイン、セッション、プロフィール、ハンドル、鍵アカウント、Web とアプリの骨格 | 未着手（登録の年齢は法務：L5） |
| E3 投稿 | 書き込みの経路、文字数、返信・引用・リポスト、返信の制限、削除と後始末、`visible()` の骨格 | 未着手 |
| E4 フォローの関係 | フォロー・申請・承認・ブロック・ミュート、2 つの表、数の写し、上限 | 未着手 |
| E5 ホームのタイムライン | fan-out、プル、写しの作り直し、プロフィールの一覧、会話の表示 | 未着手（前に fan-out の PoC） |
| E6 エンゲージメントとカウンター | いいね・リポスト・ブックマーク、数の写しと照合、閲覧の数 | 未着手（前に閲覧の数の PoC） |
| E7 メディア | アップロード、画像・動画の変換、配信、センシティブの印、措置での配信の停止 | 未着手（著作権の申出は法務：L6） |
| E8 通知 | 通知の行、まとめ、既読、設定、プッシュ、メール | 未着手（プッシュの事業者は法務：L4） |
| E9 検索とトレンド | 日本語の全文検索、利用者の検索、ハッシュタグ、トレンド | 未着手（前に検索の PoC） |
| E10 おすすめ | パイプライン、候補の源、規則のスコア、固い絞り込み、混ぜ合わせ、代わりの並び、オフラインの評価と A/B | 未着手（履歴の利用は法務：L4） |
| E11 トラスト＆セーフティ | 通報、措置、作業の画面、スパムとボット、ハッシュの照合、異議、申出の窓口と期限、開示、法執行の窓口 | 未着手（法務：L1・L2・L7・L9） |
| E12 DM | 会話、メッセージ、既読、申請、Gateway、保存の暗号化 | 未着手（中身の解析は法務：L3） |
| E13 公開 API とレート制限 | OAuth、API、レート制限、計量 | 未着手 |
| E14 本番の準備と GA の判定 | 負荷試験、DR の訓練、見える範囲の監査、SLO とアラート、外部のペンテスト、データのライフサイクル、GA の判定 | 未着手（法務：L1・L8 ほか） |
| E15 みんなで作る注記（MVP の後） | 評価者の合意で付ける注記 | 未着手（MVP の後） |
| E16 リストとコミュニティ（MVP の後） | タイムラインの別の源 | 未着手（MVP の後） |
| E17 投稿の編集（MVP の後） | 版、引用・検索・通知への反映 | 未着手（MVP の後） |
| E18 DM の暗号化（MVP の後） | エンドツーエンドの暗号化、鍵の管理 | 未着手（MVP の後。法務：L3） |
| E19 学習済みのモデルのランキング（MVP の後、S2） | 学習の基盤、特徴の保存、モデルのランク、埋め込みの取り出し（S3） | 未着手（MVP の後） |
| E20 長文・購読・音声の配信・広告（MVP の後） | 収益と配信の拡張 | 未着手（MVP の後） |

E1〜E14 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。領域の文書を書く工程で、各領域の「Story の候補」から見直す。

### E1 基盤

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | X の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`packages/visibility`・`packages/tid`・`packages/ranking` はテックリード）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-network` | アカウント、SCP、VPC、VPC エンドポイント |
| `edge-and-waf` | CloudFront、WAF（Bot Control）、メディアの配信のドメイン |
| `ecs-services-skeleton` | サービスの骨格、Service Connect、タスクのロール |
| `terraform-root-modules` | ルートモジュールとポリシー検査 |
| `aurora-and-owner-rls` | Aurora、本人だけの表の RLS と検査（[ADR-0004](decisions/0004-single-tenant-and-visibility.md)） |
| `tid-generator` | `packages/tid`、生成器の貸し出し、リージョンの範囲、時計の監視（[ADR-0002](decisions/0002-post-ids-and-ordering.md)） |
| `outbox-relay-kinesis` | outbox の表、Relay、Kinesis の流れと鍵、消費者の位置（[ADR-0005](decisions/0005-event-log-and-outbox.md)） |
| `ci-pipeline-baseline` | PR の関門、テストの緩和の検出、本家の実装の依存の検査 |
| `flags-appconfig` | `release.*`・`ops.*`・`experiment.*` |
| `otel-baseline` | 計装、中身を出さない規則と走査 |
| `audit-log` | 監査ログ（運用者のアクセス、T&S の読み出しの理由） |
| `osaka-warm-standby` | 大阪の骨格、Global Database |

### E2 アカウントとプロフィール

| Story | 内容 |
| --- | --- |
| `auth-signup-login` | 電話番号・メールの OTP、パスキー、Google・Apple。法務：L5（年齢） |
| `sessions-and-devices` | セッション、端末の一覧、ログインの記録（保持は法務：L2） |
| `profile-and-handle` | プロフィール、ハンドルの規則と変更 |
| `protected-account` | 鍵アカウントの切り替え |
| `web-app-shell` | Web（React、PWA）の骨格 |
| `mobile-app-shell` | iOS・Android（React Native）の骨格、配布 |

### E3 投稿

| Story | 内容 |
| --- | --- |
| `text-weighted-count` | `packages/text`：重み付きの文字数、URL の 23、例の集まり（クライアントとサーバーで共有） |
| `post-write-path` | 投稿の検証と書き込み、`tid`、outbox |
| `visibility-core` | `packages/visibility` と決定表、`Visible<Post>` の型 |
| `replies-and-threads` | 返信、スレッド、会話の ID |
| `quote-and-repost` | 引用、リポスト |
| `reply-restrictions` | 返信できる人の制限 |
| `post-delete-cleanup` | 削除と後始末（写し、索引、メディア）。保持は法務：L8 |
| `short-links` | 短縮 URL（`<brand>.<short-tld>`）と、リンクの安全の確かめ |

### E4 フォローの関係

| Story | 内容 |
| --- | --- |
| `follow-tables` | `following`・`followers`、同じトランザクション、outbox（[ADR-0007](decisions/0007-follow-graph-storage.md)） |
| `follow-requests` | 鍵アカウントへの申請と承認 |
| `blocks-and-mutes` | ブロック、ミュート（アカウント、語）、閲覧者の集合の写し |
| `follow-counters` | フォロー・フォロワーの数の写しと照合 |
| `follow-limits` | フォローの上限、大量のフォロー・解除の検出 |
| `follow-lists` | 一覧のページング |

### E5 ホームのタイムライン

| Story | 内容 |
| --- | --- |
| `fanout-poc` | PoC：写しの形、閾値、書き込みの量、瞬間のピーク。E5 の前 |
| `fanout-worker` | 振り分け役、フォロワーのページ、SQS、アクティブな利用者だけへの書き込み |
| `author-recent-cache` | 作者の最近の投稿、プルの作者の一覧 |
| `home-following-read` | 写しとプルの合わせ、`visible()`、ページング、新着の窓 |
| `timeline-rebuild` | 作り直し、single flight |
| `timeline-cleanup` | 削除・解除・ブロックの後始末、新しいフォローの補充 |
| `profile-timeline` | プロフィールの投稿の一覧 |
| `conversation-view` | 会話の表示、返信の並べ方 |
| `fanout-synthetic-monitor` | 合成監視の組（プッシュ・プルの作者、監視用のフォロワー） |

### E6 エンゲージメントとカウンター

| Story | 内容 |
| --- | --- |
| `view-count-poc` | PoC：閲覧の取り込みの費用と誤差。E6 の前 |
| `likes-reposts-bookmarks` | 関係の表と書き込み |
| `counter-aggregator` | 数の写し、シャードの位置と同じ `MULTI` |
| `counter-writeback-reconcile` | 書き戻しと照合のジョブ |
| `view-ingest` | Ingest、閲覧の流れ、集計、減らない表示 |

### E7 メディア

| Story | 内容 |
| --- | --- |
| `media-upload` | 分割のアップロード、`tid` |
| `image-processing` | 画像の変換、代替のテキスト |
| `video-transcode` | MediaConvert、HLS |
| `media-delivery-and-takedown` | 配信のドメイン、CDN、措置での停止（60 秒） |
| `sensitive-media` | センシティブの印と設定。法務：L5 |

### E8 通知

| Story | 内容 |
| --- | --- |
| `notification-rows` | 出来事から通知の行、まとめ、既読 |
| `push-delivery` | APNs・FCM。法務：L4 |
| `email-delivery` | メールの送信 |
| `notification-settings` | 設定、品質のフィルター |

### E9 検索とトレンド

| Story | 内容 |
| --- | --- |
| `search-poc` | PoC：日本語の索引、大きさ、p99。E9 の前 |
| `search-indexer` | 索引の更新、粗い絞り込みの印 |
| `post-search` | 投稿の検索、返す前の `visible()` |
| `user-search` | 利用者の検索 |
| `trends` | 窓ごとの数、急上昇の検出、スパムと措置の除外 |

### E10 おすすめ

| Story | 内容 |
| --- | --- |
| `ranking-pipeline` | `packages/ranking` の段の口、時間の予算、代わりの並び |
| `candidate-sources-s1` | フォロー中、フォロー中の人の行動、話題、2 歩先 |
| `heuristic-scorer` | 手で決めた式、AppConfig の重み |
| `ranking-guardrails` | 固い絞り込みとガードレールの指標 |
| `ranking-offline-eval` | データレイクでの再生の評価と CI |
| `ranking-ab` | A/B の割り当てと集計 |
| `ranking-reasons` | 理由の記録と表示。法務：L4 |

### E11 トラスト＆セーフティ

| Story | 内容 |
| --- | --- |
| `moderation-actions` | 措置の記録と効かせ方、取り消し、利用者への通知 |
| `reports-intake` | 通報の受け付けと優先度 |
| `moderation-console` | 作業の画面と待ち行列、読み出しの理由の記録 |
| `spam-rules` | 行動の規則、登録の時の確認、分類の結果の取り込み |
| `media-hash-matching` | 有害なメディアのハッシュの照合 |
| `appeals` | 異議の申立て |
| `legal-takedown-intake` | 削除の申出の窓口と期限の管理。法務：L1 |
| `disclosure-requests` | 発信者情報の開示の請求への対応、保全。法務：L2 |
| `law-enforcement-portal` | 法執行の窓口。法務：L7 |
| `transparency-report` | 運用の状況の公表と報告の集計。法務：L1 |

### E12 DM

| Story | 内容 |
| --- | --- |
| `dm-conversations` | 会話、参加者、RLS |
| `dm-messages` | メッセージ、`tid`、既読 |
| `dm-requests-and-blocks` | 申請、ブロックとの関係 |
| `realtime-gateway` | WebSocket、配信 |
| `dm-media` | DM のメディア。照合は法務：L3 |

### E13 公開 API とレート制限

| Story | 内容 |
| --- | --- |
| `oauth-apps` | OAuth 2.0（PKCE）、アプリ、トークンの形（`<brand>_`） |
| `public-api-v1` | 投稿・利用者・タイムライン・検索・DM の API |
| `rate-limits` | 利用者・アプリ・IP の桶、ヘッダー |
| `usage-metering` | 使った量の計量 |

### E14 本番の準備と GA の判定

| Story | 内容 |
| --- | --- |
| `load-tests` | 投稿・読み出し・fan-out・閲覧・瞬間のピーク |
| `fault-injection` | Valkey・Kinesis・Aurora・Fanout Worker |
| `dr-drill` | DR の訓練（[quality.md](quality.md) の 2.4 節） |
| `visibility-audit` | 見える範囲の抜き取りの監査 |
| `slo-dashboards-alerts` | SLI、ダッシュボード、アラート、runbook の URL の検査 |
| `runbooks-e14` | [runbooks/README.md](runbooks/README.md) の 4 節の手順がそろっていることの確かめ |
| `data-lifecycle` | 保持のジョブ、アカウントの削除。法務：L8 |
| `external-pentest` | 外部のペンテスト |
| `ga-readiness-review` | GA の判定（[quality.md](quality.md) の 5 節の E14 の行） |

### E15〜E20（MVP の後）

Story は、着手するときに `intent.md` から起票する。

## エージェントに任せないこと

- **契約（出来事の形、`tid` の形、`visible()` の決定表、公開 API の形）の確定**：配った後や、ログに書いた後に変えるコストが最も高い。
- **fan-out の閾値、ランキングのガードレールの閾値の変更**：値は Dev と QA が決める。
- **ランキングの変更を 100% に広げる判断**：PM が A/B の結果で決める。
- **T&S の個別の措置の判断と、法令の申出への回答**：人が判断する。エージェントは整理と草案まで。
- **DR の切り替えの判断**：IC と Ops の責任者。
- **法務の判断**（L1〜L10）。

## 延期の一覧

MVP の後に検討する。E15〜E20 に入れなかったもの。

- 分散型の SNS のプロトコルとの連合（[intent.md](intent.md) の Non-goals）。
- 海外の利用者向けの拡大（多言語、海外のリージョン）。S3 で検討する。
- S2 の構成（Aurora の機能ごとの分割と鍵での分割）と S3 の構成（写しの記憶の階層、東京と大阪の両方での読み出し）。infrastructure の領域で計画する。
