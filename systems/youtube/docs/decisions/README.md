# Decisions: YouTube

YouTube の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 管理の面は共通の基盤を引き継ぎ、メディアの面と視聴の計測は Rust で書く。メディアの面は ECS の EC2（CPU の Spot、GPU、NVMe）で動かし、視聴の出来事は MSK に流す | accepted |
| [0002](0002-upload-and-pipeline-orchestration.md) | アップロードは S3 のマルチパートの上の自前の再開できるセッションにし、全体のハッシュが合ってから完了を返す。パイプラインは自前の段のステートマシンで、段は冪等にし、元のファイルを保持する | accepted |
| [0003](0003-codecs-and-per-title-ladder.md) | H.264 を全動画に、AV1 を人気の動画にだけ作り、VP9 は作らない。ラダーは試しの符号化と VMAF で動画ごとに決める。VOD は CPU の Spot、ライブは GPU で符号化し、MediaConvert は使わない | accepted |
| [0004](0004-cmaf-packaging-and-drm-scope.md) | CMAF の fMP4 で 1 回だけ保存し、HLS と DASH のマニフェストを要求の時に作る。VOD のセグメントは 4 秒。DRM はメンバー限定の動画だけにし、CENC の `cbcs` で暗号化する | accepted |
| [0005](0005-cdn-and-origin-strategy.md) | S1 は CloudFront と Origin Shield と自前の中間のキャッシュで配り、S2 から複数の CDN と計測による振り分けを足す。セグメントは署名つきの URL で、措置は拒否の一覧で 60 秒以内に止める | accepted |
| [0006](0006-live-ingest-and-latency.md) | ライブの取り込みは RTMPS と SRT にし、GPU で H.264 のラダーに変換する。低遅延は LL-HLS（部分 0.5 秒、p95 6 秒）、通常は 2 秒のセグメント。DVR は 12 時間で、同じセグメントから VOD を作る | accepted |
| [0007](0007-two-phase-view-counting.md) | 視聴回数は、流れの中の仮の数と、Parquet のバッチで確かめる確定の数の 2 段で出す。検証の規則は 1 つのクレートに置く。公開の数は再生の開始で数え、収益はエンゲージ ビュー（30 秒）で数える | accepted |
| [0008](0008-fingerprinting-and-match-engine.md) | 指紋は自前で作る。音声は対数周波数の山の組のハッシュ、映像は 1 秒 2 枚のフレームの知覚ハッシュにし、転置の索引と時刻のずれの投票で照合する。照合の結果が出るまで動画を公開しない | accepted |
| [0009](0009-single-tenant-and-playable.md) | テナントは 1 つ。本人だけの表は FORCE RLS、チャンネル・権利者の管理の表は持ち主の RLS にする。動画の見える範囲は `playable(viewer, video, region)` の 1 つの関数で決める | accepted |
| [0010](0010-recommendation-boundary.md) | おすすめは自前の段のパイプラインにし、ML は候補の取り出しとスコアだけに使う。見える範囲・年齢・子ども向け・照合・措置の判定を上書きしない | accepted |
| [0011](0011-upload-session-protocol-and-checksums.md) | 部分の大きさは 8・16・32・64 MiB から部分の数が 10,000 以下になる値を選ぶ。マルチパートは CRC64NVME の全体のチェックサムで作り、部分ごとに `Content-MD5` と CRC64NVME を署名に含めて S3 に確かめさせる。任意の SHA-256 は完了の前に読み直して確かめる | accepted |
| [0012](0012-media-probe-and-admission-checks.md) | 検査はネットワークを持たない隔離した作業者で、時間とメモリーの上限を付けて行う。壊れた区間は合計 1% 以下・1 か所 10 秒以下なら除いて進める。既知の違法なメディアの照合は差し替えられる口の後ろに置き、結果が出るまで先へ進めない | accepted |
| [0013](0013-original-retention-and-deletion-paths.md) | 元のファイルの消去は `original-deleter` の役割だけが行い、IAM の拒否と S3 のバージョンの管理（30 日）で他の経路を塞ぐ。創作者の削除は 30 日の猶予の後に、東京と大阪の両方で全バージョンを消す | accepted |
| [0014](0014-pipeline-task-leases-and-idempotent-outputs.md) | 段の作業は Aurora の行の貸し出し（120 秒、30 秒ごとの心拍）で受ける。出力は決まったキーへ `If-None-Match: *` で書き、412 なら置かれたものを採る。確定は貸し出しの印を条件にした `UPDATE` で 1 回だけにし、やり直しは 5 回まで | accepted |
| [0015](0015-per-title-ladder-convex-hull.md) | `ladder_version` 1 のラダーは、場面の切り替えで選んだ 10 秒の区間 6 つを、5 つの解像度 × 6 つの CRF で試しに符号化し、VMAF の凸包から上の段から順に選ぶ | accepted |
| [0016](0016-av1-promotion-rule-and-cost.md) | AV1 は ADR-0003 の 4 つの条件で作り、1 時間を超える動画には「7 日の確定の総再生時間が損益の分かれ目の半分以上」を足す。元のファイルが Deep Archive にあれば戻してから作り、6 時間の目標は戻しの後から数える | accepted |
| [0017](0017-audio-loudness-and-asr-adapter.md) | 音声は区切らずにトラックの全体を 1 回で符号化し、ラウドネスは測って再生の側で -14 LUFS へ下げるだけにする。自動の字幕は `AsrEngine` の口の後ろに置き、既定の案は GPU で自前でホストする公開の重みのモデルにする | accepted |
| [0018](0018-encode-worker-pools-and-spot-interruption.md) | 符号化の作業者のプールを急ぎ・通常・後ろの 3 つに分け、急ぎは On-Demand の下限と Spot、他は複数の型の Spot にする。区切りは 10 GOP（約 20 秒）、5 分未満の動画は 4 GOP。Spot の中断の通知で貸し出しをすぐ返す | accepted |
| [0019](0019-cmaf-files-segment-index-and-url-layout.md) | レンディションの fMP4 は `init` とセグメントを連ねた 1 つのファイルにし、索引 `SIX1`（32 バイトの頭と 1 セグメント 16 バイト）を別に置く。URL は `/v/{video_id}/{gen}/{rendition}/{seq}.m4s` で中身を変えず、作り直しは世代を上げる | accepted |
| [0020](0020-manifest-generation-and-capability-classes.md) | マニフェストは端末の対応を「能力の組」（コーデック × 段の上限 × DRM、形式ごと）に丸め、組ごとに CDN でキャッシュする。段の帯域の値はセグメントの索引から計算する | accepted |
| [0021](0021-drm-key-hierarchy-and-license-proxy.md) | メンバー限定の動画は 2 つの内容の鍵（音声と 1080p まで、1440p 以上）を持ち、KMS で包んで Aurora に置く。ライセンスは自前の `license-proxy` が再生のトークンと `playable()` を確かめてから事業者に求め、鍵は要求ごとに渡す。ライセンスの期限は 6 時間で、持ち出しはない | accepted |
| [0022](0022-buffer-based-abr.md) | Web と Android の ABR は、開始の間は回線の推定、その後はバッファの量の写像（貯め 8 秒、緩め 32 秒）で段を選ぶ。バッファ 12 秒未満では推定で頭を抑え、間に合わない取得は捨てて下の段で取り直す。低遅延のライブは回線の推定と再生の速さの調整で選ぶ | accepted |
| [0023](0023-playback-token-and-qoe-metrics.md) | 再生の API は Ed25519 の再生のトークン（10 時間）と HMAC のエッジのトークン（6 時間）を返す。QoE は `play_intent` から `first_frame` までを開始の時間とし、再バッファの割合は開始とシークの待ちを除いて数え、出来事は `watch-events` に載せる | accepted |
| [0024](0024-client-side-ad-insertion.md) | 広告はクライアントの側で挿入する。プレイヤーが VMAP と VAST を読み、広告を本編と別に再生する。サーバーの側の挿入（SSAI）は MVP で作らない | accepted |
| [0025](0025-edge-token-signing-and-cache-keys.md) | エッジのトークンをパスの頭（`/t/{kid}.{exp}.{caps}.{rg}.{sig}/`）に置き、エッジの関数が確かめてから取り除いてキャッシュの鍵にする。HMAC の鍵は KeyValueStore に 2 つ並べて置き、セグメントは 1 年、VOD のマニフェストは 1 時間キャッシュする | accepted |
| [0026](0026-origin-cache-routing-admission-and-coalescing.md) | `origin-cache` は AZ ごとの rendezvous のハッシュの輪にし、AZ をまたがない。NVMe に入れるのは 24 時間に 2 回目の要求と、動画の最初の 3 セグメントとライブ。同じ鍵の同時の外れは 1 つの S3 の読み出しにまとめる | accepted |
| [0027](0027-takedown-deny-list-within-60s.md) | 措置は outbox から `delivery-blocker` が、KeyValueStore の拒否の鍵、`playable()` の写し、`origin-cache` の拒否の集まり、cache tag の無効化の 4 つを並べて効かせる。拒否の鍵は 7 日で外し、決定から新しい配信の 403 まで p99 30 秒、上限 60 秒にする | accepted |
| [0028](0028-live-ingest-keys-backup-and-source-recording.md) | ストリームキーは `<brand>_sk_`＋32 文字の乱数＋6 文字のチェックサムで、SHA-256 だけを持つ。主と予備の取り込みを同じキーで受け、主の映像が 1.5 秒止まったら予備へ移す。`live-ingest` は入力を 10 秒ぶんメモリーに持ち、元の流れを 10 秒ごとに S3 へ書く | accepted |
| [0029](0029-live-transcoder-placement-and-standby.md) | ライブの変換は GPU のプールに配信を詰めて置き、AZ ごとに空きを「GPU 2 枚か 10% の大きいほう」持つ。予想の視聴が 1 万を超える配信には別の AZ に同時に動く予備を置く。セグメントの番号と IDR の位置は入力の時刻から決める | accepted |
| [0030](0030-ll-hls-parameters-and-live-origin.md) | LL-HLS は `PART-TARGET` 0.5（端数のあるフレームレートは 0.501）、`PART-HOLD-BACK` 1.5、`HOLD-BACK` 6、`CAN-SKIP-UNTIL` 12 にする。プレイリストと部分は `live-origin` がメモリーの直近 60 秒から返し、要求の保留は最大 6 秒、配信ごとに 2 つの AZ に写しを持つ | accepted |
| [0031](0031-dvr-storage-and-live-to-vod.md) | DVR はレンディションごとに 10 秒（5 セグメント）を 1 つのオブジェクトにまとめて S3 に書き、接頭辞を配信の ID のハッシュで散らす。配信の終わりに DVR の索引を閉じてそのまま VOD にし、元の流れから VOD のラダーを作って世代を上げる。アーカイブは最後の 12 時間にする | accepted |
| [0032](0032-chat-sequencer-and-batched-fanout.md) | チャットの送信は検査の後に MSK の `chat-in` に書き、配信ごとに 1 つの順番付けが番号を振る。1,000 人以上の配信は 1 秒、それ未満は 250 ms ごとにまとめ、Valkey の sharded pub/sub で Gateway のノードへ 1 回だけ送る。視聴者に送るのは 1 秒 20 件（上位は 8 件）までで、配りはベストエフォートにする | accepted |
| [0033](0033-chat-rate-limits-slow-mode-and-moderation.md) | チャットの送信は、利用者ごとのトークンの桶（1 秒 1 件、3 件まで）、低速モード（1〜300 秒）、30 秒の重複の拒否、200 文字で抑え、受け付けが 1 秒 1,000 件を 30 秒続けたら低速モード 5 秒を自動で入れる。ブロックの語とリンクは保留にしてモデレーターに見せ、リプレイの時刻は送り手の申告した遅れで合わせる | accepted |
| [0034](0034-watch-event-envelope-and-ingest.md) | 視聴の出来事は `(sid, seq)` を重複の鍵にした封筒で送り、`event-collector` が署名を確かめて IP アドレスを粗くしてから MSK に書く。分割の鍵は `video_id` で、熱い動画だけ視聴者の桶を足す | accepted |
| [0035](0035-view-rules-catalog-and-public-count-composition.md) | `view-rules` は流れの規則（S 系）と集団の規則（B 系）を ID とバージョンで持つ。判定は「仮 → 1 時間の確定 → 1 日の確定」の 3 層にし、公開の数は 3 つの層の時間で重ならない和にする。層の差は理由のコードつきで記録する | accepted |
| [0036](0036-watch-time-retention-and-analytics-store.md) | 総再生時間は再生した区間の和集合の長さ、維持率は最大 200 の桶の覆いで数える。分析は、動画×日の合計とチャンネル×日の切り口を Aurora に置き、動画の切り口の細部と任意の期間は Iceberg を DataFusion で引く | accepted |
| [0038](0038-candidate-sources-covisitation-and-two-stage-ranking.md) | おすすめの候補の源は登録・続き・共起・人気・検索の 5 つにし、共起は 28 日の確定のエンゲージ ビューから余弦の値で作る。並べ方は軽いランク（2,000 → 300）と重いランク（S1 は手の式）の 2 段にする | accepted |
| [0039](0039-diversity-mixer-history-controls-and-non-personalized-feed.md) | おすすめの混ぜ合わせは、同じチャンネル 2 件・同じカテゴリ 6 件・60 分を超える動画 5 件・新しい創作者の枠 1 件の規則で 20 件を作る。視聴の履歴の消去は 24 時間以内に特徴と候補から消し、子ども向けの視聴・履歴の停止・ログインなしでは個人化しない源だけにする | accepted |
| [0041](0041-search-index-layout-and-caption-chunks.md) | 検索の索引は動画・字幕の区切り・チャンネル・候補の補完の 4 つにし、字幕は 30 秒（前の 3 秒を重ねる）の区切りごとの文書にする。一致の判定は N-gram、関連度は kuromoji で付け、正規化は X の題材と同じ関数を使う | accepted |
| [0042](0042-search-query-builder-ranking-and-suggest.md) | 検索の問い合わせは `buildVideoSearch` の 1 か所で作り、動画と字幕の索引を並べて引いて上位 200 を合わせ、`playable()` を通してから並べ直す。候補の補完は 7 日に 20 人以上が検索した語だけを、読みの前方一致で出す | accepted |
| [0043](0043-fingerprint-v1-hash-formats.md) | `fp_version` 1 の音声のハッシュは 1/4 半音の帯で（錨の帯、帯の差、時刻の差）を 32 ビットの語の上位 21 ビットに詰め、問い合わせの側は山を 1.5 倍に取る。映像は情報の少ないフレームを捨て、参照は続く似たフレームを 1 つにまとめる | accepted |
| [0044](0044-reference-index-shards-and-generations.md) | 参照の索引は鍵の剰余で 8 つの分片に分けて 2 つの AZ に写し、正本は S3 の世代の写しにする。追加は差分の索引に入れて 6 時間ごとにまとめ、全分片の答えがそろわない照合は結果を出さない | accepted |
| [0045](0045-offset-voting-verification-and-distortion-variants.md) | 照合は 10 秒の窓で（参照、時刻のずれ）の票を数え、音声 12 票・映像 6 票を超えた組を、1 秒ごとの一致の割合の区間で確かめる。ピッチと速さの歪みは、問い合わせのハッシュの 20% で 22 の変種を引く 2 回目の探しで受ける | accepted |
| [0046](0046-reference-ingestion-ownership-conflicts-and-backscan.md) | 参照は同じパイプラインで指紋を作り、長さ・汎用の素材・同じ権利者・他の権利者の検査を経て有効にする。所有の衝突は権利の地域が重なるときだけにし、新しい参照の遡りは 1 時間ごとにまとめて、公開から 90 日の動画と視聴の多い動画に当てる | accepted |
| [0047](0047-claim-policies-territory-overlap-and-per-second-split.md) | 照合の方針は地域ごとに最初に当たる規則の列にし、動画の地域ごとの結果は決定表（衝突 → 許可 → ブロック → 収益化 → 追跡）で 1 つにする。収益化の一致は動画の 1 秒ごとに覆う権利者で等しく分け、異議の間の分け前は預かりの勘定に入れる | accepted |
| [0048](0048-claim-dispute-appeal-state-machine-and-deadlines.md) | 申し立ては `active → disputed → reinstated → appealed` のステートマシンで持ち、権利者の応答の期限を異議 30 日・再審査 7 日にする。ブロックの申し立ては異議を飛ばして再審査に進め、期限は遷移の時刻に絶対の時刻で書いて 1 分ごとの作業で進める | accepted |
| [0049](0049-takedown-cases-counter-notice-and-strikes.md) | 削除の申出は `copyright_cases` で受け、期限・基準・通知の文は AppConfig の `legal.copyright.*` に置く。反論の通知と復元は設定で切り替えられる形で作って既定は無効にし、著作権の strike は削除した動画ごとに 1 つ出すよう accounts-and-safety の領域に頼む | accepted |
| [0050](0050-comment-threads-storage-and-ranking.md) | コメントは最上位と返信の 2 段の木にし、Aurora の `comments` を `video_id` のハッシュで 16 に分ける。「評価順」は高評価・返信した人・創作者のハートと経過時間の式で付け、上位 2,000 の候補を Valkey に持つ | accepted |
| [0051](0051-comment-posting-pipeline-spam-and-hold.md) | コメントの投稿は、上限 → 創作者の設定 → スパムの点 → 有害さの点 → 保留の段階の順に同期で判定し、結果を「公開・保留・スパムの疑い・作者だけに見える」の 4 つにする。保留とスパムの疑いは 60 日で消す | accepted |
| [0052](0052-moderation-actions-age-kids-and-promotion.md) | 措置は追記だけの `moderation_actions` に書いてから、対象の措置の要約を同じトランザクションで変えて outbox で配る。年齢の制限は `playable()` の `allow_with: age_check`、子ども向けの印はコメント・通知・個人化・広告・ライブチャットを止め、タイアップは創作者の申告と表示の枠だけを作る | accepted |
| [0053](0053-handles-and-subscription-tables.md) | ハンドルは ASCII の 3〜30 文字にして正規化した値で一意にし、登録は本人の表 `subscriptions` と扇形の配りの専用の表 `channel_subscribers` の 2 つに同じトランザクションで書く。登録のフィードは読み出しの時にチャンネルの最近の動画の写しを合わせる | accepted |
| [0054](0054-notification-fanout-pacing-and-coalescing.md) | 通知は 1,000 人のページの作業に分けて、登録者 1 万未満と以上で待ち行列を分ける。「おすすめ」の段階は親しさの集合で絞り、プッシュは利用者ごとに 10 分に 1 回にまとめ、大きなチャンネルは 1 秒 2,000 人に均して送る。登録者 10 万を超えるチャンネルのお知らせの一覧は読み出しで合わせる | accepted |
| [0055](0055-ad-decision-vmap-and-server-side-ad-request.md) | 広告の判断の口 `ad-decision` が VMAP を作り、各枠の VAST は `ad-decision` が外部の広告サーバーへ代わりに要求する。MVP の要求は文脈の値だけにし、表示ごとの `imp_id` で広告サーバーの請求と本システムの有効な表示を突き合わせる | accepted |
| [0056](0056-channel-memberships-via-payment-provider.md) | チャンネルのメンバーシップは決済の事業者の定期の課金で受け、MVP は Web だけで売る。会員の状態は事業者の webhook と 1 時間ごとの突き合わせで進め、`active`・`past_due`（3 日の猶予）・`canceling` の間だけ会員の特典とメンバー限定の動画を許す | accepted |
| [0057](0057-revenue-ledger-share-calculation-and-rounding.md) | 収益は複式の台帳にマイクロ円の整数で日ごとに積み、創作者の側の取り分を広告 55%・メンバーシップ 70%（契約の値）で切り捨てて出す。照合の分け方の端数は最大剰余で配り、円への丸めは月の締めで相手ごとに 1 回だけ切り捨てて端数を翌月へ繰り越す。締めた月は書き換えず、調整の仕訳で直す | accepted |
| [0058](0058-payouts-via-provider-and-tax-profile.md) | 支払いは決済の事業者の接続アカウントへの送金で月 1 回（毎月 25 日、1,000 円未満は繰り越し）にし、冪等の鍵は `payout:{party}:{yyyymm}` にする。税の情報を相手ごとに持ち、源泉徴収の率と区分は設定の表に置いて法務の確認の後に値を入れる | accepted |
| [0059](0059-accounts-channels-and-roles.md) | アカウント（人）とチャンネル（公開の主体）を分け、1 つのアカウントは 50 までのチャンネルを持てる。チャンネルの権限は 7 つの役割の決定表 `can(actor, channel, action)` で決め、所有者は 1 人で移せない | accepted |
| [0060](0060-authentication-2fa-and-creator-sessions.md) | 認証はパスキーを主にし、TOTP を代わりにして、SMS は回復だけに使う。大きな・収益化・配信のチャンネルの所有者と管理者は 2 要素を必須にし、更新のトークンの回転と再利用の検出、重い操作の再確認と新しい端末の待ちで、セッションの盗み出しの被害を絞る | accepted |
| [0061](0061-creator-tiers-strikes-and-account-standing.md) | 創作者の機能を標準・中間・上級の 3 つの段に分け、中間は電話の確認、上級はチャンネルの履歴か身元の確認で開く。違反は最初は警告、その後は 90 日で失効する strike にし、ガイドラインと著作権で別に数え、アカウントのステートマシンの効き目を `can()` と `playable()` に渡す | accepted |
| [0062](0062-threat-mitigations-and-key-layout.md) | 信頼しない入力を復号する部品をすべて「信頼しないメディア」の実行の形で動かし、鍵はデータの種類ごと・リージョンごとの KMS の鍵にし、署名の鍵は 2 つを並べて 30 日で回す。悪用の分かったエッジのトークンは KeyValueStore の `t:` で個別に拒む | accepted |
| [0063](0063-operator-access-audit-retention-and-legal-hold.md) | 運用者は日常の権限で元のファイル・隔離のファイル・生の IP アドレス・チャットの本文を読めず、読むときは JIT と 2 人の承認と監査を要る。監査の記録は outbox から Object Lock へ書き、保持の期間は `retention_policies` の 1 つの表に持ち、法的な保全はすべての消去の経路より先に効かせる | accepted |
| [0064](0064-accounts-network-and-edge-distributions.md) | アカウントは他の題材の形に、大阪の自己監視 `selfmon` と、隔離のファイルの `media-quarantine` を足す。メディアの面のサブネットは外への経路を持たない。CloudFront は VOD・ライブ・画面と API のディストリビューションに分けて上限をそれぞれ申請し、オリジンは VPC オリジンの NLB にして `apne1-az3` を使わない | accepted |
| [0065](0065-media-fleets-msk-and-storage-tiers.md) | メディアの面は用途ごとの EC2 のキャパシティープロバイダーに置く。符号化は x86 の CPU の Spot（型 6 つ以上）、ライブは `g6.2xlarge` を On-Demand のキャパシティの予約で下限を持ち、`origin-cache` は `im4gn.4xlarge`、`match-engine` は `r7g.8xlarge`、`live-origin` は `r7g.4xlarge` にする。MSK は Express の `express.m7g.large` × 3 から始め、元のファイルは公開の 90 日の後に Deep Archive、レンディションは Intelligent-Tiering にする | accepted |
| [0066](0066-osaka-dr-stage-up-and-multi-cdn-timing.md) | 大阪は管理の面のウォームスタンバイと、元のファイルの写しと、熱い集まりの H.264 のレンディションの写しを持ち、CloudFront のオリジングループで VOD の外れを大阪へ逃がす。段階を上げる準備は上限の 60% で始め、2 つ目の CDN は月の配信 100 PB か配信のピーク 1 Tbps の早いほうの前に入れる | accepted |
| [0067](0067-sli-sources-and-computation.md) | SLI は端末の QoE の出来事、CDN のログ、パイプラインと措置の段の時刻、見張りの 4 つの源から作る。警報は速い源（リアルタイムのログの 1% の抜き取り、1 分の QoE の桶）、SLO の報告は全数の源（標準のログ、段の時刻の全行）で計算する | accepted |
| [0068](0068-qoe-privacy-limits-cdn-logs-and-selfmon.md) | QoE の出来事は本システムの受け口にだけ送り、題・URL・IP・端末の固有の識別子を入れず、切り口は決めた種類の値だけにする。CDN のリアルタイムのログは IP・cookie・見出しの欄を選ばずパスのトークンを落とし、標準のログは 7 日で IP を落とす。自己監視は大阪の `selfmon` に置く | accepted |
| [0069](0069-load-model-headroom-and-load-tests.md) | 負荷のモデルは平常のピーク・大きな催し・急な人気の 3 つの重ねで作り、部品は平常のピークを 60% の使用で受け、AZ を 1 つ失っても催しのピークを 90% で受ける台数にする。負荷試験は CDN を通すものを 10% の規模、オリジンの部品は直接の模型で全規模にする | accepted |
| [0070](0070-ci-cd-golden-media-gates-and-player-rollout.md) | PR の CI に黄金の動画の小さな集まり（20 本）の関門を置き、符号化・ラダー・パッケージ・マニフェスト・プレイヤーに触れる変更は通らなければマージしない。メディアの面は「足してから抜く」でデプロイし、Web のプレイヤーは 1%・10%・50%・100% の段でプレイヤーのバージョンごとの QoE で自動に止め、アプリは最低のバージョンを再生の API で強制できるようにする | accepted |
| [0071](0071-encoder-pinning-reencode-and-manifest-format-versions.md) | 符号化器の組み立てを `enc_build` の番号に固定して段の出力のキーの設定のハッシュに入れ、上げても既存の動画は作り直さない。作り直しは欠陥の修正・新しいラダーの損益・各 ADR の条件の 3 つに限る。マニフェストの出力のバイトを変える変更は URL の `mf` を上げ、2 つ前の `mf` まで作れるままにする | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。
