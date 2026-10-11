# Design log: Zoom

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-27：既定案

PM の方針（既定案で進め、問いにしない）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」（L1〜L8）に残した。

- **ADR と intent の状態**：基盤の ADR（0001〜0005）と intent.md を、他の題材と同じく `accepted` にした。先に次を直した。
  - ADR-0001：S1 は AWS で始める。Edge（コロケーション・ベアメタル）の構築は、ピークの送出が 4 週続けて 10 Gbps を超えたら始める（ADR-0050）。損益の分かれ目は約 8〜10 Gbps で、S1 の途中で越えうる。大阪には c7gn・c8gn がないので c6gn を使う（ADR-0049）。S1 の送出を容量の前提の 75 Gbps に直した。
  - ADR-0002：Node の間の pipe は producer のすべての層を運ぶ。Node をまたいで受け手ごとに層を絞ることは S3 の課題にした。RED は mediasoup のフォークが要る（ADR-0017）。100 人を超える会議の音声は ADR-0057。
  - ADR-0003：デスクトップとモバイルの方式を ADR-0023・0024 に揃え、`RTCRtpScriptTransform` の対応を ADR-0021 に揃えた。
  - ADR-0004：E2EE はペイロードからの VP8 のキーフレームと層の判定を壊すので、mediasoup に VP8・VP9 の Dependency Descriptor の判断を足す（ADR-0028）。「退出」の定義と、E2EE のチャット（`e2ee.app`、`chat_seq`、Valkey には暗号文だけ、個別のメッセージは使えない）を書いた。
  - ADR-0005：別の Media Node へ移るには新しい transport が要り、ICE restart ではない（[media-server-sfu.md](media-server-sfu.md) の 9.3 節）。シグナリングのバージョンの受け方を N−1（Web）・N−2（アプリ）にした。
- **新しい ADR**：
  - [ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)：100 人を超える会議は、受け手ごとに 3 つの音声の枠。`DirectTransport`・`PipeTransport` の上の枠の切り替えの転送器。E7 の `audio-slot-forwarder-poc` の後に E10 で作る。
  - [ADR-0058](../decisions/0058-tenant-tables-with-force-rls.md)：組織に属する表は `org_id` と FORCE RLS（他の題材と同じ）。API の認可はその上に重ねる（[data-model.md](data-model.md) の持ち越しだった）。
- **容量の前提**：下り 2.5 Mbps で容量を見積もり、1.5 Mbps は期待の平均として残す。E2 のベータで測る。[README.md](README.md) の 2 節、[capacity.md](capacity.md)、[infrastructure.md](infrastructure.md) の 12 節（費用は両方を並べた）を直し、ADR-0053 に注記した。
- **NFR**：
  - NFR-001 は電話からの参加者を対象の外にした。電話の参加者の目標は [quality.md](../quality.md) に別に置く（p95 400ms、E14 で確かめる）。
  - NFR-008 の「退出」は、Actor が `Left`（切断の猶予の後の `Left(dropped)` を含む）か `Removed` を確定した時とした（下の「決定（2026-09-27、推奨案で確定）」で確定）。
- **`ip_prefix_hash` の pepper**：30 日ごとに替えるが、前の pepper を 30 日残して両方で照合する。`meeting_removals` に pepper のバージョンを持つ（[meeting-security.md](meeting-security.md) の 10 節、ADR-0032 の注記）。
- **IPv6 と DDoS**：防御のモード（`under_attack`）の Node は IPv6 の候補を出さない（[network-traversal.md](network-traversal.md) の 9 節、[security.md](security.md) の 8.3 節、ADR-0045 の注記）。
- **シグナリングのバージョン**：Web は N−1、アプリは N−2 まで受け、`min_client_version` より古いものは強制の更新（ADR-0008・0056 の注記、[delivery.md](delivery.md) の 5.3 節）。
- **シグナリングのスキーマ**：他の領域が足した `chat.*`、`reaction.*`、`consent.give`、`host.suspend`・`host.readmit`・`host.admit_all`・`host.to_waiting`・`host.invite`・`host.lower_hands`、`hello.client.features`、`client.kind = "phone"`、録画・字幕・E2EE・品質のメッセージを、[signaling-and-meetings.md](signaling-and-meetings.md) の 6.2 節に集めた。主催者の操作の決定表（9.2 節）にも行を足した。
- **E2EE のチャット**：[e2ee.md](e2ee.md) と [chat-and-reactions.md](chat-and-reactions.md) を揃えた。`e2ee.app` に `chat_seq`・`ch_seq` を付けて配る。Valkey には取りこぼしを埋めるための暗号文だけを置く。個別のメッセージとファイルは使えない。e2ee.md の 12 節に行を足した。
- **データモデル**：`meeting_participations` に codecs と clients が別々に提案した列を 1 つにまとめた。監査ログ 3 系統のハッシュの連鎖の列、outbox を 1 つの表にすること、保持の削除のジョブを 1 つにすることを決めた（[data-model.md](data-model.md) の 11 節）。
- **Epic**：E1〜E12 が MVP（S1）。公開 API と Webhook を E11（旧 E12）、運用と GA の準備を E12 にした。アプリは E13（旧 E11）、電話からの参加は E14、ウェビナーは E15、ブレイクアウトルームは E16（いずれも MVP の後）。`org-user-model`・`identity-better-auth` を E2 へ（E2 のベータの主催者のログインに要る）、`phone-join-rate-limits` を E14 へ移した（[roadmap.md](../roadmap.md)）。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。品質の閾値は [quality.md](../quality.md)。シグナリングの上限は [signaling-and-meetings.md](signaling-and-meetings.md) の 6.3 節、参加の流量は [meeting-security.md](meeting-security.md) の 8.2 節、1 台の上限と台数は [capacity.md](capacity.md) の 3・5 節、費用は [infrastructure.md](infrastructure.md) の 12 節、K8 の目標は capacity.md の 6 節、保持の期間は [security.md](security.md) の 9 節。
- 本家の名前は識別子に使わない（`<brand>`・`<Brand>`。リポジトリ共通の ADR-0006）。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

## 2026-09-27：確認の工程

「未検証」の項目を一次の資料で確かめ、決着したものは出典と確認日を付けた。PoC や計測が要るものは「未検証」のまま、確かめる Story を書いた。設計を変えたものは次のとおり（ADR は注記を付けた）。

- **RED は distance 1**：libwebrtc は冗長を 1 つしか作らず、Web のページから増やせない。ADR-0017 の distance 2 を取り消し、受け手ごとに残すか剥がすかだけにした。上りは最大約 2 倍、1 本は約 90 kbps（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 4 節、[capacity.md](capacity.md) の 2 節）。
- **mediasoup は音声を下りの割り当てに入れない**：映像が推定の全部を使いうるので、音声の分を残す方法を E4 の `downlink-allocation` で決める。`priority` は重みの周回で、「高い順に満たす」ではない（codecs の 6.3・6.4 節）。
- **Transcribe は大阪に無い**：大阪への切り替えの間は字幕と文字起こしを止める（ADR-0026・0050、[infrastructure.md](infrastructure.md) の 8.3 節、[disaster-recovery.md](../runbooks/disaster-recovery.md)）。
- **大阪の TURN は c6gn.8xlarge**：大阪に c8gn がない（infrastructure の 5・12 節）。
- **Firehose の既定の上限**：東京は 1 ストリーム 1 MiB/秒で、品質の記録（約 6 MB/秒）に足りない。まとめて送り、上限を引き上げる（[capacity.md](capacity.md) の 5.4 節）。
- **KMS の Ed25519**：参加のトークンの署名を Ed25519 に決め、E2EE の外部の送り手の鍵を KMS へ移した（ADR-0047、鍵は 6 つ）。
- **TURN の TLS の証明書**：ACM の書き出せる公開の証明書を使う。ワイルドカードの制約から名前を `<region>-<az>-<nn>.turn.<brand>.<domain>` に改めた（[security.md](security.md) の 5 節、[network-traversal.md](network-traversal.md)）。
- **Shield Advanced の EIP の保護**：事象の報告は保護から 15 分以上たってから。攻撃のときに加える決定は保ち、最初の 15 分以上は Shield Standard と防御のモードで耐える（ADR-0045 の注記）。
- **SLO の窓**：28 日から 30 日に改めた（他の題材と同じ。[runbooks/README.md](../runbooks/README.md) の 1 節、ADR-0052 の注記）。
- **公開 API**：E11 を MVP に残し、intent.md の MVP に足した（下の「決定」で確定）。
- **K8**：S1 を AWS で容量の前提のまま動かすと届かないこと、達成が Edge の判断に掛かることを明記した。目標の値は残した（ADR-0053 の注記。下の「決定」で確定）。
- **Edge の運用の体制**：リスクに足し、Edge の閾値の手前に判断の点（2 週続けて 5 Gbps）を置いた（ADR-0050 の注記。体制の形は下の「決定」で確定）。

持ち越し（計測・PoC・法務で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 下りの平均（1.5 Mbps か 2.5 Mbps か）、表示のしかたとカメラの割合、TURN を通る参加者の割合 | E2 のベータで `qos-report-pipeline` の要約から測る |
| 1 台の Media Node の上限（consumer、pps、送出、CPU）、c8gn と c8g の比較 | E7 の `load-l0-l2` |
| 音声の枠の転送器の性能と聞こえ方（`DirectTransport` か別のプロセスか） | E7 の `audio-slot-forwarder-poc` |
| RED の効果（FEC だけ・distance 1 ＋ FEC）、mediasoup の帯域の割り当てで音声の分を残す方法（mediasoup は音声を割り当てに入れない） | E4 の `red-forwarding`・`downlink-allocation` |
| `mos_est` の係数（`Ie`・`Bpl`）と ViSQOL の差 | E4 の `mos-est-calibration` |
| E2EE の depacketizer・Safari の DD・SVC の層ごとのフレーム | E9 の `e2ee-poc-transform` |
| Transcribe の日本語の CER・遅れ | E8 の前の `asr-evaluation-set` |
| BYOIP の範囲の入手の時間と費用 | E1 の `byoip-onboarding` の前（Ops） |
| Shield Advanced の EIP の保護を攻撃のときに加えた直後の緩和の振る舞い | E7 の `shield-advanced-onboarding`（SRT への問い合わせ） |
| CloudFront の WebSocket の長い接続 | E2 の `signaling-via-cloudfront` |
| Safari の VP9・AV1・DD・VP8 の simulcast、Firefox・Safari の RED | E2 の `browser-capability-probe` |
| mediasoup で音声の分を下りの推定から残す方法 | E4 の `downlink-allocation` |
| 法務の確認（L1〜L8） | [intent.md](../intent.md) の表の「承認を止める spec」の前 |

## 2026-09-27：推奨案で確定

利用者の指示（「判断が要るところは推奨案でよい」）により、残っていた法務以外の判断を推奨案で確定した。法務の確認（L1〜L8）と、その結論に掛かるものは決めていない。計測や PoC が要るものは、上の持ち越しの表に残した。

| 項目 | 決定 | 理由 | 文書 |
| --- | --- | --- | --- |
| 公開 API と Webhook（E11） | MVP に含める | 基盤の Epic の草案が公開 API を MVP に入れていた | [intent.md](../intent.md)、[roadmap.md](../roadmap.md) |
| NFR-008 の「退出」 | Actor が `Left`（`Left(dropped)` を含む）か `Removed` を確定した時 | 鍵の更新の起点を、状態の正本の 1 か所に置ける | [README.md](README.md) の 3 節、[e2ee.md](e2ee.md)、[ADR-0029](../decisions/0029-mls-delivery-and-authentication-service.md) |
| K8 の目標 | S1 0.20 円、S2 0.07 円を保つ。S1 を AWS の下り 2.5 Mbps で動かすと届かないことは受け入れる。閾値（4 週続けて 10 Gbps）で Edge の構築を始める | 目標を下げると、費用の大半を決める Edge の判断の基準が消える | [capacity.md](capacity.md) の 6 節、[infrastructure.md](infrastructure.md) の 12 節、[ADR-0053](../decisions/0053-capacity-model-cost-target-and-load-bots.md) |
| Edge の運用の体制 | 最初はリモートハンドを持つコロケーションの事業者と、IP transit・BGP の運用を任せる事業者を使う。社内にネットワークの SRE の当番を作り、閾値の前に 2 人を採用する。5 Gbps の判断の点で、この形で進めるかを決める | 採用には時間がかかる。委託で始めれば閾値に間に合い、社内の当番へ移せる | [README.md](README.md) の 6 節、[infrastructure.md](infrastructure.md) の 11 節、[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md) |
| SLO（30 日の窓）の値 | [runbooks/README.md](../runbooks/README.md) の 1 節の値で確定 | K2〜K4 と NFR に直接つながり、他の題材と窓が揃う | [ADR-0052](../decisions/0052-media-slis-and-mos-estimation.md)、[observability.md](observability.md) |
| 災害復旧の目標 | RTO 1 時間、RPO 1 分 | 大阪で新しい会議を受ける形で、訓練で確かめられる | [ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md)、[disaster-recovery.md](../runbooks/disaster-recovery.md) |
| RED | distance 1 | ブラウザは冗長を 1 つしか送らない | [ADR-0017](../decisions/0017-opus-dtx-fec-red.md) |
| E2EE の外部の送り手の鍵 | KMS へ移す（鍵は 6 つ） | KMS が Ed25519 に対応し、e2ee.md の移す条件を満たした | [ADR-0047](../decisions/0047-keys-and-operator-access-to-media.md) |
| TURN の名前 | `<region>-<az>-<nn>.turn.<brand>.<domain>` | ACM のワイルドカードの証明書は、いちばん左のラベル全体にしか使えない | [network-traversal.md](network-traversal.md)、[security.md](security.md) の 5 節 |
| Firehose の上限 | 書き込みをまとめ、上限の引き上げを申請する | 東京の既定（1 MiB/秒）では S1 のピークに足りない | [capacity.md](capacity.md) の 5.4 節 |
| 組織の表の分離 | FORCE RLS（ADR-0058） | 他の題材と同じ。API の認可の漏れを DB で止める | [ADR-0058](../decisions/0058-tenant-tables-with-force-rls.md)、[data-model.md](data-model.md) |
| QA の閾値 | 電話の参加者の遅れ p95 400ms、仮想背景の IoU 0.90、画面共有の OCR 95%、`loss-20-burst` の MOS 2.6 | 根拠のある既定で、実測は記録して別の変更で見直せる | [quality.md](../quality.md) |
| 仮想背景の基準の端末 | 4 年前の中位のノート PC。E5 の着手で QA が機種を 1 台固定する | 利用者の端末の下の方で性能を守る | [clients.md](clients.md) の 14 節 |
| 待合室を省く条件 | 身元だけ。参加の鍵を持つ人にも省かせない | 参加の URL が漏れても、荒らしを待合室で止められる | [meeting-security.md](meeting-security.md) の 13 節、[signaling-and-meetings.md](signaling-and-meetings.md) の 16 節 |
| ユーザーの組織 | 1 人は 1 つの組織だけ。複数の組織は MVP の後 | 権限と設定の解決が単純になる | [accounts-and-admin.md](accounts-and-admin.md) の 11 節、[ADR-0038](../decisions/0038-organizations-users-roles-and-sso.md) |
| 契約のない組織の上限 | 同時の会議 1 つ、1 会議 100 人、1 回 60 分 | ボットで Media Node を使い切る濫用を抑える | [security.md](security.md) の 8.1 節 |
| サポートによる組織のデータの参照 | 組織の `owner`・`admin` が、対象と期限（最長 7 日）を決めて許可し、監査に残す | 運用者は組織の許可なしに内容を見ない（ADR-0047） | [security.md](security.md) の 7 節 |
| 組織ごとの品質の SLA | 約束しない | 品質は組織の回線にも左右される | [observability.md](observability.md) の 10 節 |
| 電話 | 事業者は 1 社で始める。0ABJ は使わない。案内は日本語だけ | E14 の範囲を小さく保つ。0ABJ は取得の条件が重い | [telephony.md](telephony.md) の 11 節、[ADR-0041](../decisions/0041-pstn-via-carrier-sip-trunk-and-own-gateway.md)、[ADR-0042](../decisions/0042-dial-in-numbers-ivr-and-dial-out-limits.md) |
| MVP の後に回すもの | 1:1 の 1080p、複数の画面共有、チャットの装飾、「この回以降を変える」、ダウンロードを許さない共有の HLS、E2EE の長期の鍵・送り手ごとの署名・個別のメッセージ、API の会議の中の操作、組織ごとのレート制限の引き上げ、鍵の最小・最大、複数のグループ、分けた管理のロール、デスクトップの Linux 版 | roadmap.md の延期の一覧と揃える。MVP の範囲を守る | 各領域の文書の「決定」、[roadmap.md](../roadmap.md) の延期の一覧 |
| ネットワークの経路 | ポートの範囲は 256 のまま。WebSocket を通さないプロキシの代わりの経路は作らない | 公開の規則を単純に保つ | [network-traversal.md](network-traversal.md) の 14 節 |
| 各領域の「決定」 | 各文書の「未解決の問い」の「決定」を、そのまま確定 | 統合と確認の工程で矛盾を直してある | [README.md](README.md) の 7 節の各文書 |

法務の確認を待つもの（決めていない）：L1〜L8 のすべてと、それに掛かる次のもの。録画の同意の扱い（L3）、録画・字幕でサーバーが内容に触れる範囲（L2）、外部の音声認識の事業者と大阪への切り替えの間の字幕（L6）、会議の後のチャットの保持の既定（L6）、保持の期間（L2・L4・L6・L8）、報告の添付（L2）、捜査機関への対応（L4）、電話の事業の区分・番号・緊急通報・050 の品質の条件と電話の事業者の選定（L1・L7）、外部送信の公表（L5）、仮想背景のモデルのファイルの利用の条件、DPA とサブプロセッサー（L8）。

## 2026-09-28：データモデルの統合、推奨案で確定

利用者の依頼（各題材のデータモデルを十分に設計し、ER 図を付ける）により、[data-model.md](data-model.md) を正本として完成させた（68 表、ER 図 13 個。領域ごとに [data-model/](data-model/identity.md) へ分けた）。判断が要るところは推奨案で決めた。ADR の決定の中身は変えていない。

| 項目 | 決定 | 理由 | 文書 |
| --- | --- | --- | --- |
| 内部の ID の型 | DB は `uuid` 型で 128 ビットの時刻順の ID（ULID）を持つ。外の形は接頭辞＋ Crockford base32 | ID の範囲でパーティションを切れる | [data-model.md](data-model.md) の 2.2 節 |
| Better Auth の利用者の表 | `global.auth_users` に置き、`app.users` と同じ ID で 1 対 1 | ログインの前は組織が分からない。ユーザーは組織に属する（ADR-0038・0058） | 同 11.2 節の 2 |
| PMI の作り直し | 同じ `meetings` の行の番号を替える | ban と設定を引き継ぐ | 同 11.2 節の 3 |
| Webhook の受け口と配送の記録 | アプリの持ち主の組織に属する | 送り直すのはアプリの持ち主。`webhook_*` はテナントの表のまま（ADR-0058） | 同 11.2 節の 4 |
| 監査ログの連鎖の単位 | 組織の監査と会議の監査は組織ごと、プラットフォームの監査は 1 本 | 全組織の書き込みを 1 つの行ロックに集めない | 同 11.2 節の 5 |
| `media-prod` の部品と Aurora | Composer・Recorder の結果は SQS `recording-events` で Worker が書く | `prod` の Aurora は `media-prod` を許さない（ADR-0048） | 同 11.2 節の 6 |
| Valkey を失った後の `epoch` | リースを取るときに Aurora と Gateway から下限を渡し、Media Node の `stale_epoch` の応答の最大値で取り直す | `epoch` が減らない前提（ADR-0007）を Valkey の喪失の後も保つ | 同 11.2 節の 16、ADR-0007 の注記 |
| 録画のある開催の保持 | 録画・文字起こしが残る間は、開催と同意の行を残す | 同意の証拠が録画より先に消えない | 同 11.2 節の 7 |
| 設定の項目の名前 | `settingsRegistry` の名前を正にし、短い呼び名との対応の表を置く | 領域の文書を大きく書き換えずに揃う | 同 7 節 |

持ち越し（[data-model.md](data-model.md) の 10 節）：保持の期間（法務）、すぐの会議の行をいつ消すか（PM、E6）、Better Auth の OAuth のプラグインの表（E11）、E2EE の AS の証明書を出す主体（e2ee.md と ADR-0047 の書き方の違い。E9 で Dev が揃える）。
