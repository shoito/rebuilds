# Design log: YouTube

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-10-10：既定案

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも領域の文書の工程と E1〜E15 の PoC・試験で覆りうる。

- **変換の指揮**：自前（Rust の段のステートマシンと SQS の作業の配り）。MediaConvert・Step Functions に任せない。指揮とラダーは題材の核である（[ADR-0002](../decisions/0002-upload-and-pipeline-orchestration.md)）。
- **ラダー**：動画ごと（per-title）。複雑さの試しの符号化（区間 6 つ）と VMAF の目標で段を決める。場面ごと（per-shot）の最適化は MVP の後（[ADR-0003](../decisions/0003-codecs-and-per-title-ladder.md)）。
- **コーデック**：H.264 と AV1。VP9 は作らない。AV1 は人気のしきい値の後（[ADR-0003](../decisions/0003-codecs-and-per-title-ladder.md)）。
- **CPU と GPU**：VOD は CPU のソフトウェアの符号化（同じビットでの画質を優先）を Spot で。ライブは GPU（NVENC。遅延と密度を優先）（[ADR-0003](../decisions/0003-codecs-and-per-title-ladder.md)）。
- **音声**：AAC-LC 128 kbps（全端末）と HE-AAC 48 kbps（低い段）。Opus は MVP の後。音量の正規化（ラウドネス）は再生の側の値で持つ（transcoding-pipeline の領域）。
- **字幕**：手動の字幕（WebVTT・SRT の読み込み）と、日本語・英語の自動の字幕（VOD だけ）。ASR のエンジンは Adapter の裏で `asr-engine-poc` の後に決める（transcoding-pipeline の領域）。
- **サムネイルとチャプター**：場面の切り替えから自動の候補 3 枚、手動のサムネイル。シークの縮小の画像（スプライトと WebVTT の索引）。チャプターは説明の時刻の行から作る。自動のチャプターは MVP の後（transcoding-pipeline の領域）。
- **パッケージ**：CMAF の fMP4、レンディションごとに 1 つのファイルとバイトの範囲。HLS と DASH を要求の時に作る（[ADR-0004](../decisions/0004-cmaf-packaging-and-drm-scope.md)）。
- **ABR**：Web と Android は自前の ABR。開始は回線の推定（スループット）で、安定してからはバッファの量で決める（バッファに基づく形を主にする）。iOS は AVPlayer に任せ、マニフェストの段の上限で制御する（playback-and-abr の領域）。
- **DRM**：メンバー限定の動画だけ。公開の動画は暗号化しない（[ADR-0004](../decisions/0004-cmaf-packaging-and-drm-scope.md)）。
- **CDN**：S1 は CloudFront。S2 から複数の CDN（[ADR-0005](../decisions/0005-cdn-and-origin-strategy.md)）。
- **ライブ**：RTMPS と SRT、LL-HLS、DVR 12 時間、アーカイブは最後の 12 時間。WHIP と超低遅延は MVP の後（[ADR-0006](../decisions/0006-live-ingest-and-latency.md)）。
- **ライブチャット**：WebSocket の Gateway と Valkey での扇形の配り。大きな配信は 1 秒ごとにまとめて送り、送信の速さの上限（低速モード）と「上位のチャット」の絞り込みを持つ。チャットのリプレイは配信の時刻のずれで VOD に合わせる（live-chat の領域）。
- **視聴回数**：2 段（仮と確定）。公開の数は再生の開始で数え（本家の 2026-08-24 からの形に寄せる）、収益は 30 秒以上のエンゲージ ビューで数える（30 秒は本システムの値）（[ADR-0007](../decisions/0007-two-phase-view-counting.md)）。
- **指紋**：自前。音声の山の組、映像の知覚ハッシュ。学習した埋め込みは S2 で足す（[ADR-0008](../decisions/0008-fingerprinting-and-match-engine.md)）。
- **照合の方針の重なり**：ブロック ＞ 収益化 ＞ 追跡。収益化の一致が複数あれば、一致の区間の長さで分ける（copyright-claims-and-disputes の領域）。
- **異議**：権利者は 30 日で応える。応えなければ一致を外す（本家と同じ値と確かめた。[ADR-0048](../decisions/0048-claim-dispute-appeal-state-machine-and-deadlines.md)）。削除の申出・反論の通知の手続きは法務の L1・L2 の後（copyright-claims-and-disputes の領域）。
- **おすすめ**：自前の段のパイプライン。S1 は規則と軽いスコア、S2 から学習済みのモデル（[ADR-0010](../decisions/0010-recommendation-boundary.md)）。
- **検索**：OpenSearch（kuromoji と N-gram）。題・説明・字幕・チャンネルの名前（search の領域）。
- **広告**：MVP は外部の広告サーバー（VAST 4・VMAP）。本システムは広告の枠（再生の前・途中・後）、表示の計測、無効なトラフィックの除外（視聴の検証と同じ規則）を持つ。広告の販売と入札は持たない（monetization-and-payouts の領域）。
- **収益化**：広告の収益の分配、メンバーシップ（チャンネルの月額）、メンバー限定の動画。分配の率は契約の値として持ち、既定は本家と同じ広告 55%・メンバーシップ 70%（[ADR-0057](../decisions/0057-revenue-ledger-share-calculation-and-rounding.md)）。支払いは Stripe に似た決済の事業者の送金の機能で月ごと（monetization-and-payouts の領域。法務の L7）。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。

## 2026-10-10：統合

領域の文書の間の食い違いを、統合の工程で次のとおり解いた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。最初の設計の ADR は直接直し、決定を覆した・具体にしたところに日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。

- **AV1 の損益の計算**（[ADR-0003](../decisions/0003-codecs-and-per-title-ladder.md) の注記）：2.1 節の「10 分の動画で約 1,500 回」は、1 時間の動画の符号化の費用を 10 分の動画に当てた誤りだった。正しくは約 480 回（[ADR-0016](../decisions/0016-av1-promotion-rule-and-cost.md)）。しきい値 1,000 回は変えない。
- **NFR-002 の AV1 の 6 時間**：元のファイルが Deep Archive にある古い動画は、戻し（標準で 12 時間以内）が終わった時から数える（3 節、ADR-0016）。
- **S1 の配信のピーク**（[ADR-0069](../decisions/0069-load-model-headroom-and-load-tests.md)）：0.3 Tbps は平常のピーク。20 万人の LL-HLS の配信（0.6 Tbps）は上乗せの山とし、催しの日の全体を 0.9 Tbps と見込む。2 節の表と注に書いた。[capacity.md](capacity.md) と [infrastructure.md](infrastructure.md) の 3.3 節の「不整合」の持ち越しはこれで閉じた。
- **LL-HLS の要求と CDN の上限**（[ADR-0064](../decisions/0064-accounts-network-and-edge-distributions.md)）：低遅延の視聴者 1 人 6 件/秒、20 万人で 120 万件/秒。ディストリビューションを 3 つに分けて上限を申請する（`live` は 250 万件/秒）。[live-streaming.md](live-streaming.md) の 6.5 節の「200 万件/秒の申請」を 250 万件/秒に揃えた。
- **部分 1 秒の案**：持ち越し。`ll-hls-poc` で 1 視聴時間の要求の費用が転送の費用を超えたら、部分を 1 秒にする ADR を起票する。そのとき遅延の予算は p95 約 7.3 秒になり NFR-005（p95 6 秒）を外れるので、PM の合意が要る（下の残る未解決事項）。
- **配信の費用**（2.1 節）：公開の価格は予算の約 3.2 倍。選択肢 A〜D を数で並べ、推奨の既定を「A（約定の値引き）を主に D（バイトを減らす）を並べ、実効の単価 0.03 USD/GB を超えたら PM が D の目標か B の前倒しを決める」にした。仮の決定で、PM の判断待ち。
- **ライブのアーカイブ**（[ADR-0031](../decisions/0031-dvr-storage-and-live-to-vod.md)・[ADR-0013](../decisions/0013-original-retention-and-deletion-paths.md) の注記）：平均 400 配信を全部作り直すと、保存が 1 年で約 21 PB、変換が 1 日 約 1,500 USD 増え、2 節の 3.4 PB に入っていなかった。推奨の既定（仮、PM と Dev の判断待ち）：(a) S1 の平均の配信の数 400 を 2 節に明記した。(b) VOD のラダーの作り直しは、配信の終わりから 7 日で確定の視聴が 100 回を超えたアーカイブ、登録者 10 万以上のチャンネル、AV1 の条件に当たったものだけにする。(c) 作り直さないアーカイブは DVR の世代 1（ライブのラダー、2 秒のセグメント）をそのまま VOD にし、30 日の後に 720p・360p と音声だけに間引き、元の流れを「保持の期限」の経路で消す。保存は 1 年で約 7 PB、作り直しの変換は約 1/10 になる見込み（[capacity.md](capacity.md) の 2.3 節）。間引きは本家との意図した違いに足した（1.4 節）。
- **単位あたりの原価**（2.1 節）：変換 0.27 USD（0.20 から）、ライブの GPU 0.24 USD（0.20 から）、保存の最初の 30 日 0.11 USD（0.10 から）、90 日の後 0.028 USD に、[infrastructure.md](infrastructure.md) の 11 節と [capacity.md](capacity.md) の 6 節の値を揃えた。S1 の本番の月の原価は約 103 万 USD（±50%）。
- **NFR-009 の再生の再開**（[ADR-0066](../decisions/0066-osaka-dr-stage-up-and-multi-cdn-timing.md) の注記）：RTO 2 時間は熱い集まりで満たし、外の動画は作り直しを待つ、という解釈を NFR の表に仮として書いた。PM・QA の判断待ち。
- **領域の間の提案の採否**：
  - ライブのプレイリストに `EXT-X-PROGRAM-DATE-TIME` を入れる：**採る**。実ユーザーの遅延の推定（心拍の `lat_ms`）に要り、タグの追加は `mf` を上げる変更として出す（[ADR-0030](../decisions/0030-ll-hls-parameters-and-live-origin.md) の注記、[live-streaming.md](live-streaming.md) の 6.3 節）。
  - マニフェストの URL に `mf` を入れる：**採る**。`/t/{token}/m/{mf}/{video_id}/{caps}/...` にし、[packaging-and-drm.md](packaging-and-drm.md) の 4.4・5.3・5.4 節の URL と相対のパスを直した（[ADR-0020](../decisions/0020-manifest-generation-and-capability-classes.md) の注記、[ADR-0071](../decisions/0071-encoder-pinning-reencode-and-manifest-format-versions.md)）。
  - 見張りの再生を数に入れ、確定で除く：**採る**。仮の数の遅れを本物の経路で測るため。`view-rules` に B08（見張りの印のセッションを 1 時間と 1 日の確定で除く）を足した。収益と人気は 1 日の確定だけを使うので、見張りの再生は入らない（[ADR-0035](../decisions/0035-view-rules-catalog-and-public-count-composition.md) の注記）。
  - 熱い動画の桶を S1 から大きな催しに使う：**採る**。仕組み（`video_id#bucket`）を E7 で作り、予想の視聴が 5 万を超える予定の配信は催しの準備で前もって桶にする。1 つの消費者の処理の速さが**未検証**で、作る費用が小さいため（[ADR-0034](../decisions/0034-watch-event-envelope-and-ingest.md) の注記）。
  - 再生できるまでを 8〜12 分の動画の帯で測る：**採る**。runbooks の 1 節の SLI の定義に書いた（値は変えない）。QA の合意は残る未解決事項に置いた（[ADR-0067](../decisions/0067-sli-sources-and-computation.md)）。
  - 漏れの経路の表に「運用者の審査の画面」の行を足す：**採る**（[quality.md](../quality.md) の 2.2.1 節 G、[ADR-0063](../decisions/0063-operator-access-audit-retention-and-legal-hold.md)）。
- **1.2 節のコンテナ**：`live-origin`、`license-proxy`、`delivery-blocker`、`chat-sequencer`、`ad-decision`、`view-rules` のクレート、CloudFront のリアルタイムのログだけの Kinesis（[ADR-0001](../decisions/0001-platform-and-stack.md) の注記）を図と表に足した。
- **本家との意図した違い**（1.4 節）：ライブのアーカイブの最後の 12 時間と間引き、履歴を止めた利用者のホーム、サーバーの側の VAST の要求、所有者のいないチャンネル、支払いの口座、2 要素の必須、ASCII のハンドル、Web だけのメンバーシップ、反論の通知の既定の無効、再審査の条件、視聴回数の細部を足した。分配の率 55%・70%、異議の 30 日・7 日、strike、役割、履歴の停止は公式の資料で確かめ、未検証を外した（[intent.md](../intent.md) も直した）。
- **アップロードのチェックサム**（[ADR-0002](../decisions/0002-upload-and-pipeline-orchestration.md) の注記、[AGENTS.md](../../AGENTS.md)）：「部分ごとに `Content-MD5`」を、ADR-0011 の「CRC64NVME の全体のチェックサムを必須にし、部分の署名にチェックサムを含める形は `presigned-part-checksum-poc` で確かめる」に言い直した。
- **strike と役割の持ち主**：[accounts-and-safety.md](accounts-and-safety.md)（ADR-0059〜0061）が持つ。[copyright-claims-and-disputes.md](copyright-claims-and-disputes.md) の 8.3 節は strike を出す・外す時機だけにし、失効と効き目の行を消して 9 節へのリンクにした。[comments-and-moderation.md](comments-and-moderation.md) はリンクだけで、重なる表はない。
- **照合の索引の分片**（[ADR-0044](../decisions/0044-reference-index-shards-and-generations.md) の注記）：分片は鍵の剰余の 8 つ（論理）。S1 は 1 台に 4 つの分片を載せ、`r7g.8xlarge` 2 台 × 2 つの AZ ＋ 予備 1 にした（[capacity.md](capacity.md) の 4 節、[infrastructure.md](infrastructure.md) の 4.2 節）。「16 台級」は S2 の形とした。
- **再審査の条件**（[ADR-0048](../decisions/0048-claim-dispute-appeal-state-machine-and-deadlines.md) の注記）：「有効な違反の記録がない」を、領域の文書の「上級の機能の段にある」に揃えた（上級の段は有効な strike がないことを含む。ADR-0061）。
- **音声**：intent の MVP の「Opus」を外した（Opus は MVP の後。[ADR-0017](../decisions/0017-audio-loudness-and-asr-adapter.md)）。
- **検証の工程での直し（2026-10-10）**：公式の資料を取得し直して、次を確かめ・直した。
  - HLS：RFC 8216（2017、Informational）。LL-HLS を含む改訂は draft-pantos-hls-rfc8216bis-22（2026-05-01）で、IETF の独立の投稿の Internet-Draft（Informational を目指す。RFC ではない）。プロトコルのバージョン 13 を記す。LL-HLS のタグに要る `EXT-X-VERSION` の値は確かめた範囲になく、**未検証**のまま `ll-hls-poc` で決める。
  - CMAF（ISO/IEC 23000-19）、DASH（ISO/IEC 23009-1）、CENC `cbcs`（ISO/IEC 23001-7）：規格の本文は有料で確かめていない（**未検証**のまま）。
  - CloudFront：ディストリビューションごとに転送 150 Gbps・要求 25 万件/秒（引き上げ可。定額の料金の計画のディストリビューションには当たらない）、KeyValueStore は鍵 512 バイト・値 1 KB・1 つ 5 MB・関数に 1 つ、関数 10 KB、無効化はパスか tag で 1 秒 150 件、ステージングのディストリビューション 20、同じ VPC オリジンに 50 のディストリビューション、VPC オリジンはアカウントに 25（確認のみ）。
  - VPC オリジン：TLS のリスナーの NLB は使えない、NLB にはセキュリティグループが要る、東京は `apne1-az3` を除く（確認のみ）。
  - S3：マルチパートは 10,000 部分、1 部分 5 MiB〜5 GiB、オブジェクト 48.8 TiB、`ListParts` 1,000。全体のチェックサムは CRC64NVME・CRC32・CRC32C だけで、CRC64NVME は全体だけ（部分の合成はない）（確認のみ）。部分の署名つきの URL にチェックサムを含める形の文書の記述はなく、**未検証**のまま `presigned-part-checksum-poc` で確かめる。
  - Deep Archive の戻し：標準 12 時間以内（Batch Operations で 9〜12 時間）、大量 48 時間以内、戻しの要求は 1 秒 1,000 件、1 日 1〜2 PB（確認のみ）。
  - EC2：`g6.2xlarge`（L4 × 1、8 vCPU、32 GiB）は東京で提供されている（AWS の 2024-09 の発表）。`im4gn.4xlarge`（16 vCPU、64 GiB、7.5 TB、25 Gbps）は東京の公開の価格表に行がある。AZ ごとの提供と在庫は**未検証**で、E1 で `describe-instance-type-offerings` と ODCR の試しで確かめる。
  - 本家：分配の率 55%・70%（[Revenue shares](https://support.google.com/youtube/answer/72902)）、視聴回数を 2026-08-24 から再生の開始で数えること、12 時間を超えるライブは記録されないことがある（どの部分かは書かれていない）を確かめた。
  - 法令：情報流通プラットフォーム対処法は 2025-04-01 施行。総務省は 2025-04-30 に Google LLC の YouTube を大規模特定電気通信役務提供者に指定した。著作権法（昭和 45 年法律第 48 号）の 30 条の 4（享受を目的としない利用）と 32 条（引用）の見出しを確かめた。本システムへの当てはめは**法務の確認待ち**（L1・L8）のまま。
- **品質と運用**：
  - 各領域の文書の「テスト」「quality.md・runbooks・data-model への項目」の提案を反映した。[quality.md](../quality.md) に、性質と決定表の一覧（2.2.2 節）、漏れの経路の表の行、DR・負荷・決定性の重点、Epic の合否基準を足した。
  - runbooks の手順を、作ったもの（[incident-response.md](../runbooks/incident-response.md)、[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、[disaster-recovery.md](../runbooks/disaster-recovery.md)、[cdn-incident.md](../runbooks/cdn-incident.md)、[viral-spike.md](../runbooks/viral-spike.md)、[takedown-propagation.md](../runbooks/takedown-propagation.md)、[live-incident.md](../runbooks/live-incident.md)）と計画のものに分けて一覧にした。
  - データモデルの正本は [data-model.md](data-model.md)。全部の ER はデータモデルの工程で作った（下の「決定（2026-10-10、データモデル）」）。
  - 領域の文書が足した Story（約 50 件）を [roadmap.md](../roadmap.md) に足した。
- **数値の正本**：
  - SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。上限は各 ADR と runbooks の 2 節。
  - ラダーは [ADR-0003](../decisions/0003-codecs-and-per-title-ladder.md)（段の上限）と [ADR-0015](../decisions/0015-per-title-ladder-convex-hull.md)（選び方）、ライブのラダーは [live-streaming.md](live-streaming.md) の 6.1 節。セグメントは VOD 4 秒・GOP 2 秒・区切り 10 GOP（[ADR-0004](../decisions/0004-cmaf-packaging-and-drm-scope.md)・[ADR-0018](../decisions/0018-encode-worker-pools-and-spot-interruption.md)）、ライブは 2 秒・部分 0.5 秒（[ADR-0030](../decisions/0030-ll-hls-parameters-and-live-origin.md)）。遅延の予算は [live-streaming.md](live-streaming.md) の 6.4 節。
  - 視聴回数の層と時刻（仮 p95 60 秒、1 時間の確定は時間の終わりから 70 分、1 日の確定は翌日 JST 6:00）と規則は [ADR-0035](../decisions/0035-view-rules-catalog-and-public-count-composition.md)。
  - 指紋の母数は [ADR-0043](../decisions/0043-fingerprint-v1-hash-formats.md)〜[0045](../decisions/0045-offset-voting-verification-and-distortion-variants.md)。
  - 負荷と費用のモデルは [capacity.md](capacity.md)、単位あたりの原価は [infrastructure.md](infrastructure.md) の 11 節。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

## 2026-10-10：データモデル

データモデルの工程（[data-model.md](data-model.md) の 7 節、D-1〜D-39）のうち、アーキテクチャに関わるものを推奨の案で決めた。ADR の決定は変えていない。どれも開発リポジトリの最初の spec の前に覆りうる。

- **DB とロール**（D-1・D-4）：Aurora の DB は 1 つ（`app`）で、領域ごとの 12 のスキーマとサービスごとのロールにする。システムのロール（パイプライン、台帳、照合など）は `BYPASSRLS` を持たず、表ごとの `TO <role> USING (true)` のポリシーで全行を読む。運用者が RLS を外す役割は作らない（[ADR-0009](../decisions/0009-single-tenant-and-playable.md)、[ADR-0063](../decisions/0063-operator-access-audit-retention-and-legal-hold.md) の範囲の具体）。
- **`videos` の RLS**（D-5）：「公開の行」（`state = 'published'`）と「持ち主のチャンネル」の 2 つのポリシーにし、見える範囲の細部は `playable()` が決める。ADR-0009 の「公開の動画の情報は RLS の外、未公開の動画の情報はチャンネルの表」を 1 つの表で満たす。
- **ID の形**（D-3）：DB は `uuid`、S3・CDN・Valkey・KeyValueStore・トークンは 32 文字の 16 進（経路の形）、画面と API の URL は 22 文字の base64url（`/w/{vid}`・`/c/{cid}`・`/@{handle}`）。
- **ライブの URL**（D-30）：`/l/{video_id}/…` にする（`stream_id` でなく）。エッジのトークンの署名と拒否の鍵 `b:{video_id}` をライブにも効かせるため。[live-streaming.md](live-streaming.md) の 6.7 節を直した。
- **outbox**（D-15）：全領域で 1 つの `ops.outbox`（日の分割）。`relay` は SNS の `domain-events` に話題の属性つきで送り、消費者は `inbox_events` で重複を除く。封筒は `v` 1。
- **ファイルとトークンの形**（D-11・D-12・D-13）：指紋 `FPA1`・`FPV1`、索引の世代 `FIX1`（リトルエンディアン）と `index_generations`、再生のトークンの文字列 `v1.{kid}.{payload}.{sig}`、アクセス・更新のトークンの接頭辞 `<brand>_at_`・`<brand>_rt_`（[data-model/formats.md](data-model/formats.md)）。
- **置き場所**（D-25）：`<records-bucket>`（`kms-pii`）を足し、明細・台帳の写し・申し込みの資料・通報の証拠・法的な書き出しを置く（[infrastructure.md](infrastructure.md) の 6.1 節に行を足した）。
