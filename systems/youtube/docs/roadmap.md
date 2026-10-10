# Roadmap: YouTube

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E5 と E7 の最小の部分で、アップロード → 検査 → 速い段の符号化 → 照合（参照が空でも段は通す）→ 公開の判定 → CMAF のパッケージ → CloudFront → Web のプレイヤー → 視聴の出来事 → 仮の視聴回数を端から端まで貫き、1 本の動画が上がってブラウザで再生され、数が 1 増えるところまで作ってから、機能を広げる。全体のハッシュの後の完了、段の冪等、照合を待つ公開、`playable()`、FORCE RLS、2 段の数は、最初から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する。
  - E3 の前：動画ごとのラダー（`per-title-ladder-poc`）、AV1 の費用としきい値（`av1-cost-poc`）、ASR のエンジン（`asr-engine-poc`）。
  - E5 の前：CDN の実効の単価と、急な人気でのオリジンの負荷（`cdn-cost-poc`）。
  - E8 の前：指紋の母数と索引のメモリー（`fingerprint-poc`）。
  - E12 の前：LL-HLS の部分セグメントと端末・CDN の対応、GPU 1 枚あたりの配信の数（`ll-hls-poc`）。
- **規則は 1 つのコードに。** 段のステートマシンは `crates/pipeline`、ラダーは `crates/ladder`、パッケージは `crates/cmaf`、視聴の規則は `crates/view-rules`、指紋と照合は `crates/fingerprint`・`crates/match`、見える範囲は `packages/visibility` の `playable()` にだけ書く。
- **契約を先に固定する。** アップロードのセッションの API、段の出力のキーの作り方、`ladder_version`、セグメントの索引とマニフェストの形、再生のトークン、視聴の出来事の形と数の定義、`fp_version`、照合の方針の重なりの決定表、`playable()` の決定表、ストリームキーの形とヘッダーは、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L10）。下の表で「法務：L*」と書いた Story が当たる。
- **費用を毎週見る。** 配信 1 GB・保存 1 時間・変換 1 時間の原価を E1 から計測し、[architecture/README.md](architecture/README.md) の 2.1 節の予算と比べる。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI（Rust と TypeScript、黄金の動画の枠）、Aurora と RLS、MSK、ECS（Fargate と EC2 のプール）、S3、フラグ、自己監視、大阪の骨格 | 設計中 |
| E2 アップロードと検査 | 再開できるアップロード、検査、元のファイルの保持、パイプラインの指揮の骨格 | 未着手 |
| E3 変換 | 区切りの符号化、ラダー、H.264 と AV1、音声、字幕と ASR、サムネイル、チャプター | 未着手（前にラダー・AV1・ASR の PoC。ASR の学習の利用は法務：L8） |
| E4 パッケージと再生 | CMAF、HLS・DASH、プレイヤー（Web・Android・iOS）、ABR、QoE の計測 | 未着手（計測の外部送信は法務：L6、画面の寄せ方は法務：L9） |
| E5 配信 | CloudFront と Origin Shield、中間のキャッシュ、署名、措置での停止、急な人気への備え | 未着手（前に CDN の PoC） |
| E6 アカウント・チャンネル・登録・通知 | アカウント、年齢、創作者の確認、チャンネルと役割、登録、通知、再生リスト | 未着手（記録の保持は法務：L10） |
| E7 視聴の計測 | 出来事、仮と確定の視聴回数、総再生時間、維持率、創作者の分析 | 未着手（保持と端末の識別子は法務：L5） |
| E8 著作権 | 権利者と参照、指紋、照合、方針、所有の衝突、異議、削除の申出 | 未着手（前に指紋の PoC。削除の申出は法務：L1、異議は法務：L2） |
| E9 コメントとモデレーション | コメント、通報、モデレーションの待ち行列、措置、年齢の制限、子ども向けの印、ステマの表示 | 未着手（子ども向けは法務：L3、ステマは法務：L4、通信の秘密は法務：L6） |
| E10 検索 | 索引、日本語の解析、字幕の索引、順位、補完 | 未着手 |
| E11 おすすめと視聴の履歴 | 段のパイプライン、候補の源、スコア、個人化しない並び、履歴の停止と消去、A/B | 未着手（履歴と学習は法務：L5・L8、子ども向けは法務：L3） |
| E12 ライブ | 取り込み、GPU の変換、LL-HLS、DVR、ライブの照合、VOD、プレミア公開 | 未着手（前に LL-HLS の PoC） |
| E13 ライブチャット | Gateway、扇形の配り、低速モード、モデレーション、リプレイ | 未着手（法務：L6） |
| E14 収益化 | 収益化の条件、広告の枠、メンバーシップ、メンバー限定の DRM、台帳と分配、支払い | 未着手（法務：L7。広告の要求は法務：L5、タイアップの表示は法務：L4） |
| E15 本番の準備と GA の判定 | 負荷試験、急な人気の試験、DR の訓練、外部のペンテスト、GA の判定 | 未着手（GA の判定は法務：L1・L3・L5・L10） |
| E16 Shorts（MVP の後） | 縦の短い動画、縦のフィード、短いラダー | 未着手（MVP の後） |
| E17 超低遅延のライブとブラウザの配信（MVP の後） | WHIP・WHEP、WebRTC の配り | 未着手（MVP の後） |
| E18 ライブの拡張（MVP の後） | ライブの AV1、ライブの自動の字幕、有料のチャット | 未着手（MVP の後。有料のチャットは法務：L7） |
| E19 高度な映像（MVP の後） | HDR、360 度・VR、空間の音声、場面ごとのラダー | 未着手（MVP の後） |
| E20 指紋の拡張（MVP の後） | 学習した埋め込み（`fp_version` 2）、全動画への遡り | 未着手（MVP の後。法務：L8） |
| E21 配信の拡張（MVP の後） | 複数の CDN（S2）、ISP の中のキャッシュ（S3） | 未着手（MVP の後） |
| E22 海外の地域（MVP の後） | 地域ごとの権利、地域の CDN と DR | 未着手（MVP の後。法務：L1・L5） |

E1〜E15 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。領域の文書（[architecture/README.md](architecture/README.md) の 7 節）を書くときに、各領域の「Story の候補」で直す。

### E1 基盤

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | YouTube の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`crates/pipeline`・`ladder`・`view-rules`・`fingerprint`・`match`、`packages/visibility` はテックリード）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-network` | アカウント（本番、検証、自己監視）、SCP、VPC、egress の経路 |
| `edge-and-domains` | CloudFront、WAF、ドメイン（`<brand>.<domain>`、`api`、`<brand>video.<domain>`、`ingest`）、TLS |
| `ecs-fargate-and-ec2-pools` | Fargate のサービスと、EC2 のプール（CPU の Spot と On-Demand、GPU、NVMe）、AMI の更新の流れ（ADR-0001） |
| `terraform-root-modules` | ルートモジュールとポリシーの検査 |
| `aurora-rls-baseline` | 本人・チャンネル・権利者の RLS、`SET LOCAL`、RLS の検査、RLS の外の表の許可リスト（ADR-0009） |
| `msk-cluster-baseline` | MSK のクラスタ、`watch-events` のトピック、消費者の枠（ADR-0001） |
| `s3-buckets-baseline` | 元のファイル・レンディション・出来事のバケット、層の移し、バージョニング、SSE-KMS、大阪への CRR、削除の許可リスト |
| `ci-pipeline-baseline` | PR の関門、Rust と TypeScript、黄金の動画の枠、試験のベクトル、ファジングの夜間、テストの緩和の検出、依存の禁止の一覧（FFmpeg の LGPL の組み立ての検査を含む） |
| `flags-appconfig` | `release.*`・`ops.*` のフラグ |
| `self-monitoring-baseline` | 自己監視の別のアカウント、`canary` の骨格（見張りの動画の再生） |
| `cost-metering` | 配信 1 GB・保存 1 時間・変換 1 時間の原価の計測とダッシュボード |
| `osaka-warm-standby` | 大阪の骨格、Aurora Global Database、CRR の遅れの監視 |
| `logging-policy` | ログの欄の型の lint と本番のログの抜き取りの走査（[observability.md](architecture/observability.md) の 5 節） |
| `kms-and-secrets-baseline` | データの種類ごと・リージョンごとの KMS の鍵、署名の鍵の 30 日の回し（ADR-0062） |
| `untrusted-media-runtime` | 復号する部品の「信頼しないメディア」の実行の形と構成の検査（ADR-0062） |
| `audit-trail` | `audit_events` と Object Lock への写し（ADR-0063） |
| `retention-and-legal-hold` | `retention_policies` と `legal_holds`、保全を消去より先に効かせる（ADR-0063）。値は法務：L5・L10 |
| `operator-access` | 運用者の JIT・2 人の承認・監査（ADR-0063） |
| `deploy-and-rollback` | 部品ごとの「足してから抜く」入れ替えと自動のロールバック（ADR-0070） |

### E2 アップロードと検査

| Story | 内容 |
| --- | --- |
| `upload-sessions` | セッションの作成・部分の署名つきの URL・位置の問い合わせ・完了の条件・期限と掃除（ADR-0002） |
| `upload-clients` | Web の分割の送信と再開、iOS・Android の背景の転送 |
| `pipeline-state-machine` | `pipeline_runs`・`pipeline_tasks`、段の遷移の決定表、SQS の組と優先度、貸し出しと心拍 |
| `media-probe` | コンテナと符号化の解析、長さの上限、壊れた区間、ファジング |
| `known-illegal-media-hash` | 既知の違法なメディアのハッシュの照合の口（提供者は未定。法務：L3） |
| `original-retention` | 元のファイルの保持、層の移し、消去の 3 つの経路 |
| `video-metadata-and-visibility` | 題・説明・タグ・公開の範囲・予約の公開・下書き |
| `presigned-part-checksum-poc` | PoC：署名に `Content-MD5` と CRC64NVME を含めた部分の PUT、`FULL_OBJECT` の完了、背景の転送での URL の期限切れ（ADR-0011） |

### E3 変換

| Story | 内容 |
| --- | --- |
| `per-title-ladder-poc` | PoC：試しの符号化の区間の数、VMAF の目標、固定のラダーとの比べ |
| `av1-cost-poc` | PoC：SVT-AV1 の preset ごとの費用と VMAF、端末の AV1 の復号の割合、しきい値の損益 |
| `asr-engine-poc` | PoC：自前でホストするモデルと Amazon Transcribe の日本語の誤りの率と費用（Zoom の題材の ASR Adapter に寄せる） |
| `segment-parallel-encode` | 区切りの計画、x264 の符号化の作業者、継ぎ目の検査（ADR-0003） |
| `fast-encode-path` | 速い段（360p・720p）と、全段での置き換え |
| `per-title-ladder` | 試しの符号化と VMAF、`ladder_version` 1 |
| `av1-promotion` | 人気のしきい値の判定と `av1_encode` |
| `audio-and-loudness` | AAC-LC・HE-AAC、ラウドネスの計測（ADR-0017） |
| `manual-captions` | SRT・WebVTT の読み込みと検証、字幕のトラック |
| `auto-captions` | ASR Adapter と自動の字幕（日本語・英語、VOD）。学習の利用は法務：L8 |
| `thumbnails-and-storyboard` | 自動の候補、手動のサムネイル、シークの縮小の画像 |
| `chapters-from-description` | 説明の時刻の行からチャプター |
| `golden-media-suite` | 黄金の動画の集まりと VMAF の下限（quality.md の 2.2.1 節 A） |
| `enc-build-pinning` | `enc_build` の固定と設定のハッシュ（ADR-0071） |
| `reencode-campaigns` | 作り直しの対象の選び方と Deep Archive の戻しの量の制御（ADR-0071） |
| `live-archive-reencode` | ライブのアーカイブの作り直しの条件と、作り直さないアーカイブの段の間引き（ADR-0031 の 2026-10-10 の注記） |

### E4 パッケージと再生

| Story | 内容 |
| --- | --- |
| `cmaf-writer-and-index` | レンディションの fMP4 とセグメントの索引（ADR-0004） |
| `manifest-service` | HLS・DASH の生成、端末ごとの段、字幕のトラック |
| `playback-api-and-token` | 再生の API、`playable()` の呼び出し、再生のトークン、署名つきの URL |
| `web-player` | MSE のプレイヤー、操作、字幕、縮小の画像。画面の寄せ方は法務：L9 |
| `abr-algorithm` | 開始の段の選び方、バッファに基づく ABR（Web と Android で共有の判断の部分） |
| `abr-sim` | ABR の模擬とネットワークの記録（quality.md の 2.2.1 節 B） |
| `android-player` | Media3 と自前の ABR |
| `ios-player` | AVPlayer と HLS、段の上限の制御 |
| `qoe-telemetry` | 開始の時間・再バッファ・段の切り替えの出来事と集計。外部送信の公表は法務：L6 |
| `manifest-format-versions` | マニフェストの URL の `mf` と 2 つ前までの生成（ADR-0071） |
| `player-rollout` | Web のプレイヤーの段の配布と、アプリの `min_supported`（ADR-0070） |

### E5 配信

| Story | 内容 |
| --- | --- |
| `cdn-cost-poc` | PoC：CDN の実効の単価、急な人気でのオリジンの負荷 |
| `cloudfront-and-shield` | CloudFront、Origin Shield、キャッシュの規則（ADR-0005） |
| `origin-cache` | 範囲の読み出し、NVMe のキャッシュ、要求の合流 |
| `signed-delivery` | パスの頭のエッジのトークン、HMAC の鍵の回し（ADR-0025） |
| `delivery-block-list` | 拒否の一覧（エッジの関数）、無効化、60 秒の停止（NFR-014） |
| `viral-prewarm` | 急な人気の兆しでの事前の配置 |
| `edge-function-staging` | エッジの関数をステージングのディストリビューションで確かめてから出す |
| `cdn-logs` | CDN のリアルタイムのログと標準のログ（ADR-0067・0068） |
| `canary-probes` | 見張りの端末と見張りの措置 |
| `token-abuse-detection` | 悪用のトークンの検出と `t:` の拒否（ADR-0062） |
| `cdn-commit-negotiation` | CloudFront の約定の値引きの見積もりと判断（2.1 節の配信の費用の決定。PM の判断待ち） |

### E6 アカウント・チャンネル・登録・通知

| Story | 内容 |
| --- | --- |
| `accounts-and-auth` | アカウント、認証、年齢の入力。記録の保持は法務：L10 |
| `creator-verification` | 15 分を超える動画のアップロードのための確認 |
| `channels-and-roles` | チャンネル、ハンドル、7 つの役割と `can()`（ADR-0059） |
| `subscriptions` | 登録と登録の一覧 |
| `notifications` | 新しい動画とライブの通知（プッシュ・メール）、まとめ、扇形の配り |
| `playlists` | 再生リスト、後で見る |
| `account-recovery-and-takeover` | 回復と乗っ取りへの対応（ADR-0060） |
| `channel-handles` | ハンドル（ADR-0053） |
| `subscription-feed` | 登録のフィード（ADR-0053） |
| `push-devices` | プッシュの端末の登録 |

### E7 視聴の計測

| Story | 内容 |
| --- | --- |
| `watch-event-collector` | 出来事の形、署名、MSK への書き込み（ADR-0007）。IP の保持は法務：L5 |
| `view-rules-crate` | `view-rules` の流れの規則と集団の規則、規則の ID とバージョン |
| `provisional-view-counts` | `view-validator` と Valkey の仮の数 |
| `verified-view-counts` | Parquet の表、`view-verifier` の 1 時間・1 日のバッチ、`view_adjustments` |
| `watch-time-and-retention` | 総再生時間、維持率、エンゲージ ビュー |
| `creator-analytics` | 創作者の分析の画面と API |
| `view-fraud-sim` | 不正の場面の生成器と合否（quality.md の 2.2.1 節 C） |

### E8 著作権

| Story | 内容 |
| --- | --- |
| `fingerprint-poc` | PoC：音声の山の密度、映像のハッシュの間隔、索引のメモリー、歪めた参照での再現率 |
| `rights-owner-onboarding` | 権利者の審査と登録、権利者の RLS |
| `reference-ingest` | 参照のアップロード、指紋、索引への追加、所有の衝突 |
| `audio-fingerprint-v1` | 音声の指紋（ADR-0008） |
| `video-fingerprint-v1` | 映像の指紋（ADR-0008） |
| `match-engine` | 索引のシャードと写し、投票、確かめ、一致の区間 |
| `publish-gate` | 照合の結果を条件にした公開の判定 |
| `match-policies` | 方針（ブロック・収益化・追跡、地域）、重なりの決定表 |
| `claims-and-disputes` | 一致の通知、異議と再審査（30 日）。手続きの文言は法務：L2 |
| `takedown-requests` | 削除の申出の受付と通知、侵害の繰り返し。法務：L1 |
| `reference-backscan` | 新しい参照の遡り（90 日と人気の動画） |
| `fp-bench` | 歪めた参照の集まりと合否（quality.md の 2.2.1 節 D） |
| `claim-revenue-split` | 照合の収益の 1 秒ごとの分け方と預かり（ADR-0047） |
| `counter-notices-and-strikes` | 反論の通知と著作権の strike を出す時機（ADR-0049）。法務：L1・L2 |
| `rights-abuse-monitoring` | 権利者と創作者の濫用の監視 |

### E9 コメントとモデレーション

| Story | 内容 |
| --- | --- |
| `comments` | コメント、返信、高評価、並べ方、保留 |
| `reports-and-moderation-queue` | 通報、モデレーションの待ち行列、措置の記録と通知。削除の基準の公表は法務：L1 |
| `age-restriction` | 年齢の制限と確かめ、`playable()` の行 |
| `made-for-kids-flag` | 子ども向けの印と、コメント・通知・個人化の停止。法務：L3 |
| `paid-promotion-disclosure` | タイアップの申告の欄と視聴の画面の表示。法務：L4 |
| `comment-posting-and-hold` | 投稿の判定と保留（ADR-0051）。法務：L6 |
| `creator-comment-tools` | 創作者のコメントの道具 |
| `moderation-actions` | 措置の記録と効かせ方（ADR-0052） |
| `strikes-and-standing` | 警告・strike・アカウントの状態（ADR-0061）。法務：L1 |
| `age-and-supervision` | 年齢の帯と見守りのアカウント。法務：L3 |
| `quarantine-account-handling` | 既知の違法なメディアに一致したときのアカウントの扱い。法務：L3・L10 |

### E10 検索

| Story | 内容 |
| --- | --- |
| `search-index` | OpenSearch の索引、outbox からの更新、字幕の索引 |
| `japanese-analysis` | kuromoji と N-gram、正規化（X の題材の形に寄せる） |
| `search-ranking-and-filter` | 順位、`playable()` での絞り込み、候補の補完 |
| `search-eval-set` | 日本語の検索の評価の集まり |
| `search-poc` | PoC：索引の大きさ、字幕の区切り、応答の時間 |
| `search-suggest` | 候補の補完（ADR-0042）。法務：L5 |

### E11 おすすめと視聴の履歴

| Story | 内容 |
| --- | --- |
| `watch-history` | 視聴の履歴、止める・消す（24 時間で特徴から消す）。法務：L5 |
| `recs-pipeline-skeleton` | 段の口、時間の予算、代わりの並び、理由の記録（ADR-0010） |
| `candidate-sources-s1` | 登録、続き、共起、人気、検索の源 |
| `scoring-s1` | 手で決めた式、AppConfig の重み |
| `non-personalized-feed` | 個人化しない並び（子ども向け、履歴の停止、匿名）。法務：L3 |
| `recs-offline-eval-and-ab` | オフラインの評価と A/B、ガードレール |
| `covisitation-batch` | 共起の毎日の作成（ADR-0038） |
| `mixer` | 混ぜ合わせの規則（ADR-0039） |

### E12 ライブ

| Story | 内容 |
| --- | --- |
| `ll-hls-poc` | PoC：部分セグメント、要求の保留、端末と CDN の対応、GPU 1 枚あたりの配信の数 |
| `stream-keys` | ストリームキーの形、ハッシュでの保存、失効 |
| `live-ingest` | RTMPS・SRT の受け口、予備の取り込み（ADR-0006） |
| `live-transcoder` | GPU の割り当てと予備、ライブのラダー |
| `ll-hls-and-dash-live` | LL-HLS と低遅延の DASH、通常のモード |
| `dvr-and-archive` | DVR の窓、ライブからの VOD、元の流れの保存 |
| `live-matching` | 30 秒の窓の照合と差し替え |
| `premieres` | 予約の公開を配信のように見せるプレミア公開 |
| `live-latency-tests` | 時刻の焼き込みの見張り（quality.md の 2.2.1 節 E） |
| `live-distribution-quota` | `live` のディストリビューションの上限の申請と分割の手順（ADR-0064） |
| `live-deploy-without-interruption` | 配信を切らない `live-transcoder`・`live-origin`・`live-ingest` の入れ替え（ADR-0070） |
| `live-latency-telemetry` | 心拍の `lat_ms` と `EXT-X-PROGRAM-DATE-TIME`（ADR-0067） |
| `ll-hls-abr` | 低遅延のライブの ABR（ADR-0022） |
| `stream-key-protection` | ストリームキーの漏えいの検出と失効（ADR-0062） |

### E13 ライブチャット

| Story | 内容 |
| --- | --- |
| `chat-gateway` | WebSocket の Gateway、配信ごとの購読、Valkey の扇形の配り（Slack の題材の形を参考にする） |
| `chat-batching-and-top-chat` | 大きな配信のまとめての送信、上位のチャット |
| `chat-moderation` | 低速モード、モデレーター、ブロックの語、利用者のタイムアウト。法務：L6 |
| `chat-replay` | 配信の時刻のずれでのリプレイ |
| `chat-load-tests` | 20 万人の配信の負荷（quality.md の 2.2.1 節 H） |
| `chat-sequencer` | 配信ごとの順番付け（ADR-0032） |

### E14 収益化

| Story | 内容 |
| --- | --- |
| `monetization-eligibility` | 収益化の条件（確定の数で判定） |
| `ad-slots-and-vast` | 広告の枠、VMAP、外部の広告サーバーへの VAST の要求、表示の計測、無効なトラフィックの除外。要求に入れる情報は法務：L5 |
| `memberships` | チャンネルのメンバーシップ、決済の事業者の連携。法務：L7 |
| `members-only-drm` | メンバー限定の動画の DRM、ライセンスの事業者の口（ADR-0004） |
| `revenue-ledger` | 台帳、収益の分配の計算、照合の収益の分け方、調整の行 |
| `creator-payouts` | 月ごとの支払い、明細、税の情報（Stripe の題材の形を参考にする）。法務：L7 |
| `drm-provider-poc` | PoC：`cbcs` の細部、鍵を要求ごとに渡す形、端末の試験 |
| `drm-packaging-and-license-proxy` | DRM のパッケージと `license-proxy`（ADR-0021） |
| `client-side-ads` | プレイヤーの広告の挿入（ADR-0024） |

### E15 本番の準備と GA の判定

| Story | 内容 |
| --- | --- |
| `load-tests` | アップロード・符号化・配信・出来事・照合の負荷試験（S1 のピークの 2 倍） |
| `viral-spike-tests` | 急な人気と大きなライブの試験（quality.md の 2.2.1 節 H） |
| `dr-failover-drill` | 大阪への切り替えの訓練、元のファイルの写しからの再生の再開 |
| `pentest-external` | 外部のペンテスト（アップロード、再生の API、署名、DRM、ストリームキー、RLS） |
| `slo-dashboards-alerts` | SLO とアラート（[runbooks/README.md](runbooks/README.md)） |
| `runbooks-e15` | 個別の手順の作成と確認 |
| `ga-readiness` | GA の判定。法務：L1・L3・L5・L10 |
| `event-capacity-plan` | 大きな催しの 2 週間前の確認（ADR-0069） |
| `dr-hot-set` | 熱い集まりの選び方と大阪への写し（ADR-0066） |
| `legal-request-workflow` | 開示の請求と照会の手順。法務：L10 |

### S2 の前の PoC

| Story | 内容 |
| --- | --- |
| `multi-cdn-poc` | 2 つ目の CDN のトークン・拒否の一覧・リアルタイムのログ、オリジンの形（ADR-0066） |
| `osaka-upload-poc` | 大阪でアップロードを受けるか |
| `dr-replication-poc` | S2 の量の元のファイルの写しの転送 |
| `encoder-arch-poc` | Graviton の符号化の VMAF と決定性 |

## エージェントに任せないこと

- **契約（アップロードのセッションの API、段の出力のキー、`ladder_version`、セグメントの索引とマニフェストの形、再生のトークン、視聴の出来事と数の定義、`fp_version`、方針の重なりの決定表、`playable()` の決定表、ストリームキーの形）の確定**：配ったクライアント・保存した動画・数・権利の判定に影響し、後から変えるコストが最も高い。
- **黄金の動画の VMAF の下限・不正の場面の合否・歪めた参照の合否の期待する値の変更**：QA が判断する。
- **AV1 のしきい値、配信の単価の前提、CDN の振り分けの重みの変更**：Dev のテックリードと Ops と PM が判断する。
- **措置・照合の方針の手動の上書き、権利者の審査、所有の衝突の解決**：運営の担当と法務。
- **元のファイルの手動の削除、保持の期間の短縮**：Dev のテックリードと Ops。
- **大阪への切り替えの判断**：IC と Ops の責任者。
- **削除の申出・開示の請求・捜査機関からの照会への応答**：法務と Ops。
- **法務の判断**（L1〜L10）。
- **PoC の結果の解釈**：数字は出せるが、ラダー・コーデック・エンジン・CDN の採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E16〜E22 に入れなかったもの。着手するときに `intent.md` から起票する。

- **レンタル・購入の動画**（法務の L7）。
- **自動の吹き替え、自動のチャプター**（MVP の ASR の質を確かめてから）。
- **Opus の音声と空間の音声**。
- **VP9 のラダー**（`av1-cost-poc` で、AV1 を復号できず VP9 を復号できる端末が多いと分かったときだけ。[ADR-0003](decisions/0003-codecs-and-per-title-ladder.md)）。
- **広告の販売と入札**（外部の広告サーバーに任せる）。
- **子ども向けの別のアプリ**（法務の L3）。
- **簡単な編集（切り抜き、ぼかし）**。
