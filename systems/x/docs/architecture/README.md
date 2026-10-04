# Architecture: X

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。ファイルの一覧、持ち主、ADR の番号の範囲は 7 節にある（領域の文書は、まだない）。品質の戦略は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md) にある。

## 1. 全体構成

### 1.1 コンテキスト

```
 利用者（iOS・Android のアプリ、Web のブラウザ。主にスマートフォン）
      │ 投稿・タイムライン・検索・通知・DM（HTTPS）、DM と通知の数の受信（WebSocket）、閲覧の出来事の送信
      ▼
┌──────────── 本システム（<brand>.<domain>、api.<brand>.<domain>、短縮 URL <brand>.<short-tld>）────────────┐
│  投稿、フォロー、タイムライン、おすすめ、カウンター、検索とトレンド、通知、メディア、DM、T&S、公開 API     │
└──────────────────────────────────────────────────────────────────────────────────────┘
      ▲ OAuth 2.0・公開 API                 │ 外向き                          ▲ 申出・命令・照会
      │                                     ▼                                 │
 開発者のアプリ・ボット・研究者        APNs・FCM（プッシュ通知）              申出をする人（Web の窓口）
                                      メール・SMS の送信事業者                裁判所・捜査機関
                                      有害なメディアのハッシュの照合          総務省（運用の状況の報告）
 モデレーター・T&S の担当者 ──（社内の作業の画面。別の入口）──▶
```

### 1.2 コンテナ

```
 ┌──────────── CloudFront＋WAF（Bot Control、静的な資産、メディアの配信 <brand>media.<domain>）────────────┐
 └──────┬───────────────────────┬──────────────────────┬────────────────────────┬─────────────────┘
        ▼                       ▼                      ▼                        ▼
 ┌──────────────┐      ┌───────────────┐     ┌────────────────┐      ┌──────────────────┐
 │ App API（BFF）│      │ Public API     │     │ Realtime Gateway│      │ Ingest（閲覧の出来事）│
 │ 画面向けの読み │      │ OAuth・レート制限│     │ WebSocket：DM、  │      │ 束ねて受け、失って   │
 │ 書きの入口     │      │ ・計量           │     │ 通知の数         │      │ よい扱い             │
 └──┬───────────┘      └──────┬────────┘     └───────┬────────┘      └────────┬─────────┘
    │ 同じ内部のサービスを呼ぶ    │                        │                          │
    ▼                            ▼                        ▼                          ▼
 ┌────────────────── 内部のサービス（ECS Fargate、Service Connect）──────────────────────┐
 │ Post（書き込み・tid）  Graph（フォロー・ブロック・ミュート）  Engagement（いいね・リポスト）    │
 │ Timeline（フォロー中の読み出し・プルの合わせ）  Ranking（おすすめ：候補→特徴→スコア→絞り→混ぜ）  │
 │ Search  Notification  Media  DM  Accounts  T&S（通報・措置・申出・開示）                      │
 │ すべての読み出しが packages/visibility の visible(viewer, post) を通る                     │
 └──────┬───────────────────────────────┬──────────────────────────────────────────┘
        ▼                               ▼
 Aurora PostgreSQL（正本：利用者、投稿、フォロー、       Valkey（写し：ホームのタイムライン、作者の最近の投稿、
 いいね・リポスト、通知、DM、措置、outbox）             カウンター、特徴、レート制限の桶、セッション）
        │ outbox                                        ▲
        ▼                                               │
     Relay ──▶ Kinesis Data Streams（出来事のログ：投稿・フォロー・エンゲージメント・措置・閲覧）
                     │
                     ├─▶ Fanout Worker ──（SQS で分割した配り先の束）──▶ Valkey のホームのタイムライン
                     ├─▶ Counter Aggregator ──▶ Valkey のカウンター ──（定期の書き戻し）──▶ Aurora
                     ├─▶ Search Indexer ──▶ OpenSearch（投稿・利用者）、Trends（窓ごとの数）
                     ├─▶ Notification Worker ──▶ 通知の行、APNs・FCM・メール
                     ├─▶ T&S Worker（スパムの規則・分類、ハッシュの照合）
                     └─▶ Firehose ──▶ S3（データレイク：分析、ランキングの学習と評価）

 S3：メディア（原本と変換の後）、データレイク、監査ログの保管      MediaConvert：動画の変換（HLS）
```

| コンテナ | 責務 |
| --- | --- |
| App API | 画面（アプリと Web）向けの入口。セッションを確かめ、内部のサービスを束ねて返す |
| Public API | 開発者向けの入口。OAuth 2.0、アプリと利用者ごとのレート制限、使った量の計量 |
| Realtime Gateway | WebSocket を終端し、DM のメッセージと通知の数を届ける。Slack の題材の Gateway の考え方を先例にする |
| Ingest | クライアントの閲覧の出来事を束ねて受け、Kinesis の閲覧の流れへ入れる。Aurora を通さない（[ADR-0005](../decisions/0005-event-log-and-outbox.md)） |
| Post | 投稿の検証（文字数、メディア、返信の制限）、`tid` の採番、投稿の行と outbox の書き込み（[ADR-0002](../decisions/0002-post-ids-and-ordering.md)） |
| Graph | フォロー・申請・ブロック・ミュートの書き込みと読み出し。2 つの向きの隣接の表（[ADR-0007](../decisions/0007-follow-graph-storage.md)） |
| Timeline | フォロー中のタイムラインの読み出し。写しにプルの作者の最近の投稿を合わせ、見える範囲で絞る。写しがなければ作り直す（[ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)） |
| Fanout Worker | 投稿の出来事を受け、フォロワーをページに分けて、アクティブなフォロワーのタイムラインの写しへ書く（[ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)） |
| Ranking | おすすめ。候補の取り出し、特徴の付加、スコア、固い絞り込み、混ぜ合わせ。スコアの部品が落ちたら時刻の順に戻す（[ADR-0006](../decisions/0006-ranking-boundary.md)） |
| Engagement・Counter Aggregator | いいね・リポスト・ブックマークの関係の書き込みと、数の写しの集計・照合（[ADR-0005](../decisions/0005-event-log-and-outbox.md)） |
| Search・Trends | 日本語の全文検索の索引と問い合わせ、トレンドの窓ごとの数と急上昇の検出 |
| Notification | 出来事から通知の行を作り、まとめ、プッシュ・メールで送る |
| Media | 分割のアップロード、画像の変換、動画の変換の依頼、配信の URL、措置での配信の停止 |
| DM | 会話とメッセージ、既読、申請、Gateway への配信 |
| Accounts | 登録、ログイン、セッション、OAuth のアプリ、ログインの記録（開示に使う） |
| T&S | 通報、スパムの規則、措置、異議の申立て、法令の申出の窓口と期限、開示の請求、作業の画面 |
| Aurora | 唯一の正本。テナントはなく 1 つ（[ADR-0004](../decisions/0004-single-tenant-and-visibility.md)） |
| Valkey | 写しと短い状態。失われても正本から作り直せる |
| Kinesis Data Streams | 確定した出来事のログ。複数の消費者が独立に読み、再生できる（[ADR-0005](../decisions/0005-event-log-and-outbox.md)） |

原則は 6 つ。

- **正本は Aurora、速さは写しで出す。** タイムライン・カウンター・特徴は Valkey の写しで、正本から作り直せる。写しにしかない状態を作らない（[ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)、[ADR-0005](../decisions/0005-event-log-and-outbox.md)）。
- **書くときに配り、多すぎるものは読むときに集める。** フォロワーの少ない作者はプッシュ、多い作者はプルにする（[ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)）。
- **ID が時刻の順を運ぶ。** 投稿・利用者・DM のメッセージは 64 ビットの `tid` で、ID の大小が作られた時刻の順になる。タイムラインの合わせ、ページング、索引の範囲をこれで行う（[ADR-0002](../decisions/0002-post-ids-and-ordering.md)）。
- **見える範囲は読む時に 1 か所で決める。** 全経路が `visible(viewer, post)` を通る。fan-out の時の判断に頼らない（[ADR-0004](../decisions/0004-single-tenant-and-visibility.md)）。
- **確定したものは outbox から出来事のログへ。** DB と出来事が食い違わない。消費者は冪等（[ADR-0005](../decisions/0005-event-log-and-outbox.md)）。
- **ML は並べる順だけ。** 安全と法令の判定を、モデルのスコアで上書きしない（[ADR-0006](../decisions/0006-ranking-boundary.md)）。

### 1.3 本家の形（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 投稿の文字数 | 重み付きで 280。日本語・中国語・韓国語の文字は 2、URL は 23 と数える | [Counting characters](https://docs.x.com/fundamentals/counting-characters)（公式） |
| ID | 64 ビット。41 ビットのミリ秒の時刻（独自の起点）、10 ビットの機械の番号、12 ビットの連番。調整なしで振り、おおむね時刻の順（k-sorted）。時計が戻ったら振らない | [snowflake（2010 年の版）](https://github.com/twitter-archive/snowflake/tree/snowflake-2010)（公式のリポジトリ。今の実装は未検証） |
| ホームのタイムライン | 書くときにフォロワーのメモリーの中のタイムラインへ配り、フォロワーの多い作者は読むときに合わせる | 2012 年の講演 [Timelines at Scale](https://www.infoq.com/presentations/Twitter-Timeline-Scalability)（本家の技術者の講演。具体の数値は本文で確かめておらず**未検証**） |
| おすすめ | 候補の源（フォロー中の投稿の索引、関係のグラフの辿り、埋め込みの近さ）→ 軽いランク → 重いランク（ニューラルネットワーク）→ 見える範囲の絞り込み → 混ぜ合わせ。フォロー中とそれ以外は平均で半々 | [twitter/the-algorithm](https://github.com/twitter/the-algorithm)（公式の README、2023 年） |
| おすすめ（今） | Home Mixer が全体を回し、Thunder がフォロー中の最近の投稿をメモリーに持ち、Phoenix（transformer）が取り出しとランクを行う。行動ごとの確率を重みで足し、作者の偏りを減らし、フォロー外を割り引く | [xai-org/x-algorithm](https://github.com/xai-org/x-algorithm)（公式の README） |
| 表示の数 | ログインした人が投稿を見た回数。同じ人の複数回も数え、本人の閲覧も数える。一意ではない | [View counts](https://help.x.com/en/using-x/view-counts)（検索結果の抜粋で確認。本文は 403 で未確認） |
| 利用者の上限 | 投稿 1 日 2,400 件、DM 1 日 500 件、フォロー 1 日 400 件。5,000 人をフォローした後は、フォロワーとの比で制限 | [About X limits](https://help.x.com/en/rules-and-policies/x-limits)、[About following on X](https://help.x.com/en/using-x/x-follow-limit)（同上） |
| 公開 API | 15 分か 24 時間の窓、アプリごとと利用者ごとの上限、`429`。使った量に応じた課金（投稿の読み出し 1 件 $0.005 など）、月 300 万件の読み出しの上限 | [Rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)、[Pricing](https://docs.x.com/x-api/getting-started/pricing)（公式） |
| メディア | 画像 5 MB、GIF 15 MB、動画は分割のアップロード（INIT・APPEND・FINALIZE）。上限はアカウントの種類で変わる | [Media upload](https://docs.x.com/x-api/media/introduction)（公式） |
| DM | 2025 年に、鍵を PIN で守る方式（Juicebox）のエンドツーエンドの暗号化を持つ「Chat」へ移った。過去の DM は暗号化されない | 第三者の報道（[TechCrunch, 2025-09-05](https://techcrunch.com/2025/09/05/x-is-now-offering-me-end-to-end-encrypted-chat-you-probably-shouldnt-trust-it-yet/)）。本家の文書は**未検証** |

いずれも 2026-10-04 に確認。本家のエンジニアリングのブログ（blog.x.com）とヘルプセンター（help.x.com）は、確認の時点で取得が 403 になった。そこにしかない数値は「未検証」とした。この設計は、上の考え方を参考にするが、本家のコード・設定・モデルを使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## 2. 規模の段階

| 段階 | 登録（MAU / DAU） | 投稿 / 日（ピーク / 瞬間） | タイムラインの読み出しのピーク | エンゲージメントのピーク | 閲覧の出来事 / 日 | フォローの辺 | 最大のフォロワー | 構成 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1（MVP） | 300 万（100 万 / 30 万） | 100 万（300 件/秒 / 3,000 件/秒） | 1 万件/秒 | 2,000 件/秒 | 5 億 | 6,000 万 | 100 万 | 東京の 1 リージョン・3 AZ。Aurora の 1 クラスタ（writer 1 台＋reader 2 台）、Valkey のクラスタ 1 つ、OpenSearch 1 ドメイン、Kinesis（オンデマンド）。大阪にウォームスタンバイ（Aurora Global Database） |
| S2 | 3,000 万（1,000 万 / 400 万） | 1,500 万（3,000 件/秒 / 3 万件/秒） | 10 万件/秒 | 2 万件/秒 | 80 億 | 15 億 | 1,000 万 | Aurora を機能ごとのクラスタ（投稿、関係、エンゲージメント、DM、アカウント）に分け、投稿と関係は鍵で分割する。Valkey のタイムラインを専用のクラスタへ。学習済みのモデルのランキング |
| S3 | 1 億（7,000 万 / 4,000 万） | 1 億（1.5 万件/秒 / 15 万件/秒） | 80 万件/秒 | 15 万件/秒 | 600 億 | 100 億 | 5,000 万 | 機能ごとの分割の数を増やす。タイムラインの写しを記憶の階層（Valkey と、安い保存）に分ける。埋め込みでの取り出し。東京と大阪の両方で読み出しを受ける |

- 数値は本システムの想定。S3 は、日本の利用者の大部分を受ける規模を置いた（本家の日本の月間 6,800 万人は二次資料で**未検証**。[intent.md](../intent.md)）。
- 「瞬間」は、年が変わる 0 時、テレビの番組の山場、地震の直後のような、数秒から数分の集中を指す。ピークの 10 倍とした。本家は、こうした集中で 1 秒あたりの投稿の記録を公表してきた（blog.x.com に到達できず**未検証**）。瞬間の投稿は、書き込み（Post）では受け、fan-out はキューで均す（NFR-002 の p99 30 秒の中に収める）。
- fan-out の書き込みの量は、投稿 1 件あたりの「プッシュするアクティブなフォロワー」の平均で決まる。S1 で平均 100 と置くと、1 日 1 億件、瞬間のピークで 30 万件/秒をキューで受けて均す。プルに回す作者の閾値（S1 の既定 1 万フォロワー）で上限を抑える（[ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)）。
- 段階を上げる判断の基準は infrastructure の領域、負荷のモデルは capacity の領域で決める。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 投稿の書き込み | 投稿の API の応答 p99 300ms（メディアの変換を除く）。確定を返した投稿を失わない | [ADR-0002](../decisions/0002-post-ids-and-ordering.md) |
| NFR-002 | fan-out の遅延 | 投稿の確定から、アクティブなフォロワーのホーム（フォロー中）の読み出しに出るまで p95 5 秒、p99 30 秒。プルの作者も同じ（読み出しで合わせる） | [ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)。瞬間のピークの間も p99 30 秒 |
| NFR-003 | タイムラインの読み出し | ホーム（フォロー中）の最初のページ（20 件）p99 300ms、続きのページ p99 300ms。おすすめの最初のページ p99 800ms。写しがない利用者（久しぶりの利用者）の作り直し p99 2 秒 | サーバーの計測。クライアントの描画を除く |
| NFR-004 | 可用性 | タイムラインの読み出し：月間 99.95%。投稿の書き込み、DM、通知、公開 API：月間 99.9%。おすすめが落ちたら、フォロー中の時刻の順で代わりに返し、可用性に数える | [ADR-0006](../decisions/0006-ranking-boundary.md) の代わりの並び |
| NFR-005 | 耐久性と障害 | 確定を返した投稿・DM・フォロー・措置を失わない。AZ の障害で RPO 0・RTO 5 分以内。リージョンの障害で RPO 1 分以内・RTO 1 時間以内。写し（タイムライン・カウンター）は作り直す | 作り直しの間は NFR-003 の作り直しの目標で返す |
| NFR-006 | カウンター | いいね・リポスト・フォロワーの数：確定から表示まで p95 5 秒。照合の後、写しと正本の差 0。表示の数：概算で、正本の集計との差 2% 以内、減らない | [ADR-0005](../decisions/0005-event-log-and-outbox.md) |
| NFR-007 | 検索とトレンド | 投稿から検索に出るまで p95 15 秒。検索の応答 p99 500ms。日本語の部分一致で取りこぼさない。トレンドの更新 5 分ごと | search-and-trends の領域 |
| NFR-008 | 通知と DM | 出来事から通知の行まで p95 5 秒、プッシュの送信まで p95 10 秒。DM の送信から、オンラインの相手の端末まで p95 1 秒 | notifications、direct-messages の領域 |
| NFR-009 | 見える範囲の分離 | ブロック・鍵アカウント・削除・措置の投稿、他人の DM が、見てはいけない人にどの経路でも見えた事象 0 件。削除・措置から全経路（写し、検索、通知、CDN のメディア）で見えなくなるまで p99 60 秒 | [ADR-0004](../decisions/0004-single-tenant-and-visibility.md) |
| NFR-010 | 法令の期限 | 削除の申出への判断と通知を期限（7 日。法務の L1 で確定）の中で行う割合 100%。命に関わる通報（自殺の予告、暴力の予告、児童の性的搾取）の初動 1 時間以内 | trust-and-safety の領域 |
| NFR-011 | スパムの抑止 | 抜き取りの人の評価で、ホームに出たスパムの割合 0.5% 以下。登録の後 24 時間以内に凍結したスパムのアカウントの割合を測り、週ごとに見る | trust-and-safety の領域 |
| NFR-012 | 公開 API | 1 件の読み出し p99 500ms。レート制限の判定の後で上限を超えて受け付けた要求 1% 以内 | api-and-rate-limits の領域 |
| NFR-013 | メディア | 画像のアップロードの完了から投稿に使えるまで p95 3 秒。1 分の動画の変換 p95 60 秒。配信の CDN のヒットの率 95% 以上 | media の領域 |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（サービス、Web、アプリ）。学習と評価だけ Python（オフライン） | 他の題材と同じ。学習の道具は Python が厚い。推論は ONNX の形で TypeScript のサービスに載せる（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0006](../decisions/0006-ranking-boundary.md)） |
| HTTP・検証 | Hono＋Zod | 他の題材と同じ |
| ID | 投稿・利用者・DM のメッセージは 64 ビットの `tid`（`packages/tid`）。その他は UUIDv7 | 共通の UUIDv7 から外れる。理由は [ADR-0002](../decisions/0002-post-ids-and-ordering.md) |
| DB | Aurora PostgreSQL 18。テナントの RLS はなく、本人だけが読む表（DM、ブックマーク、下書き、通知、設定）に FORCE RLS と `SET LOCAL app.actor_id` | [ADR-0004](../decisions/0004-single-tenant-and-visibility.md) |
| 写し | ElastiCache（Valkey）：ホームのタイムライン、作者の最近の投稿、カウンター、特徴、レート制限 | [ADR-0003](../decisions/0003-timeline-fanout-hybrid.md) |
| 出来事のログ | transactional outbox → Relay → Kinesis Data Streams。仕事の待ち行列は SQS | 共通の SQS・SNS に加えて Kinesis を使う。理由は [ADR-0005](../decisions/0005-event-log-and-outbox.md) |
| 検索 | Amazon OpenSearch Service（kuromoji と N-gram の組み合わせを第一の候補） | search-and-trends の領域で決める |
| ランキング | 自前のパイプライン（`packages/ranking`）。S1 は規則と軽いスコア、S2 から学習済みのモデル（ONNX Runtime）、S3 で埋め込みの取り出し | [ADR-0006](../decisions/0006-ranking-boundary.md) |
| メディア | S3、CloudFront、画像の変換は自前の Worker（`sharp`）、動画は AWS Elemental MediaConvert（HLS） | media の領域 |
| リアルタイム | WebSocket（Realtime Gateway）、Valkey の pub/sub | Slack の題材の考え方を先例にする |
| クライアント | Web は React（SPA、PWA）。iOS・Android は React Native（Expo） | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| データレイク | Kinesis Data Firehose → S3（Apache Iceberg の表）、Athena | 分析、学習、評価、法令の報告の集計 |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs、Managed Grafana | 他の題材と同じ |
| フラグ | AWS AppConfig（`release.*`・`ops.*`・`experiment.*`） | 他の題材と同じ。ランキングの A/B も同じ仕組み |
| 認証 | Better Auth（`packages/auth` で包む。電話番号・メールの OTP、パスキー、Google・Apple） | Linear の題材と同じ考え方。accounts-and-auth の領域で決める |
| テスト | Vitest、fast-check、Testcontainers、Playwright、Maestro（アプリの E2E）、k6 | quality.md の 2.2 節 |

## 5. 主な決定

どれも `accepted`（最初の設計の起票）。状態の一覧は [decisions/README.md](../decisions/README.md)。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、タイムライン・推薦・カウンター・検索の核を自前で作る。本家の公開のアルゴリズムのコードを使わない。アプリは React Native、学習だけ Python |
| [0002](../decisions/0002-post-ids-and-ordering.md) | 投稿・利用者・DM のメッセージに、41 ビットのミリ秒・10 ビットの生成器・12 ビットの連番の 64 ビットの `tid` を振る。生成器の番号は貸し出しで、リージョンごとに範囲を分ける |
| [0003](../decisions/0003-timeline-fanout-hybrid.md) | ホームのタイムラインは、フォロワーの少ない作者はプッシュ、多い作者はプルの組み合わせ。写しは Valkey に 800 件、アクティブなフォロワーにだけ配り、消えたら正本から作り直す |
| [0004](../decisions/0004-single-tenant-and-visibility.md) | テナントは 1 つで、テナントの RLS を置かない。本人だけの表に FORCE RLS をかけ、公開の表の見える範囲は 1 つの関数 `visible()` で読み出しの時に決める |
| [0005](../decisions/0005-event-log-and-outbox.md) | 確定した変更は outbox から Kinesis Data Streams の出来事のログへ流し、fan-out・カウンター・検索・通知・T&S が独立に読む。閲覧の数だけは Aurora を通さず、失ってよい流れで受ける |
| [0006](../decisions/0006-ranking-boundary.md) | おすすめは、候補の取り出し・特徴・スコア・固い絞り込み・混ぜ合わせの自前のパイプライン。ML はスコアと取り出しだけで、安全と法令の判定を上書きしない。S1 は規則と軽いスコアから始める |
| [0007](../decisions/0007-follow-graph-storage.md) | フォローの関係は、向きの違う 2 つの隣接の表（フォローする側・される側）を正本にし、同じトランザクションで書く。グラフ DB を使わない。S2 で利用者の ID で分割する |

領域ごとの ADR は、7 節の番号の範囲で起票する。リポジトリ共通の決定（開発プロセス、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、本家の実装を核に使わない規則の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **見える範囲の漏れ**：鍵アカウント・ブロック・削除・措置の投稿が、写し・検索・通知・API・メディアの URL・埋め込みのどれかの経路から見える。経路が多いのがこの題材の弱み。全経路を `visible()` に通し（[ADR-0004](../decisions/0004-single-tenant-and-visibility.md)）、漏れの経路の表（[quality.md](../quality.md) の 2.2.1 節）と本番の抜き取りの監査で確かめる。メディアは署名付きの URL ではなく公開の CDN で配るため、措置での配信の停止（CDN の無効化）を media の領域で設計する。
- **fan-out の爆発と遅れ**：フォロワーの多い作者の連投、瞬間のピーク、閾値の付近の作者で、キューが溜まり NFR-002 を外す。プルへの切り替え（[ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)）、アクティブなフォロワーだけに配る、キューの深さでの閾値の自動の引き下げで抑える。E5 の PoC で、閾値と Valkey の書き込みの量を測る。
- **写しの作り直しの殺到**：Valkey のノードを失う、大阪への切り替えで写しが空になると、全員の読み出しが作り直しになり Aurora に集中する。作り直しを利用者ごとに 1 回にまとめ（single flight）、作り直しの間は最近の投稿の範囲を狭めて返す。DR の訓練で、作り直しの速さを測る。
- **カウンターのずれ**：写しの集計の取りこぼし・二重の加算で、数が正本とずれる。照合のジョブで差を測り、正本で上書きする（[ADR-0005](../decisions/0005-event-log-and-outbox.md)）。閲覧の数は概算と明示する。
- **ランキングの暴走**：モデルや重みの変更で、特定の種類の投稿（煽り、スパム）が増える。オフラインの評価、A/B、ガードレールの指標（通報の率、ミュート・ブロックの率）で止める（[ADR-0006](../decisions/0006-ranking-boundary.md)）。
- **スパムとボット**：公開の登録と公開 API は、スパムとボットの入口になる。登録の時の電話番号の確認、レート制限、行動の規則、分類のモデル、WAF の Bot Control を重ねる。具体は trust-and-safety の領域で決める。
- **ID の衝突**：生成器の番号の貸し出しの誤りか、時計の戻りで同じ `tid` が出る。貸し出しの重なりを DB の制約で防ぎ、時計の戻りでは振らない（[ADR-0002](../decisions/0002-post-ids-and-ordering.md)）。投稿の表の主キーで重複を検出する。
- **大きな会話**：人気の投稿への数十万件の返信で、会話の表示と通知が重くなる。会話の読み出しは返信の上位だけをランクして返す。通知はまとめる。
- **法令**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」の L1〜L10）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

### 決定（2026-10-04、既定案）

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも E1〜E14 の PoC・試験で覆りうる。

- **テナント**：1 つ。RLS は本人だけの表に限る（[ADR-0004](../decisions/0004-single-tenant-and-visibility.md)）。
- **ID**：投稿・利用者・DM のメッセージは 64 ビットの `tid`。共通の UUIDv7 から外れる（[ADR-0002](../decisions/0002-post-ids-and-ordering.md)）。
- **fan-out**：プッシュとプルの組み合わせ。閾値の既定は 1 万フォロワー。写しは 800 件、アクティブ（30 日以内に読んだ）なフォロワーだけに配る（[ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)）。
- **出来事のログ**：Kinesis Data Streams（オンデマンド）。仕事の待ち行列は SQS（[ADR-0005](../decisions/0005-event-log-and-outbox.md)）。
- **ランキング**：S1 は規則と軽いスコア。学習済みのモデルは S2（[ADR-0006](../decisions/0006-ranking-boundary.md)）。
- **アプリ**：React Native（Expo）で iOS・Android を MVP に含める。日本の利用者の大半がスマートフォンで使うため（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **文字数**：本家と同じ重み付きの 280。数え方は公開の仕様から自前で実装し、`twitter-text` を使わない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **DM の暗号化**：MVP はサーバーの側の保存の暗号化（KMS）だけ。エンドツーエンドの暗号化は MVP の後（法務の L3 とあわせて決める）。
- **レート制限のヘッダー**：本家の `x-rate-limit-*` の形でなく、IETF の `RateLimit`・`RateLimit-Policy` の形を第一の候補にする。api-and-rate-limits の領域で確定する。

持ち越し（法務、計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L10） | [intent.md](../intent.md) の「法務の確認待ち」。結論まで、そこに挙げた Story の spec を承認しない |
| fan-out の閾値、アクティブの定義、写しの件数 | E5 の前の `fanout-poc` |
| 閲覧の数の取り込みの費用と誤差 | E6 の前の `view-count-poc` |
| 日本語の検索の方式（kuromoji と N-gram の組み合わせ）、索引の大きさ | E9 の前の `search-poc` |
| S2 で投稿の表を分ける鍵 | posts-and-ids の領域。S1 の計測の後 |
| スパムの分類の部品、有害なメディアのハッシュの照合の提供者 | trust-and-safety の領域 |
| 学習の基盤（SageMaker か、ECS の上のバッチか） | ranking-and-recommendation の領域。S2 の前 |

## 7. 領域の文書（計画）

各領域の文書は、まだない。領域の担当は、下の表の番号の範囲の中で ADR を採番する（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| `posts-and-ids.md` | 投稿の書き込みの経路、検証（重み付きの文字数、URL の短縮、メンション・ハッシュタグの抜き出し）、返信とスレッド、引用、リポスト、返信の制限、削除と後始末、`tid` の生成器と貸し出し、投稿の表の分割（S2）、会話の ID | 0008–0010 | QA | E3 |
| `follow-graph.md` | フォロー・解除、鍵アカウントの申請と承認、ブロック、ミュート（アカウント、語）、2 つの隣接の表、数の写し、フォローの上限、一覧のページング、分割（S2・S3）、大量のフォロー・解除の検出 | 0011–0013 | QA | E4 |
| `timeline-fanout.md` | ホーム（フォロー中）の写しの形、プッシュとプルの閾値と切り替え、アクティブの定義、作り直し（single flight）、削除・ブロック・フォロー解除の後始末、プロフィールの投稿の一覧、会話の表示、瞬間のピークの均し | 0014–0017 | QA、Ops | E5 |
| `ranking-and-recommendation.md` | おすすめのパイプライン、候補の源（フォロー中、関係のグラフ、話題、埋め込み）、特徴の保存、スコア（規則、学習済みのモデル）、固い絞り込み、混ぜ合わせ（作者の偏り、フォロー外の割合）、代わりの並び、オフラインの評価と A/B、理由の記録、学習の基盤 | 0018–0021 | QA、PM | E10 |
| `engagement-and-counters.md` | いいね・リポスト・ブックマークの関係、数の写し（Valkey の桁ごとの数）、集計と書き戻し、照合、閲覧の数の取り込みと概算、数の見せ方、殺到する投稿の扱い | 0022–0024 | QA、Ops | E6 |
| `search-and-trends.md` | 日本語の全文検索（形態素と N-gram、正規化）、索引の更新と版、見える範囲での絞り込み、利用者の検索、ハッシュタグ、トレンド（窓ごとの数、急上昇の検出、地域、スパムの除外、措置の反映） | 0025–0028 | QA、Ops | E9 |
| `notifications.md` | 通知の種類、出来事から通知の行、まとめ（「他 99 人がいいね」）、既読、設定、プッシュ（APNs・FCM）とメール、大きなアカウントへの殺到、見える範囲の再確認 | 0029–0031 | QA | E8 |
| `media.md` | 分割のアップロード、画像の変換と形式、動画の変換（HLS）、代替のテキスト、センシティブの印、配信のドメインと CDN、措置での配信の停止、有害なメディアの照合の入口、保持 | 0032–0034 | QA、Ops | E7 |
| `direct-messages.md` | 会話（1 対 1、グループ）、メッセージの ID と順序、既読、申請、ブロックとの関係、配信（Gateway）、メディア、保存の暗号化、通報、後のエンドツーエンドの暗号化 | 0035–0037 | セキュリティ、QA | E12 |
| `trust-and-safety.md` | 規約と措置の種類、措置の記録と効かせ方、通報の受け付けと優先度、作業の画面と待ち行列、スパムとボット（規則、分類、登録の時の確認）、有害なメディアの照合、異議の申立て、情報流通プラットフォーム対処法の窓口と期限、発信者情報の開示、法執行の窓口、運用の状況の報告、法務の論点の整理 | 0038–0042 | セキュリティ、PM、法務の確認 | E11 |
| `accounts-and-auth.md` | 登録（電話番号・メール）、ログイン、パスキー、Google・Apple、セッション、ハンドルの規則と変更、鍵アカウントの設定、年齢、アカウントの削除と猶予、ログインの記録 | 0043–0045 | セキュリティ | E2 |
| `api-and-rate-limits.md` | 公開 API の形と版、OAuth 2.0（PKCE）とアプリ、トークンの形（`<brand>_`）、レート制限（利用者・アプリ・IP、画面と API の共通の桶）、使った量の計量と課金の連携、Webhook、ヘッダー | 0046–0048 | QA、Ops | E13 |
| `clients.md` | Web（React、PWA）、iOS・Android（React Native）、タイムラインの描画と先読み、閲覧の出来事の送り方、オフラインの下書き、日本語の入力、アクセシビリティ、アプリの配布と最低の版 | 0049–0050 | QA | E2〜E13 |
| `security.md` | 脅威モデル、暗号化と鍵、本人だけの表の RLS、運用者のアクセスと監査、個人データの分類、ログに出さないもの、脆弱性の対応、データのライフサイクル、法務の論点の整理 | 0051–0053 | セキュリティ | E1、E14 |
| `data-model.md` | データモデルの索引 | なし（各領域の ADR を参照する） | QA | 全 Epic |
| `infrastructure.md` | AWS のアカウントとネットワーク、サービスの分け方、Valkey の構成、Kinesis のシャードと消費者、冗長化、DR（写しの作り直しを含む）、段階を上げる基準、S2・S3 の分割、コスト | 0054–0057 | Ops | E1、E14 |
| `observability.md` | ログ・メトリクス・トレース、SLI、fan-out の遅延の計測、見える範囲の監査、カウンターの照合の指標、ランキングのガードレールの指標、中身を出さない計装 | 0058–0059 | Ops | E1、E14 |
| `capacity.md` | 負荷のモデル（投稿、読み出し、fan-out、エンゲージメント、閲覧、瞬間のピーク）、部品ごとの必要量、負荷試験 | 0060 | Ops | E14 |
| `delivery.md` | CI/CD、フラグ、アプリのストアの配布と段階、ランキングの評価を CI に入れる、スキーマの変更の順序 | 0061–0063 | QA、Ops | E1、E14 |

- 次に採番する ADR は 0064。領域の工程の後に足す ADR は、関わる領域の行に番号を書き足す。

## 8. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。E1〜E14 が MVP（S1）。各 Epic の品質の重点と合否基準は [quality.md](../quality.md) の 5 節にある。

| Epic | 目的 |
| --- | --- |
| E1 | 基盤：AWS・Terraform・CI、Aurora と本人だけの表の RLS、`packages/tid`、outbox と Kinesis、フラグ、可観測性、監査ログ、大阪の骨格 |
| E2 | アカウントとプロフィール：登録、ログイン、セッション、プロフィール、鍵アカウント、アプリと Web の骨格 |
| E3 | 投稿：書き込みの経路、文字数、返信・引用・リポスト、削除、`visible()` の骨格 |
| E4 | フォローの関係：フォロー・申請・ブロック・ミュート、数の写し |
| E5 | ホームのタイムライン（フォロー中）：fan-out、プル、写しの作り直し、プロフィールの一覧、会話 |
| E6 | エンゲージメントとカウンター：いいね・リポスト・ブックマーク、数の写しと照合、閲覧の数 |
| E7 | メディア：アップロード、変換、配信、センシティブの印、措置での停止 |
| E8 | 通知：通知の行、まとめ、プッシュ、メール |
| E9 | 検索とトレンド：日本語の全文検索、利用者の検索、ハッシュタグ、トレンド |
| E10 | おすすめ：パイプライン、候補の源、規則のスコア、絞り込み、混ぜ合わせ、A/B |
| E11 | トラスト＆セーフティ：通報、措置、作業の画面、スパム、申出の窓口と期限、開示、法執行の窓口 |
| E12 | DM：会話、メッセージ、申請、Gateway |
| E13 | 公開 API とレート制限：OAuth、API、計量 |
| E14 | 本番の準備と GA の判定：負荷試験、DR の訓練、監査、SLO、ペンテスト |
| E15 以降（MVP の後） | みんなで作る注記、リストとコミュニティ、編集、DM の暗号化、学習済みのモデルのランキング、長文と購読、音声の配信、広告 |
