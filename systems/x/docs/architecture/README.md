# Architecture: X

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。ファイルの一覧、持ち主、ADR の番号の範囲は 7 節、データモデルの正本（表の定義、ER 図、横断の不変条件）は [data-model.md](data-model.md) にある。品質の戦略は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md) にある。

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
     Relay ──▶ Kinesis Data Streams（出来事のログ：posts・graph・engagement・moderation・accounts・dm・audit。views は Ingest から）
                     │
                     ├─▶ Fanout Worker ──（SQS で分割した配り先の束）──▶ Valkey のホームのタイムライン
                     ├─▶ Counter Aggregator ──▶ Valkey のカウンター ──（定期の書き戻し）──▶ Aurora
                     ├─▶ Search Indexer ──▶ OpenSearch（投稿・利用者）、Trends（窓ごとの数）
                     ├─▶ Notification Worker ──▶ 通知の行、APNs・FCM・メール
                     ├─▶ T&S Worker（スパムの規則・分類、ハッシュの照合）
                     └─▶ Firehose ──▶ S3（データレイク：分析、ランキングの学習と評価）

 S3：メディア（原本と変換の後）、データレイク、監査ログの保管      MediaConvert：動画の変換（HLS）
 Ranking・Public API・Ingest ──▶ Firehose（直接：配信の記録、API の計量、見える範囲の抜き取り、RUM）──▶ S3
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
| Kinesis Data Streams | 確定した出来事のログ。8 つの流れ（`posts`・`graph`・`engagement`・`moderation`・`accounts`・`views`・`dm`・`audit`）を複数の消費者が独立に読み、再生できる（[ADR-0005](../decisions/0005-event-log-and-outbox.md)、[infrastructure.md](infrastructure.md) の 6 節）。失ってよい分析の記録は Firehose へ直接書く |

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
| ID | 64 ビット。41 ビットのミリ秒の時刻（独自の起点）、10 ビットの機械の番号、12 ビットの連番。調整なしで振り、おおむね時刻の順（k-sorted）。時計が戻ったら振らない | [snowflake（2010 年のバージョン）](https://github.com/twitter-archive/snowflake/tree/snowflake-2010)（公式のリポジトリ。今の実装は未検証） |
| ホームのタイムライン | 書くときにフォロワーのメモリーの中のタイムラインへ配り、フォロワーの多い作者は読むときに合わせる | 2012 年の講演 [Timelines at Scale](https://www.infoq.com/presentations/Twitter-Timeline-Scalability)（本家の技術者の講演。具体の数値は本文で確かめておらず**未検証**） |
| おすすめ | 候補の源（フォロー中の投稿の索引、関係のグラフの辿り、埋め込みの近さ）→ 軽いランク → 重いランク（ニューラルネットワーク）→ 見える範囲の絞り込み → 混ぜ合わせ。フォロー中とそれ以外は平均で半々 | [twitter/the-algorithm](https://github.com/twitter/the-algorithm)（公式の README、2023 年） |
| おすすめ（今） | Home Mixer が全体を回し、Thunder がフォロー中の最近の投稿をメモリーに持ち、Phoenix が取り出しとランクを行い、SimClusters でフォロー外の候補を探す。行動ごとの確率を重みで足し（Σ 重み × 確率）、作者の 2 件目以降に下限のある減衰を掛け、フォロー外を割り引き、新しい作者を押し上げる | [xai-org/x-algorithm](https://github.com/xai-org/x-algorithm)（公式の README。2026-10-04 に取得し直して確かめた） |
| 表示の数 | ログインした人が投稿を見た回数。同じ人の複数回も数え、本人の閲覧も数える。一意ではない | [View counts](https://help.x.com/en/using-x/view-counts)（検索結果の抜粋で確認。本文は 403 で未確認） |
| 利用者の上限 | 投稿 1 日 2,400 件、DM 1 日 500 件、フォロー 1 日 400 件。5,000 人をフォローした後は、フォロワーとの比で制限 | [About X limits](https://help.x.com/en/rules-and-policies/x-limits)、[About following on X](https://help.x.com/en/using-x/x-follow-limit)（同上） |
| 公開 API | 15 分か 24 時間の窓、アプリごとと利用者ごとの上限、`429`、`x-rate-limit-*` のヘッダー。使った量に応じた課金（投稿の読み出し 1 件 $0.005）、月 300 万件の読み出しの上限 | [Rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)、[Pricing](https://docs.x.com/x-api/getting-started/pricing)（公式） |
| メディア | 画像 5 MB、GIF 15 MB、動画は分割のアップロード（INIT・APPEND・FINALIZE）。上限はアカウントの種類で変わる | [Media upload](https://docs.x.com/x-api/media/introduction)（公式） |
| DM | エンドツーエンドの暗号化の「Chat」を持つ。秘密鍵は PIN で守り、Juicebox の方式で 3 つの保管先（うち 2 つは HSM）に分けて預ける。従来の DM は Chat と別に残り、暗号化されない | 鍵の方式は公式の文書（[How X Chat keeps your messages secure](https://docs.x.com/xchat/cryptography-primer)）で確かめた。従来の DM の扱いは第三者の報道（[TechCrunch, 2025-09-05](https://techcrunch.com/2025/09/05/x-is-now-offering-me-end-to-end-encrypted-chat-you-probably-shouldnt-trust-it-yet/)）で、本家の文書は**未検証** |

いずれも 2026-10-04 に確認（統合の工程で公式の資料を取得し直した）。本家のエンジニアリングのブログ（blog.x.com）とヘルプセンター（help.x.com）は、確認の時点で取得が 403 になった。そこにしかない数値は「未検証」とした。この設計は、上の考え方を参考にするが、本家のコード・設定・モデルを使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

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
| DB | Aurora PostgreSQL 18。テナントの RLS はなく、本人だけが読む表（DM、ブックマーク、下書き、通知、設定など。一覧は [data-model.md](data-model.md) の 3.2 節）に FORCE RLS と `SET LOCAL app.actor_id` | [ADR-0004](../decisions/0004-single-tenant-and-visibility.md) |
| 写し | ElastiCache（Valkey）の 4 クラスタ：`vk-timeline`（ホームの写し、作者の最近の投稿）、`vk-cache`（投稿の状態、閲覧者の集合、特徴）、`vk-counters`（数）、`vk-edge`（セッション、レート制限） | [ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)、[ADR-0055](../decisions/0055-kinesis-consumers-and-valkey-clusters.md) |
| 出来事のログ | transactional outbox → Relay → Kinesis Data Streams。仕事の待ち行列は SQS | 共通の SQS・SNS に加えて Kinesis を使う。理由は [ADR-0005](../decisions/0005-event-log-and-outbox.md) |
| 検索 | Amazon OpenSearch Service。一致の判定は 1〜2 文字の N-gram、関連度は kuromoji | [ADR-0025](../decisions/0025-search-engine-and-japanese-analysis.md)。Sudachi は `search-poc` で比べる |
| ランキング | 自前のパイプライン（`packages/ranking`）。S1 は規則と軽いスコア、S2 から学習済みのモデル（ONNX Runtime。学習は SageMaker と Step Functions）、S3 で埋め込みの取り出し | [ADR-0006](../decisions/0006-ranking-boundary.md)、[ADR-0019](../decisions/0019-ranking-features-and-training-platform.md) |
| メディア | S3、CloudFront（KeyValueStore の拒否の一覧で配信を止める）、画像の変換は自前の Worker（`sharp`）、動画は AWS Elemental MediaConvert（HLS） | [ADR-0032](../decisions/0032-media-upload-and-processing.md)、[ADR-0033](../decisions/0033-media-delivery-and-takedown.md) |
| リアルタイム | WebSocket（Realtime Gateway）、Valkey の pub/sub | Slack の題材の考え方を先例にする |
| クライアント | Web は React（SPA、PWA）。iOS・Android は React Native（Expo） | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| データレイク | Kinesis Data Firehose → S3（Apache Iceberg の表）、Athena | 分析、学習、評価、法令の報告の集計 |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs、Managed Grafana | 他の題材と同じ |
| フラグと設定 | AWS AppConfig。フラグは `release.*`・`ops.*`・`experiment.*`、決めた値は `policy.*`・`retention.*`・`legal.*`・`ts.*`（[delivery.md](delivery.md) の 3 節） | 他の題材と同じ。ランキングの A/B は `experiment.ranking.*` |
| 認証 | Better Auth（`packages/auth` で包む。電話番号・メールの OTP、パスキー、Google・Apple。パスワードは持たない） | Linear の題材と同じ考え方（[ADR-0043](../decisions/0043-auth-methods-and-sessions.md)） |
| テスト | Vitest、fast-check、Testcontainers、Playwright、Maestro（アプリの E2E）、k6 | [quality.md](../quality.md) の 2.2 節 |

## 5. 主な決定

どれも `accepted`。0001〜0007 は最初の設計の起票、0008〜0063 は領域の文書の工程で起票した。統合の工程で 0003・0004・0005・0007・0016・0023・0051・0055 を直し、日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節の例外）。状態の一覧は [decisions/README.md](../decisions/README.md)。番号の欠け（0021・0028・0042・0045・0057）は、領域に割り当てて使わなかった番号である。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、タイムライン・推薦・カウンター・検索の核を自前で作る。アプリは React Native、学習だけ Python |
| [0002](../decisions/0002-post-ids-and-ordering.md) | 投稿・利用者・DM のメッセージに、時刻の順に並ぶ 64 ビットの `tid` を振る |
| [0003](../decisions/0003-timeline-fanout-hybrid.md) | ホームのタイムラインは、フォロワーの少ない作者はプッシュ、多い作者はプルで作る |
| [0004](../decisions/0004-single-tenant-and-visibility.md) | テナントは 1 つ。本人だけの表に FORCE RLS をかけ、公開の表の見える範囲は 1 つの関数 `visible()` で読み出しの時に決める |
| [0005](../decisions/0005-event-log-and-outbox.md) | 確定した変更は outbox から Kinesis Data Streams の出来事のログへ流す。閲覧の数だけは Aurora を通さない |
| [0006](../decisions/0006-ranking-boundary.md) | おすすめは自前の段のパイプラインにし、ML はスコアと取り出しだけに使う。安全と法令の判定を上書きしない |
| [0007](../decisions/0007-follow-graph-storage.md) | フォローの関係は、向きの違う 2 つの隣接の表を正本にし、同じトランザクションで書く。グラフ DB を使わない |
| [0008](../decisions/0008-post-write-path-and-idempotency.md) | 投稿の書き込みは、検証の後に `tid` を振り、投稿の行・抜き出した要素・冪等の記録・outbox を 1 つの DB のトランザクションで確定する。再送は `(author_id, client_request_id)` で同じ投稿を返す |
| [0009](../decisions/0009-post-state-tombstones-and-state-cache.md) | 削除と措置は行を消さずに状態と `state_version` を変える。投稿の状態の写しはバージョンの新しいものだけを書き、寿命を 45 秒にして、出来事が止まっても 60 秒の中で正本に戻る |
| [0010](../decisions/0010-post-table-partitioning-s2.md) | S2 で投稿の表を投稿の ID のハッシュで分割する。作者・会話ごとの一覧は、出来事から作る別の索引の表に、それぞれ作者・会話の ID で分割して持つ |
| [0011](../decisions/0011-graph-edge-state-machine-and-locking.md) | フォロー・申請・ブロックの辺を 1 つのステートマシンで扱い、2 人の組ごとの勧告ロックで直列にする。ブロックは同じトランザクションで両向きのフォローと申請を外し、鍵を外したら待っている申請をすべて承認する |
| [0012](../decisions/0012-viewer-sets-cache.md) | 閲覧者の集合（ブロックの両向き、ミュート、承認済みの鍵アカウントのフォロー先、ミュートの語）を Valkey にバージョンつきの写しで持ち、書き込みの確定の直後に更新する。寿命は 1 時間。ミュートは逆向きの表を持たない |
| [0013](../decisions/0013-graph-partitioning.md) | 関係の表を利用者の ID のハッシュで 1,024 の論理の分割に分け、物理のクラスタへの対応表で置く。S2 は 4 クラスタから。分割の後は `following` と `blocks` を正本にし、逆向きの表は出来事から作る |
| [0014](../decisions/0014-home-timeline-replica-format.md) | ホームの写しは、32 バイトの項目を ID の降順に詰めた Valkey の文字列にし、挿入・合わせ・除去を Valkey Functions で行う。返信の項目は 4 つ目の欄に返信先の利用者を入れる |
| [0015](../decisions/0015-fanout-pipeline-and-burst-control.md) | 振り分け役は全作者の最近の投稿の写しを先に書いてから、フォロワーのページの仕事を作者の大きさで 2 つの待ち行列に分けて作る。瞬間のピークでは閾値を一時的に下げ、プルに回した作者を 7 日間プルの合わせの対象に入れる |
| [0016](../decisions/0016-timeline-rebuild-single-flight.md) | 写しの作り直しは、空の「作り直し中」の写しを先に置いてから、フォローしている作者の最近の投稿の写しを合わせて作る。single flight は Valkey の鍵で行い、全体の作り直しの速さに上限を置き、超えたら範囲を狭めて返す |
| [0017](../decisions/0017-profile-and-conversation-reads.md) | プロフィールの一覧は作者の最近の投稿の写しと作者の索引から読む。会話は会話の索引から読み、返信を段と規則の点で並べる。直接の返信が 1,000 件を超える会話は上位 200 件の候補の写しを持つ |
| [0018](../decisions/0018-ranking-candidates-and-two-stage-scoring.md) | おすすめの候補は S1 で 5 つの源から 800 件まで集め、軽いランクと重いランクの 2 段で点を付け、作者とフォロー外の割合を混ぜ合わせで抑える |
| [0019](../decisions/0019-ranking-features-and-training-platform.md) | ランキングの特徴の定義を 1 か所に置き、配信の時の特徴を記録して学習に使う。学習は SageMaker と Step Functions、推論は ONNX Runtime をサービスの中で動かす |
| [0020](../decisions/0020-ranking-evaluation-experiments-and-transparency.md) | ランキングの変更はオフラインの評価と利用者の単位の A/B で判定し、返した投稿の理由を記録して示す。利用者の操作と個人化しない設定を持つ |
| [0022](../decisions/0022-engagement-relations-and-writes.md) | いいねは投稿の側と利用者の側の 2 つの向きの表を正本にし、リポストは `reposts` を正本にする。状態が変わったときだけ出来事を出す。ブックマークは本人だけの表。いいねした人の一覧は投稿の作者だけ、利用者のいいねの一覧は本人だけが見られる |
| [0023](../decisions/0023-counter-aggregation-and-reconciliation.md) | `engagement` の流れの鍵を「投稿の ID と利用者の ID の下 3 ビット」にし、数の写しは Valkey の投稿ごとのハッシュに部分ごとの最後の連番を持って Function で冪等に足す。返信・引用の数も投稿の書き込みが `engagement` の流れへ出す。書き戻しは 60 秒、照合は静かな投稿で数え直す |
| [0024](../decisions/0024-view-counts-ingest-and-approximation.md) | 閲覧は「画面に投稿の 50% 以上が 500ms 以上出た」こと。Ingest はクライアントの束を閲覧者のセッションで分けた鍵で `views` の流れへ入れ、集計は位置を先に記録してから足して数えすぎない。データレイクとの日ごとの補正で上にだけ直し、表示は減らない |
| [0025](../decisions/0025-search-engine-and-japanese-analysis.md) | 検索は OpenSearch で、一致の判定は 1〜2 文字の N-gram、関連度の点は kuromoji で付ける。正規化は 1 つの関数で索引と問い合わせにかける |
| [0026](../decisions/0026-search-index-layout-and-visibility.md) | 投稿の索引は月ごとに分けて `tid` の時刻で書き先を決め、`state_version` を外部のバージョンにする。問い合わせは 1 つの組み立て関数で見える範囲の条件を必ず含め、返す前に `visible()` で判定し直す |
| [0027](../decisions/0027-trends-burst-detection.md) | トレンドは地域ごとに 5 分の区切りで「重み付きの一意の投稿者の数」を数え、基準との差をポアソンの揺れで割った点で急上昇を決める |
| [0029](../decisions/0029-notification-rows-and-grouping.md) | 通知の行は受け手の本人だけの表に書き、いいね・リポスト・フォローは対象ごとに 1 行にまとめて、開いている間は行為者を足す。殺到を受けている受け手は、行為者の集合を Valkey で数えて 60 秒ごとに書き戻す |
| [0030](../decisions/0030-push-and-email-delivery.md) | プッシュは送る直前に見える範囲・設定・送る量の上限を確かめる。本文を載せない形を既定にし、端末が API で中身を取る。まとめの通知は collapse の鍵で上書きする。メールは日ごとの要約だけ |
| [0031](../decisions/0031-read-state-and-visibility-rechecks.md) | 通知の既読は受け手ごとの 1 本の位置で持ち、未読の数は Valkey の写しで数えて Realtime Gateway で届ける。見える範囲は、作る時・送る時・読む時の 3 回判定する |
| [0032](../decisions/0032-media-upload-and-processing.md) | メディアはクライアントから S3 へ分割で直接上げ、検査とハッシュの照合を通るまで公開しない。画像は位置の情報を消して決まったバージョンに、動画は MediaConvert で HLS にする |
| [0033](../decisions/0033-media-delivery-and-takedown.md) | 公開のメディアは推測できないキーの URL で 1 年キャッシュして配り、鍵アカウントと DM のメディアは署名付きの URL で配る。措置では CloudFront KeyValueStore の拒否の一覧で数秒で止め、元を隔離して無効にする |
| [0034](../decisions/0034-media-hash-matching.md) | 有害なメディアのハッシュの照合は差し替えられる口の後ろに置き、公開のメディアは照合を通るまで公開しない。自前で措置したメディアの PDQ の一覧も持つ。DM のメディアは L3 の確認まで照合しない |
| [0035](../decisions/0035-dm-conversation-model-and-storage.md) | DM は会話ごとの連番で並べ、参加者の FORCE RLS と会話ごとの鍵の列の暗号化で守る。配信は ID だけを流して受け手の権限で読み直す |
| [0036](../decisions/0036-dm-consent-requests-and-reporting.md) | フォローしていない人からの DM は申請に入れ、受け手の設定とブロックで決定表の順に判定する。通報は参加者が選んだメッセージを同意の画面を経て証拠へ写す |
| [0037](../decisions/0037-dm-e2ee-readiness.md) | DM のエンドツーエンドの暗号化は MVP の後に入れる。MVP では本文を中身の分からない入れ物として扱い、サーバーが本文を読む機能を作らない。方式の第一の候補は MLS |
| [0038](../decisions/0038-moderation-action-model.md) | 措置は追記だけの `moderation_actions` に根拠と主体を書き、同じトランザクションで措置の要約と `state_version` と outbox を書いてから効かせる |
| [0039](../decisions/0039-reports-queues-and-appeals.md) | 通報は対象と区分ごとの案件にまとめ、重さと広がりと信頼と速さで優先度を付けて P0〜P3 の待ち行列に入れる。作業の画面は通報の時の証拠の写しを見せ、異議は別の担当が見る |
| [0040](../decisions/0040-spam-and-bot-defense.md) | スパムとボットは、エッジ・登録・レート制限・行動の規則・アカウントの危険の点の層で防ぎ、点の帯ごとに決まった扱いをする。点は見える範囲を変えない |
| [0041](../decisions/0041-legal-requests-and-transparency.md) | 法令の案件は通報と別の表で持ち、受け付けの時刻から期限を計算して警告する。期限・基準・通知の値は `legal.*` に置き、法務の確認の後に決める。保全は `legal_holds` で削除を止め、公表は記録から集計する |
| [0043](../decisions/0043-auth-methods-and-sessions.md) | 認証は Better Auth を包んで使い、パスワードを持たない。登録には電話かメールの確認を必須にし、セッションの写しを Valkey に置いて取り消しを 5 秒で効かせる |
| [0044](../decisions/0044-account-states-deletion-and-age.md) | アカウントの状態を 5 つにし、Accounts だけが outbox を通して変える。停止は 30 日の猶予の後に削除する。年齢は区分だけを `visible()` に渡し、境の値は法務の L5 の後に設定で入れる |
| [0046](../decisions/0046-public-api-shape-and-oauth.md) | 公開 API は `/v1/` の REST で、ID は文字列、一覧は `tid` の範囲と署名した `next_token` で送る。認証は OAuth 2.0 の認可コード＋PKCE と、公開の読み出しだけのアプリのトークン |
| [0047](../decisions/0047-rate-limit-token-buckets.md) | レート制限は Valkey の上のトークンバケットを Valkey Functions で複数同時に引く。利用者の行動の上限は画面と API で共通にし、応答は IETF の `RateLimit` のヘッダーで返す |
| [0048](../decisions/0048-usage-plans-and-metering.md) | 公開 API は返した件数と書き込みの回数で計量し、プランの月の上限を Valkey で強制する。請求の連携と活動の Webhook は MVP の後 |
| [0049](../decisions/0049-client-data-layer-and-offline.md) | クライアントは共通のパッケージとデータの層を持ち、ホームの 200 件を手元に保存する。DM の中身は手元に置かない。オフラインの投稿は `Idempotency-Key` つきの待ち行列にする。公開の URL は App API が最小の HTML を返す |
| [0050](../decisions/0050-timeline-list-rendering.md) | タイムラインの一覧は、アプリは FlashList、Web は自前の仮想化で描き、落ちたフレームを固定の端末と RUM で測る。基準を 2 回の改善で満たせない画面だけ、ネイティブの一覧の部品にする |
| [0051](../decisions/0051-encryption-and-key-layout.md) | KMS の鍵をデータの種類ごとに分け、電話番号・メールアドレス・生年月日・IP アドレスはアプリの層でも封筒の暗号化をし、検索は鍵付きの HMAC の列で行う |
| [0052](../decisions/0052-audit-and-operator-access.md) | 監査ログは DB の追記だけの表と log-archive の Object Lock の 2 か所に書く。本番のデータへの人の常時のアクセスを置かず、読み出しは理由を必須にしたロールと 2 人の承認の break-glass だけにする |
| [0053](../decisions/0053-data-lifecycle-and-retention.md) | データを種類ごとの保持の方針の表で管理し、法令に関わる種類は法務の値が入るまで物理の削除を止める。削除は墓石から後始末を経て物理の削除へ進み、法的な保全で止まる |
| [0054](../decisions/0054-accounts-network-and-services.md) | アカウントとネットワークは他の題材の形を引き継ぎ、入口は CloudFront → ALB にする。サービスは入口・書き込み・読み出し・消費者・Worker に分けて ECS Fargate に置き、外の宛先への送信は egress の専用の経路にする |
| [0055](../decisions/0055-kinesis-consumers-and-valkey-clusters.md) | Kinesis の消費者は自前の TypeScript の読み手にし、遅れに厳しい消費者は拡張ファンアウトで読む。シャードの担当と位置は Aurora に持つ。Valkey は用途で 4 つのクラスタに分ける |
| [0056](../decisions/0056-disaster-recovery-osaka.md) | 大阪にウォームスタンバイを持ち、人の判断でワークフローで切り替える。大阪は生成器の番号 512〜1023 だけを使い、送った outbox の行を 1 時間残して切り替えの後に送り直す。写しは空から作り直し、合わせに要る `ar:` を入口を開く前に作る |
| [0058](../decisions/0058-timeline-freshness-measurement.md) | タイムラインの届く速さは合成監視を正解にし、出来事に運ぶ確定の時刻からの区間の内訳と、読み出しの抜き取りで補う |
| [0059](../decisions/0059-guardrail-and-audit-metrics.md) | ランキングのガードレールは 5 分ごとの近似で自動に止め、データレイクの日ごとの値で広げる判断をする。見える範囲の抜き取りの監査は 5 秒後に正本で判定し直し、説明のつく不一致を除いて数える |
| [0060](../decisions/0060-capacity-headroom-and-load-shedding.md) | 各部品は AZ を 1 つ失っても S1 のピークをさばける大きさにし、fan-out は瞬間のピークの 2/3 を続けて書ける大きさにする。超えるときに削る順を決め、投稿の書き込みと `visible()` は削らない |
| [0061](../decisions/0061-ci-gates.md) | PR の必須の関門に、漏れの経路の表、`visible()` の決定表、fan-out の性質、出来事の再生、本人だけの表の RLS、ランキングのオフラインの評価、本家の実装の検査、契約の互換を入れ、変更のパスで足す。外すラベルを持たない |
| [0062](../decisions/0062-mobile-release-and-min-version.md) | アプリは週 1 回の列車でストアに出し、iOS は 7 日の段階的リリース、Android は段階的公開で広げる。JS だけの修正は自前の Expo Updates の形のサーバーから署名した束で配る。最低のバージョンは `426` で強制し、支えるバージョンは 12 週 |
| [0063](../decisions/0063-contract-change-ordering.md) | 契約の変更は、広げる → 読む側を新旧に対応 → 書く側を移す → 縮める、の順にする。DB の縮めは別のリリース、出来事は共通の頭とバージョンを持ち、公開 API は同じバージョンの中で足すだけ、画面の API は 12 週前のアプリが読める形を保つ |

領域ごとの ADR は、7 節の番号の範囲で起票する。リポジトリ共通の決定（開発プロセス、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、本家の実装を核に使わない規則の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **見える範囲の漏れ**：鍵アカウント・ブロック・削除・措置の投稿が、写し・検索・通知・API・メディアの URL・埋め込みのどれかの経路から見える。経路が多いのがこの題材の弱み。全経路を `visible()` に通し（[ADR-0004](../decisions/0004-single-tenant-and-visibility.md)）、漏れの経路の表（[quality.md](../quality.md) の 2.2.1 節）と本番の抜き取りの監査で確かめる。メディアは署名付きの URL ではなく公開の CDN で配るため、措置での配信の停止は、CloudFront KeyValueStore の拒否の一覧で数秒で効かせ、CDN の無効化と元の隔離を重ねる（[ADR-0033](../decisions/0033-media-delivery-and-takedown.md)）。
- **fan-out の爆発と遅れ**：フォロワーの多い作者の連投、瞬間のピーク、閾値の付近の作者で、キューが溜まり NFR-002 を外す。プルへの切り替え（[ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)）、アクティブなフォロワーだけに配る、キューの深さでの閾値の一時の引き下げ（`burst`。[ADR-0015](../decisions/0015-fanout-pipeline-and-burst-control.md)）で抑える。E5 の PoC で、閾値と Valkey の書き込みの量を測る。
- **写しの作り直しの殺到**：Valkey のノードを失う、大阪への切り替えで写しが空になると、全員の読み出しが作り直しになり Aurora に集中する。作り直しを利用者ごとに 1 回にまとめ（single flight）、全体の作り直しの速さに上限を置き、超えたら範囲を狭めて返す（[ADR-0016](../decisions/0016-timeline-rebuild-single-flight.md)）。DR では入口を開く前に `ar:` を作る（[ADR-0056](../decisions/0056-disaster-recovery-osaka.md)）。DR の訓練で、作り直しの速さを測る。
- **カウンターのずれ**：写しの集計の取りこぼし・二重の加算で、数が正本とずれる。照合のジョブで差を測り、正本で上書きする（[ADR-0005](../decisions/0005-event-log-and-outbox.md)、[ADR-0023](../decisions/0023-counter-aggregation-and-reconciliation.md)）。閲覧の数は概算と明示する。
- **ランキングの暴走**：モデルや重みの変更で、特定の種類の投稿（煽り、スパム）が増える。オフラインの評価、A/B、ガードレールの指標（通報の率、ミュート・ブロックの率）で止める（[ADR-0006](../decisions/0006-ranking-boundary.md)）。
- **スパムとボット**：公開の登録と公開 API は、スパムとボットの入口になる。登録の時の電話番号の確認、レート制限、行動の規則、アカウントの危険の点、WAF の Bot Control を重ねる（[ADR-0040](../decisions/0040-spam-and-bot-defense.md)）。
- **ID の衝突**：生成器の番号の貸し出しの誤りか、時計の戻りで同じ `tid` が出る。貸し出しの重なりを DB の制約で防ぎ、時計の戻りでは振らない（[ADR-0002](../decisions/0002-post-ids-and-ordering.md)）。投稿の表の主キーで重複を検出する。
- **大きな会話**：人気の投稿への数十万件の返信で、会話の表示と通知が重くなる。会話の読み出しは返信の上位だけをランクして返す（[ADR-0017](../decisions/0017-profile-and-conversation-reads.md)）。通知はまとめ、殺到の受け手は Valkey で数える（[ADR-0029](../decisions/0029-notification-rows-and-grouping.md)）。
- **法令**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」の L1〜L11）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

### 決定（2026-10-04、既定案）

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。その後の領域の工程と統合の工程での変更は、下の「統合」の節にある。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも E1〜E14 の PoC・試験で覆りうる。

- **テナント**：1 つ。RLS は本人だけの表に限る（[ADR-0004](../decisions/0004-single-tenant-and-visibility.md)）。
- **ID**：投稿・利用者・DM のメッセージは 64 ビットの `tid`。共通の UUIDv7 から外れる（[ADR-0002](../decisions/0002-post-ids-and-ordering.md)）。
- **fan-out**：プッシュとプルの組み合わせ。閾値の既定は 1 万フォロワー。写しは 800 件、アクティブ（30 日以内に読んだ）なフォロワーだけに配る（[ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)）。
- **出来事のログ**：Kinesis Data Streams（オンデマンド）。仕事の待ち行列は SQS（[ADR-0005](../decisions/0005-event-log-and-outbox.md)）。
- **ランキング**：S1 は規則と軽いスコア。学習済みのモデルは S2（[ADR-0006](../decisions/0006-ranking-boundary.md)）。
- **アプリ**：React Native（Expo）で iOS・Android を MVP に含める。日本の利用者の大半がスマートフォンで使うため（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **文字数**：本家と同じ重み付きの 280。数え方は公開の仕様から自前で実装し、`twitter-text` を使わない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **DM の暗号化**：MVP はサーバーの側の保存の暗号化（KMS）だけ。エンドツーエンドの暗号化は MVP の後（法務の L3 とあわせて決める）。
- **レート制限のヘッダー**：本家の `x-rate-limit-*` の形でなく、IETF の `RateLimit`・`RateLimit-Policy` の形にする（領域の工程で確定した。[ADR-0047](../decisions/0047-rate-limit-token-buckets.md)）。

### 決定（2026-10-04、統合）

領域の文書の間の食い違いを、統合の工程で次のとおり解いた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。

- **出来事のログの流れ**：8 つにした（`posts`・`graph`・`engagement`・`moderation`・`accounts`・`views`・`dm`・`audit`）。`engagement` の鍵は `"{post_id}:{user_id mod 8}"`（[ADR-0023](../decisions/0023-counter-aggregation-and-reconciliation.md)）、`views` の鍵は閲覧者のセッションのハッシュ（[ADR-0024](../decisions/0024-view-counts-ingest-and-approximation.md)）。`dm` は ID だけを運び、データレイクへ写さない（[ADR-0035](../decisions/0035-dm-conversation-model-and-storage.md)）。ADR-0005 の表を直し、注記を残した。
- **Firehose へ直接書く記録**：ランキングの配信の記録（`ranking-served`）、API の計量（`api-usage`）、見える範囲の抜き取り（`visibility-audit`）、RUM（`rum`）は、確定した変更でないので Kinesis Data Streams を通さない（ADR-0005 の注記）。名前は `ranking-served` に揃えた（observability の `ranking-reasons` を直した）。
- **outbox の保持**：送った行を 1 時間残し、DR で大阪の Relay が直近 15 分を送り直す（[ADR-0056](../decisions/0056-disaster-recovery-osaka.md)）。ADR-0005 の「送れたら消す」を直した。
- **カウンターの位置**：ADR-0005 の「結果とシャードの位置を同じ `MULTI`」は Valkey のクラスタでは書けないので取り消した。数の写しは投稿ごとのハッシュに部分ごとの最後の連番を持って冪等に足し（ADR-0023）、シャードの位置は全消費者とも Aurora の `stream_checkpoints` に持つ（[ADR-0055](../decisions/0055-kinesis-consumers-and-valkey-clusters.md) の注記）。`vk-counters` は数と連番だけを持つ。
- **「Valkey の桁ごとの数」**：7 節の engagement-and-counters の行と intent の旧い書き方。閲覧の数を確率で概算する方式（桁ごとに確率で足す数え方。HyperLogLog と並ぶ案）を指していたが、数の小さい投稿で誤差が 2% に収まらないので採らなかった（[ADR-0024](../decisions/0024-view-counts-ingest-and-approximation.md) の案 c）。今の形は「投稿ごとのハッシュ `pc:{post_id}` に、数の欄と、`engagement` の鍵の部分（`sub` = 利用者の ID の下 3 ビット、8 つ）ごとの最後の連番を持つ」（ADR-0023）。閲覧の数も同じハッシュの `view` の欄で、HyperLogLog は使わない（ADR-0024）。intent の同じ書き方も直した。
- **ミュートの向き**：ミュートは逆向きの表を持たない（[ADR-0012](../decisions/0012-viewer-sets-cache.md)）。2 つの向きはブロック（`blocks`・`blocked_by`）だけ。ADR-0007 を直した。
- **`ar:` の範囲**：全作者に持つ（直近 7 日・200 件。[ADR-0015](../decisions/0015-fanout-pipeline-and-burst-control.md)）。ADR-0003 を直した。作者の方式は別の `authors` の表を作らず `users.fanout_mode` に置く。
- **DR の `ar:`**：大阪では東京の Kinesis を読み直せないので、入口を開く前に、合わせに要る作者の `ar:` を Aurora から作る（ADR-0016 の注記、[infrastructure.md](infrastructure.md) の 7.5 節）。
- **`visible()` の面**：`ViewerContext.surface` を足した。面で変わるのはミュートの当て方と `interstitial` の扱いだけで、ブロック・鍵・削除・措置は面に関わらず同じ（ADR-0004 の注記、AGENTS.md）。
- **本人だけの表**：領域の文書が足した表（`ranking_feedback`、`dm_message_hidden`、`dm_requests`、`dm_settings`、`user_settings`、通知の表、`oauth_grants`、`data_export_requests` ほか）を ADR-0004 の一覧に足した。正本の一覧は [data-model.md](data-model.md) の 3 節。予約の投稿は MVP に含めない。
- **列の持ち主**：他の領域が求めた列を、持ち主の文書の表に足した。`users.account_mod`・`graph_version`・`fanout_mode`・`pinned_post_id`・`flags` と、新しい `user_settings`（`region`・`personalized_ranking`・`home_default_tab` ほか）は [accounts-and-auth.md](accounts-and-auth.md) の 12 節。`posts.region_code`・`has_media` と `drafts` は [posts-and-ids.md](posts-and-ids.md) の 12 節。DM の設定は `user_settings` の列にせず `dm_settings` に分けた。
- **フラグと設定の名前空間**：フラグは `release.*`・`ops.*`・`experiment.*`、決めた値は `policy.*`・`retention.*`・`legal.*`・`ts.*`（[delivery.md](delivery.md) の 3 節、AGENTS.md）。ランキングの A/B は `experiment.ranking.*` に揃えた（AGENTS.md の `release.ranking.*` を直した）。法務の確認待ちの振る舞いの門は `release.*` にし、`legal.l3.*` を `release.dm_report_evidence`・`release.dm_media_matching` に、`release.ranking.reasons` を `release.ranking_reasons` に、`policy.phone.max_accounts` を `ts.registration.max_accounts_per_phone` に改めた。`ops.timeline.rebuild_window` は `ops.timeline.rebuild_rate` に揃えた。
- **鍵**：通報の証拠の写しとメディアの隔離の置き場に、KMS の鍵 `ts-evidence` を足した（[ADR-0051](../decisions/0051-encryption-and-key-layout.md) の注記）。
- **Valkey の置き場所**：`pl:` は `vk-timeline` に置く（`vk-cache` から外した）。読み出しの命令の数（[capacity.md](capacity.md) の 3 節）を直した。閲覧者の集合は 1 回の Function で読む。
- **閲覧の流れの量**：1 レコード（25 件の束）を 2 KB に揃えた（engagement-and-counters の値）。S1 のピーク 1.6 MB/秒・瞬間 4.8 MB/秒で、`views` も温めた量を 20 MB/秒にする。S3 は約 170 MB/秒で東京の上限の 8 割を超えるので、S2 の間に上限の引き上げを申請する（[capacity.md](capacity.md) の 5.3 節）。Ingest の口は `/i/views` に揃えた。
- **おすすめの負荷**：候補は S1 で 800 件、特徴の付加は軽いランクの後の 200 件だけ（[ranking-and-recommendation.md](ranking-and-recommendation.md)）。capacity の見積もりを合わせた。
- **検索とミュート**：ミュートした作者は投稿の検索から除くが、`from:` で指定したときは出す（[search-and-trends.md](search-and-trends.md) の 6.3 節、[follow-graph.md](follow-graph.md) の 4.5 節）。
- **アプリの段階の配布**：iOS は App Store の 7 日の段階的リリース（1% → 2% → 5% → 10% → 20% → 50% → 100%）、Android は 1% → 10% → 50% → 100%（[runbooks/README.md](../runbooks/README.md) の 3 節を直した。[ADR-0062](../decisions/0062-mobile-release-and-min-version.md)）。
- **品質と運用**：各領域の文書の「quality.md・runbooks への項目」を反映した。漏れの経路の表に、おすすめの続きのページ（`rk:`）、クライアントの手元の写し、運用者・T&S のコンソール、アカウントの状態の変更の直後、閲覧者の集合の更新の失敗、作った後のブロック（通知）を足した。DR の訓練の合格基準を足した。runbooks の手順を、作ったもの（3 つ）と計画のものに分けて一覧にした。
- **法務の確認待ちの追加**：通知の要約のメールと特定電子メール法を L11 として足した。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。利用者の行動の上限は [api-and-rate-limits.md](api-and-rate-limits.md) の 5.3 節。保持の期間は [security.md](security.md) の 7.1 節。負荷のモデルは [capacity.md](capacity.md) の 1 節。表と置き場所は [data-model.md](data-model.md)。
- **検証の工程での直し（2026-10-04）**：公式の資料を取得し直して、次を確かめ・直した。おすすめの今の構成（SimClusters、作者の減衰の下限、新しい作者の押し上げ。1.3 節）、Chat の鍵の預け方（Juicebox。公式の文書で確かめ、未検証を外した）、情報流通プラットフォーム対処法の指定（2025-04-30 の 5 社の後、5 月に 4 社を追加）、申出から 7 日の期限（第三者の解説で確認、省令の条文は未検証）、CloudFront KeyValueStore の上限と、CloudFront Functions で国の見出しを読めること（[media.md](media.md)）、App Store の段階的リリースの割合、Kinesis の上限、IETF の `RateLimit` の草案（draft-11、まだ RFC でない）、公開 API の課金と上限、メディアの上限。help.x.com と blog.x.com は再び 403 で、そこにしかない値は未検証のまま残した。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

### 決定（2026-10-04、データモデル）

データモデルの完全版（[data-model.md](data-model.md) と [data-model/](data-model/)）を作る工程で、領域の文書と ADR の間の名前と列の食い違いを次のとおり解いた。ADR の決定は変えていない。

- **正本の移動**：列・鍵・索引の正本を [data-model.md](data-model.md) と [data-model/](data-model/) に移した。領域の文書の「data-model への項目」は要点で、食い違ったらデータモデルに合わせて直す。
- **措置の要約の形**：`posts.mod_flags` をビット（`LABEL`・`REDUCE`・`REMOVED`・`AGE_GATED`・`GEO_WITHHELD`・`UNDER_REVIEW`・`NO_ENGAGE`・`MEDIA_REMOVED`）と地域の列 `posts.mod_geo` にし、`users.account_mod` もビットと `account_mod_detail` にした（[data-model.md](data-model.md) の 3.5 節）。[posts-and-ids.md](posts-and-ids.md) の `restricted`・`age_gated`・`geo_withheld` と [trust-and-safety.md](trust-and-safety.md) の `label`・`reduce`・`removed`・`geo` の食い違いを、この名前に揃えた。
- **作者の状態のバージョン**：`as:` のバージョンとして `users.state_version` を足した（[posts-and-ids.md](posts-and-ids.md) の 6 節が求めていたが、`users` の表になかった）。
- **本人だけの表の列**：`owner_id` に揃えた（`user_contacts`・`user_birthdates`・`dm_message_hidden`・`oauth_grants` の `user_id` を直した）。`user_contacts` に変更の保留の `slot`（`current`・`pending`）と HMAC の鍵のバージョンを足した。
- **`auth` スキーマ**：`auth.user.email`・`phone_number` に平文でなく HMAC の値を入れ、`auth.session` に IP を残さない（[security.md](security.md) の 5.3 節の「平文の列を持たない」を Better Auth の表にも当てる）。Better Auth のバージョンで動くかは E2 の `auth-signup-login` で確かめる。
- **通知のまとめ**：日ごとに分けた `notifications` には、領域の文書の部分の一意の索引 `(owner_id, group_key) WHERE is_open` を張れない（分ける鍵を含まないため）。開いている行を `notification_open_groups` の主キーで 1 つにし、まとめない種類の冪等は分ける鍵 `bucket_on`（元の投稿の `tid` の日）を含めた一意にした。
- **出来事の名前**：鍵の切り替えは `accounts` の流れの `accounts.protected_changed` に揃えた（[follow-graph.md](follow-graph.md) の `graph` の流れの `account.protected_changed` を直した）。投稿の措置は `moderation.action_applied` と `post.state_changed` を同じトランザクションで書く。
- **Relay の区画**：`relay_partitions` は表にせず、Valkey の `relay:lease:{n}`（なければ勧告的ロック）にした（[infrastructure.md](infrastructure.md) の 14 節を直した）。
- **足した表**：`notification_open_groups`、`processed_events`（DB に書く消費者の重複の記録）、`post_shard_map`・`engagement_shard_map`（S2。`graph_shard_map` と同じ形）。`legal_holds` の `from`・`to` は SQL の予約語を避けて `period_from`・`period_to` にした。
- **DB のロールと S2 のクラスタ**：サービスごとの DB のロールと列の単位の書き込みの権限（[data-model.md](data-model.md) の 3.3 節）、S2 のクラスタへの表の割り当て（S1 の `main` を `core` として残す。3.12 節）を決めた。
- **S2 で同じトランザクションを保てない書き込み（推奨。S2 の着手の時に ADR で確定する）**：
  - フォローと `users.graph_version`：バージョンを関係のクラスタの表（`graph_versions(user_id, version)`、`user_id` の分割）に移す。
  - 措置と要約：`moderation_actions`・`moderation_action_events` を対象と同じクラスタ・分割に置き（投稿・メディアは `posts`、アカウントは `accounts`）、案件・通報・法令の表は `core` に残す。ADR-0038 の「同じトランザクション」を保つ。
  - 投稿と `media` の `attached`：付け先の正本を `post_media`・`dm_messages.media_id` にし、`media.state` の `attached` は出来事から冪等に書く。付ける前の確かめ（`ready` で同じ作者）は書き込みの時に読む。

持ち越し（法務、計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L11） | [intent.md](../intent.md) の「法務の確認待ち」。結論まで、そこに挙げた Story の spec を承認しない |
| fan-out の閾値、アクティブの定義、写しの形と件数、新着の窓、Worker と Valkey の 1 シャードの速さ | E5 の前の `fanout-poc` |
| 閲覧の数の取り込みの費用と誤差 | E6 の前の `view-count-poc` |
| 日本語の検索の索引の大きさ、Sudachi との比較 | E9 の前の `search-poc` |
| おすすめの候補の数と `ranking` のタスクの数（S1 の CPU が足りない見込み） | E10 の負荷試験 |
| Kinesis のシャードの分割の後、同じ鍵の連番が増え続けるか | E6 の `counter-aggregator` |
| 有害なメディアのハッシュの照合の提供者 | E11 の `media-hash-matching`（法務の L4・L7 とあわせる） |
| 「見えなくなった」の知らせ（`hidden`）を誰に送るか | E5（[clients.md](clients.md) の 4.4 節） |
| MediaConvert で 1 分の動画 p95 60 秒を守れるか、CloudFront の無効化の時間 | E7 の `video-transcode`・`media-delivery-and-takedown` |
| ElastiCache の Valkey のバージョンとノードの記憶、Global Datastore、KMS の要求のクォータ、サーバーの時計のずれ | E1 の着手の時 |
| S2 で同じトランザクションを保てない書き込み（[data-model.md](data-model.md) の 7 節。推奨は上の「データモデル」の決定） | S2 の着手の時に ADR を書く |
| 本家の振る舞いで未確認のもの（ヘルプセンターの値、6,800 万人、2012 年の講演の数値） | 公式の資料で確かめられなかった。未検証のまま、本システムの値を使う |


## 7. 領域の文書

領域の担当は、下の表の番号の範囲の中で ADR を採番する（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。「ADR」の列は起票した番号、「範囲」は割り当てた番号である。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [posts-and-ids.md](posts-and-ids.md) | 投稿の種類と行の形、書き込みの経路と冪等、重み付きの文字数、抜き出し、URL の短縮、返信とスレッド、引用とリポストの規則、返信の制限、削除と後始末、投稿の状態の写し（`ps:`）、`tid` の生成器と貸し出し、S2 の分割、下書き | 0008–0010（範囲 0008–0010） | QA | E1、E3 |
| [follow-graph.md](follow-graph.md) | フォロー・申請・ブロック・ミュートの辺とステートマシン、2 つの隣接の表、ミュートの語、閲覧者の集合の写し、数の写しと作者の方式、上限、一覧のページング、大量のフォロー・解除の信号、分割（S2・S3） | 0011–0013（範囲 0011–0013） | QA | E4 |
| [timeline-fanout.md](timeline-fanout.md) | ホームの写しの形、作者の最近の投稿（`ar:`）、振り分け役と待ち行列、瞬間のピーク（`burst`）、閾値をまたぐ作者、フォロー中の読み出しと新着の窓、作り直し（single flight）、後始末と補充、プロフィールの一覧、会話、合成監視 | 0014–0017（範囲 0014–0017） | QA、Ops | E5 |
| [ranking-and-recommendation.md](ranking-and-recommendation.md) | おすすめのパイプライン、5 つの候補の源、前と後の絞り込み、特徴の定義と写し、軽いランクと重いランク、混ぜ合わせ、代わりの並び、続きのページ（`rk:`）、理由の記録と利用者の操作、オフラインの評価と A/B、学習の基盤（S2） | 0018–0020（範囲 0018–0021） | QA、PM | E10、E19 |
| [engagement-and-counters.md](engagement-and-counters.md) | いいね・リポスト・ブックマークの関係と書き込み、数の写し（Valkey の投稿ごとのハッシュ `pc:` に、`engagement` の鍵の部分ごとの最後の連番を持って冪等に足す）、集計と書き戻し、照合、閲覧の定義と取り込みと補正、数の見せ方、殺到する投稿 | 0022–0024（範囲 0022–0024） | QA、Ops | E6 |
| [search-and-trends.md](search-and-trends.md) | 日本語の正規化と解析（N-gram と kuromoji）、問い合わせの構文と組み立て、返す前の `visible()`、索引の形・更新・作り直し、利用者の検索と補完、トレンド（語の取り出し、地域、数え方、急上昇の検出、操作への強さ、除外） | 0025–0027（範囲 0025–0028） | QA、Ops | E9 |
| [notifications.md](notifications.md) | 通知の種類と作らない条件、通知の行とまとめ、殺到の受け手、設定、プッシュ（送る直前の判定、本文を載せない形）、既読と未読の数、メールの要約 | 0029–0031（範囲 0029–0031） | QA | E8 |
| [media.md](media.md) | 分割のアップロードと状態、検査、画像・GIF・動画の変換、代替のテキスト、センシティブの印、配信の URL とキャッシュ、鍵の切り替え、措置・削除での配信の停止、有害なメディアの照合の口、保持 | 0032–0034（範囲 0032–0034） | QA、Ops | E7、E11 |
| [direct-messages.md](direct-messages.md) | 会話と参加者、`seq` の順と冪等、参加者の RLS と列の暗号化、申請と同意、ブロックとミュート、Gateway での配信と同期、DM のメディア、削除、中身を読まない迷惑の抑止、通報、エンドツーエンドの暗号化への備え | 0035–0037（範囲 0035–0037） | セキュリティ、QA | E12、E18 |
| [trust-and-safety.md](trust-and-safety.md) | 規約の区分と措置の種類、措置の記録と効かせ方、利用者への通知、通報と案件と待ち行列、作業の画面、自動の措置、異議、スパムとボット（層、規則、危険の点）、照合の一致の扱い、法令の窓口（申出、開示、法執行）、運用の状況の公表 | 0038–0041（範囲 0038–0042） | セキュリティ、PM、法務の確認 | E11 |
| [accounts-and-auth.md](accounts-and-auth.md) | 登録、ログイン、強いログイン、セッションと取り消し、連絡先の変更の保留、ログインの記録、ハンドルとプロフィール、アカウントの状態と削除、年齢の枠組み、認可の画面。`users`・`user_settings` の表の持ち主 | 0043–0044（範囲 0043–0045） | セキュリティ | E2 |
| [api-and-rate-limits.md](api-and-rate-limits.md) | 公開 API の形とバージョン、ページングとエラー、開発者とアプリ、OAuth 2.0（PKCE）とトークンの形（`<brand>_`）、レート制限（トークンバケット、画面と API の共通の桶、`RateLimit` のヘッダー）、計量とプラン、後の Webhook | 0046–0048（範囲 0046–0048） | QA、Ops | E2、E13 |
| [clients.md](clients.md) | 共通のパッケージ、Web（React、PWA）とアプリ（React Native）、データの層と手元の保存、オフライン、タイムラインの描画、投稿の作成と日本語の入力、閲覧の出来事の送り方、プッシュの受け方と深いリンク、公開の URL の HTML、アクセシビリティ | 0049–0050（範囲 0049–0050） | QA | E2〜E13 |
| [security.md](security.md) | 信頼境界と脅威モデル、端末に残るデータ、暗号化と鍵、監査と運用者のアクセス、データのライフサイクルと保全、乗っ取りへの対応、ログに出さないもの、脆弱性の管理、インシデント | 0051–0053（範囲 0051–0053） | セキュリティ | E1、E11、E14 |
| [data-model.md](data-model.md)・[data-model/](data-model/) | データモデルの正本：規約（ID、RLS、DB のロール、`visible()` に渡す列、暗号化、分割と保持、S2 のクラスタ）、全体と領域ごとの ER 図、95 表の定義、DB の外の置き場所の形、横断の不変条件 | なし（各領域の ADR を参照する） | QA | 全 Epic |
| [infrastructure.md](infrastructure.md) | AWS のアカウントとネットワーク、ホスト名と CloudFront、サービスと配置、Valkey の 4 クラスタ、Kinesis の 8 つの流れと消費者、バックアップと DR（`tid` の範囲、outbox の送り直し、`ar:` の先の作成）、段階を上げる基準、S2・S3、Terraform、コスト | 0054–0056（範囲 0054–0057） | Ops | E1、E14 |
| [observability.md](observability.md) | 中身を出さない計装、トレース、RUM、届く速さの計測（合成監視、区間、読み出しの抜き取り）、SLI の計測、出来事・写し・カウンターの指標、見える範囲の抜き取りの監査、ランキングのガードレールの指標、ダッシュボード | 0058–0059（範囲 0058–0059） | Ops | E1、E5、E10、E14 |
| [capacity.md](capacity.md) | 負荷のモデル（投稿、読み出し、fan-out、エンゲージメント、閲覧、瞬間のピーク）、部品ごとの必要量、データの量、クォータ、余裕と削る順、負荷試験 L1〜L10 | 0060（範囲 0060） | Ops | E14 |
| [delivery.md](delivery.md) | CI の関門、フラグと設定の名前空間、サーバーのデプロイの順、アプリのリリースの列車とストアの段階の配布、OTA の更新、最低のバージョン、スキーマと契約の変更の順序、ランキングの変更の出し方 | 0061–0063（範囲 0061–0063） | QA、Ops | E1、E2、E14 |

- 次に採番する ADR は 0064。統合の後に足す ADR は、関わる領域の行に番号を書き足す。

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
