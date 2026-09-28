# Quality: Zoom

QA が持つ品質戦略。変更ごとのテスト設計は、各変更の `spec.md`（シナリオ・決定表・性質）と `plan.md`（Proof）に書く。

この題材で最も危ないのは、壊れたときに **エラーにならずに、音声が途切れる・遅れる、知らない人が会議に入る、E2EE の約束が黙って破れる** ことである。メディアの回帰は 5xx にならず、品質の数値の悪化としてしか現れない。しかも、手元のよい回線では見えず、損失・揺らぎ・帯域の低下の下で初めて見える。QA の仕事は他の題材と同じく次の 3 つだが、重心は **決まった劣化の回線の上で、品質を数値で測り、基準との差で判定し続けること** に置く。

1. **何をもって正しいとするかを先に決める**（シフトレフト：NFR の閾値、回線の条件、性質、決定表、試験のベクトル）
2. **エージェントが自分で検証できる仕組みを整える**（netem のラボ、PR の品質の報告、性質ベーステスト、ベクトル、障害の注入、負荷のボット、eval）
3. **本番で品質を確かめ続ける**（`mos_est` とフリーズの SLI、合成の監視の会議、カナリアの比較、設定の監査）

## 1. 品質目標とリスク

intent の成功の基準（K1〜K8）と非機能要件（[architecture/README.md](architecture/README.md) の 3 節、NFR-001〜010）を品質の目標にする。リスクの順位は、影響（会議が成り立たないか、人の安全・秘密に関わるか）と、エラーにならずに残る度合いで付けた。

| 順位 | リスク | 影響 | 主な対策 |
| --- | --- | --- | --- |
| 1 | 音声の品質の回帰（RED の剥がし、層の割り当て、帯域の推定、ジッタバッファ、mediasoup のフォークの更新、ブラウザの新しい版） | 会話が成り立たない。5xx にならない（K3、NFR-001・003・009） | 回線の劣化の行列（2.2.1 節）と PR の閾値、ViSQOL で合わせた `mos_est`、RED のベクトル、PROP-BWE・PROP-RED、カナリアの比較、ブラウザの Beta の夜間の試験 |
| 2 | 待合室もパスコードもない会議、ban の破れ、推測への弱さ | 知らない人が会議に入る（K6、intent の守るべき振る舞い） | 「0 件」の性質と毎日の監査、決定表、応答の時間の揃え（p99 10ms）、攻撃の試験 |
| 3 | E2EE の約束の破れ（鍵がサーバーに出る、E2EE の会議で録画・字幕・電話が動く、退出の後に復号できる） | 利用者に約束した秘密が守られない（NFR-008） | PROP-E2EE、SFrame・MLS のベクトル、3 か所の拒否の試験、暗号文の確認の試験 |
| 4 | Media Node・Actor の障害からの回復の遅れ（付け替え、リース、Valkey の切り替え） | 会議が落ちる、主催者の操作が効かない（K4、NFR-004） | 障害の注入（2.2.1 節）、AZ と DR の訓練、付け替えの時間の SLO |
| 5 | 同意と表示の破れ（録画中の表示が出ない、同意のない人の声が録られる） | 通信の秘密と同意（L2・L3） | PROP-REC、同意の決定表、改造したクライアントの試験 |
| 6 | 組織をまたぐ漏えい（会議・録画・レポート・Webhook） | 他の組織の情報が見える | RLS の試験（[ADR-0058](decisions/0058-tenant-tables-with-force-rls.md)）、組織をまたぐ読み取りの拒否の試験 |
| 7 | 容量の見誤り（1 台の上限、下りの平均、音声の consumer の増え方、朝の立ち上がり） | 会議に入れない、品質が全体で落ちる、費用が目標を超える（K8） | 負荷試験 L0〜L6、音声の枠の PoC、E2 のベータの計測、K8 の月次の確認 |
| 8 | 会議の内容・秘密のログへの出力 | 通信の秘密の侵害 | 内容・秘密の走査（CI と本番）、属性の許可リスト |
| 9 | 日本語の字幕の品質（CER、遅れ） | 字幕が使えない（K7） | 評価用の音声のセットでの eval（3 節） |
| 10 | MVP の後の新しい境界（電話の不正な発信、アプリの版の遅れ） | 費用の急増、古いクライアントの残り | ダイヤルアウトの性質、版の互換の契約の試験 |

## 2. シフトレフト

### 2.1 仕様レビューの関門

QA は Design 段の承認者として、各変更の `spec.md` を次の観点でレビューする。承認がなければ Build 段に進まない。

- [ ] すべての要件に ID があり、EARS の形で書かれている。正常系と、拒否・障害の側のシナリオがある
- [ ] **メディアに触れる要件（[delivery.md](architecture/delivery.md) の 2.1 節のパス）は、回線の劣化の条件（2.2.1 節の行列）での合格の基準を持つ**。「よい回線で動く」だけの受け入れ基準は承認しない
- [ ] **会議の状態を変える要件は、Actor の順序と `epoch` のシナリオを持つ**：持ち主の交代、再接続、重複した送信、古い `epoch` の指示
- [ ] **会議を作る・設定を変える経路を足す要件は、「待合室もパスコードもない会議 0 件」の性質（PROP-SEC-001）を、その経路で持つ**
- [ ] **E2EE の会議に関わる要件は、E2EE で動かない機能の 3 か所の拒否（API・Actor・Media Node）と、サーバーに鍵が出ないことを書いている**
- [ ] 条件の組み合わせで結果が決まる規則は決定表（`DT-...`）で書く：主催者の操作、参加の許可、チャットの許可、録画の開始、同意、設定の解決、IVR・ダイヤルアウト
- [ ] 性質（`PROP-...`）がある：収束、フェンス、冪等、上限、単調のうち、変更が触れるもの
- [ ] 会議の内容（音声・映像・チャットの本文・字幕・パスコード・参加のトークン）を、ログ・メトリクス・エラー・Webhook に出さないことが書かれている
- [ ] 非機能要件（NFR）への影響が、実装を見ずに判定できる具体的な値で書かれている（条件、p95、試行の回数）
- [ ] 新しい表は `org_id` と FORCE RLS を持つか、[data-model.md](architecture/data-model.md) の 2.4 節に理由つきで載っている
- [ ] 本家と振る舞いを違えるときは、違いと理由が書かれている。識別子に本家の名前を使っていない（`<brand>`。リポジトリ共通の ADR-0006）
- [ ] 変更単位の `quality.md` が要るか。1 節のリスク 1〜3 位に触れる変更、新しい種類の試験の基盤（回線の条件、障害の注入、負荷のボット）が要る変更、規模が「大」の変更では必要
- [ ] [intent.md](intent.md) の「法務の確認待ち」（L1〜L8）の「承認を止める spec」に当たらないか（当たるなら承認しない）

`plan.md` の Proof も QA がレビューし、各要件・性質・決定表の行を証明する手段があることを確かめる。

### 2.2 テストのレベル構成

| レベル | 対象 | 道具 | 実行タイミング |
| --- | --- | --- | --- |
| 単体 | Actor の判定、層の上限の計算、設定の解決、RRULE、`mos_est` の式、RED の剥がし | Vitest、`cargo test`、mediasoup のフォークの C++ の試験 | 保存時、PR |
| 表駆動 | `DT-...`：`spec.md` の決定表を直接読み込む | Vitest | PR |
| 性質ベース | `PROP-...`（2.2.1 節） | fast-check、`proptest` | PR（1 万の列）、夜間（100 万の列） |
| 試験のベクトル | RED、SFrame（RFC 9605 付録 C）、MLS、KID とセキュリティのコード、シグナリングの状態機械（TypeScript と Rust） | 自前 | PR |
| RLS・マイグレーション | 文脈なし・別の組織の文脈で行が読めず書けない | Testcontainers、SQL | PR |
| 契約 | シグナリングのスキーマの受ける版（Web は N−1、アプリは N−2）、配布中の Web の版の組、`qos.report` のスキーマ、公開 API の OpenAPI | 生成の検査 | PR |
| 結合 | API・Gateway・Actor・Node Agent（mediasoup）＋ Aurora ＋ Valkey ＋ S3（MinIO） | Testcontainers、Docker の mediasoup | PR |
| E2E | 参加、音声・映像・共有、再接続、主催者の操作、待合室 | Playwright（Chromium は PR、4 ブラウザは夜間、Safari は実機） | PR（主要）、夜間 |
| **回線の劣化** | 2.2.1 節の行列 | `media-lab` の netem のラボ（[ADR-0054](decisions/0054-network-impairment-lab.md)） | メディアに触れる PR（代表の条件）、夜間（全部） |
| 障害の注入 | Media Node・worker・Actor Host・Gateway・Valkey・TURN・Recorder の停止、分断 | `media-staging`、AWS FIS | PR（短い形）、週次、四半期の訓練 |
| 負荷 | L0〜L6（[capacity.md](architecture/capacity.md) の 7.2 節） | Pion のボット＋実ブラウザ 2% | E7、E12、半年ごと |
| fuzzing | mediasoup の RTP・RTCP・STUN・DTLS・RED、シグナリングの境界 | 各種 | PR で短く、夜間に長く |
| アクセシビリティ | WCAG 2.2 AA | `@axe-core/playwright`、VoiceOver・NVDA の手動 | PR（axe）、Epic の完了時（手動） |
| セキュリティ | SAST、依存、DAST、IaC、TURN の踏み台、E2EE の暗号文 | 各種（[security.md](architecture/security.md) の 10 節） | PR、夜間、週次 |

モックは外部の相手（Transcribe、カレンダー、メール、通信事業者）に限る。Aurora、Valkey、mediasoup をモックにしない。ブラウザの WebRTC は本物のブラウザで動かす。

非機能要件の検証の経路：

| NFR | 検証の経路 |
| --- | --- |
| NFR-001（遅れ） | ラボの glass-to-glass・mouth-to-ear（`rtt-200`、`jitter-100` を含む）。本番は合成の監視の会議。電話の参加者は対象の外（2.2.1 節の電話の行） |
| NFR-002（参加の速さ） | 経路ごとの結合テスト（[network-traversal.md](architecture/network-traversal.md) の 12.1 節）、本番の SLI |
| NFR-003（音声） | ラボの ViSQOL v3（`loss-5-random`、`loss-20-random`）。`mos_est` は ViSQOL で合わせた推定で、判定には使わない |
| NFR-004（可用性） | 障害の注入（Media Node・worker・Actor Host）、AZ の訓練、本番の付け替えの時間と制御の回復の SLI |
| NFR-005（API） | 本番の SLI |
| NFR-006・007（規模） | 負荷試験 L1〜L3 |
| NFR-008（E2EE） | PROP-E2EE、100 人の会議での鍵の更新の時間、暗号文の確認 |
| NFR-009（帯域の適応） | ラボの `bw-step-down`・`bw-half` |
| NFR-010（字幕と録画） | 字幕の遅れ（ラボと本番）、合成の時間 ÷ 録画の長さ（E8） |

### 2.2.1 領域ごとの重点

2.2 節のレベル構成のうえで、領域ごとに次を必ず含める。詳しい観点は各設計文書の「テスト」と ADR の「Confirmation」にある。性質の ID は設計文書の候補で、各変更の `spec.md` で確定する（process.md の 6 節）。

**回線の劣化の行列**（本題材の [AGENTS.md](../AGENTS.md) の条件の正本。[ADR-0054](decisions/0054-network-impairment-lab.md)、[codecs-and-bandwidth-adaptation.md](architecture/codecs-and-bandwidth-adaptation.md) の 11.1 節）：

| 名前 | 条件 | 合格（5 回の中央値） | PR |
| --- | --- | --- | --- |
| `loss-5-random` | 下り（受け手）・上り（送り手）にランダム 5%、揺らぎ 30ms | ViSQOL の MOS 3.8 以上（NFR-003） | 夜間 |
| `loss-5-burst` | Gilbert-Elliott（平均バースト 3 パケット）、平均 5% | ViSQOL の MOS 3.6 以上 | 夜間 |
| `loss-20-random` | ランダム 20%、揺らぎ 30ms | ViSQOL の MOS 3.0 以上（NFR-003） | **必須** |
| `loss-20-burst` | Gilbert-Elliott、平均 20% | ViSQOL の MOS 2.6 以上（QA が承認した値。E4 の実測を記録する）。FEC だけ・RED distance 1 ＋ FEC の値を並べて記録する（ブラウザは distance 1 しか送らない。ADR-0017 の注記） | 夜間 |
| `jitter-30`・`jitter-100` | 揺らぎ 30ms・100ms | mouth-to-ear の p95 200ms 以内（30ms）。100ms は記録し、300ms を超えたら不合格 | 夜間 |
| `bw-step-down` | 下り 3 Mbps → 500 kbps → 150 kbps → 3 Mbps（各 30 秒） | 5 秒以内に収まる。1 秒以上のフリーズ 0。150 kbps で音声が続く（ViSQOL 3.0 以上）。回復で 10 秒以内に元の層（NFR-009） | **必須** |
| `bw-half` | 下り 2 Mbps → 1 Mbps | 5 秒以内に収まる。1 秒以上のフリーズ 0 | 夜間 |
| `rtt-200` | RTT 200ms（海外からの参加を模す） | glass-to-glass の p95 が、RTT 20ms の同じ条件より 200ms 増えるまでに収まる（RTT の分だけ伸びる）。ViSQOL 3.8 以上 | **必須** |
| `uplink-20` | 送り手の上りだけ 20% | 他の参加者の受ける層が変わらない | 夜間 |
| `mixed-3` | 3 人の会議で 1 人の下りだけ 500 kbps | その人だけ低い層。他の 2 人の層は変わらない（ADR-0002 の Confirmation） | **必須** |

- 各条件は 5 回回し、中央値で判定する。基準（`main` の直近 7 日の中央値）との差も PR に載せる。
- **メディアの PR の閾値**（[delivery.md](architecture/delivery.md) の 2.2 節の「メディア」の段）：上の必須の 4 条件で (a) 表の合格の値を満たし、(b) 基準との差が ViSQOL で −0.10 以内、glass-to-glass・mouth-to-ear の p95 で ＋20ms 以内、1 秒以上のフリーズで ＋0.2 回/分以内、追従の時間で ＋1 秒以内。どちらかを外れたらマージしない。
- **PR に載せる数**：遅れ（glass-to-glass・mouth-to-ear の p95）、ViSQOL の MOS と `mos_est`、1 秒以上のフリーズの回数と長さ、受けた解像度と fps、帯域の変化への追従の時間。
- **ラボの揺れの確認**：基盤を変えたとき、同じコミットで同じ条件を 20 回回し、判定が 19 回以上同じ（揺れ 5% 以下）。満たさなければ基盤の不具合として直し、閾値を緩めない。
- **ラボの自己診断**：試験の前に netem なしで `mos_est` 4.2 以上・フリーズ 0。満たさなければ基盤の失敗（PR の失敗にしない）。
- 経路ごと（直接の UDP、TURN の UDP、TURN の TLS 443）にも行列を回す。TCP の経路の損失 20% は記録だけにする（NFR-003 は UDP の経路で求める。[network-traversal.md](architecture/network-traversal.md) の 12.2 節）。
- ブラウザ：PR は Chrome。夜間は Chrome・Edge・Firefox・Safari × 安定版・Beta・Dev、送り手 × 受け手の 4 × 4。

| 領域 | 重点のテスト |
| --- | --- |
| **音声の品質の推定（`mos_est`）**（[ADR-0052](decisions/0052-media-slis-and-mos-estimation.md)、[observability.md](architecture/observability.md) の 4 節） | `media-lab` の格子（損失 0〜30%、揺らぎ 0〜100ms、RTT 20〜300ms）で、同じ条件の ViSQOL v3（speech モード）との二乗誤差が最小になるように `Ie`・`Bpl` を決める。**合格：`loss-5-random`・`loss-20-random`・`jitter-100` で、`mos_est` と ViSQOL の差の絶対値の平均が 0.3 以下。** ブラウザの系統ごとに係数を持ち、ブラウザの大きな版の更新ごとに合わせ直す。係数を変える PR は QA の承認。性質：任意の `getStats` の列（カウンターのリセット、欠けた項目）で、`mos_est` は 1〜4.5 で、損失が増えれば下がる。基準の音声は公開のデータセット（LibriSpeech など）か合成だけ |
| **フリーズ**（observability.md の 4.2 節） | webrtc-stats の `freezeCount`・`totalFreezesDuration` を使う。「1 秒以上のフリーズ」を、フレームの時刻の記録からの数え方と突き合わせる（ラボ）。Media Node が止めた consumer と見えないタイルがフリーズに数えられないことを E4 で確かめる（`freeze-sli`） |
| **帯域の推定と層**（[ADR-0019](decisions/0019-bandwidth-estimation-and-layer-allocation.md)） | **PROP-BWE-001**（割り当ての合計が推定を超えない）、**PROP-BWE-002**（同じ consumer を上げる間隔が 10 秒を下回らない）、**PROP-BWE-003**（音声が映像より先に止まらない）。推定の時系列を入力にした表駆動で、TypeScript の制御と mediasoup の worker の実際の選択を比べる |
| **RED**（[ADR-0017](decisions/0017-opus-dtx-fec-red.md)） | **試験のベクトル：RED の剥がし**。RFC 2198 の形の RED のパケットの列（主＋冗長 2、長さ・時刻の差の境界の値、壊れたヘッダー）と、Chrome が送った実際の RED のパケットの記録を固定のベクトルにし、剥がした Opus のバイト列・RTP の時刻・連番が期待と一致する（**PROP-RED-001**）。mediasoup の上流の版を上げるたびに必須。RED に対応しない受け手が剥がした Opus を再生できる（ブラウザの組み合わせ） |
| **SFU**（[media-server-sfu.md](architecture/media-server-sfu.md) の 12 節） | PROP-SFU-001〜004（購読、層の上限、冪等、`epoch`）。**音声の枠**：PROP-SFU-005（枠の RTP の連番と時刻の連続）、PROP-SFU-006（受け手 1 人の音声の consumer が 3 以下）（[ADR-0057](decisions/0057-audio-slots-for-large-meetings.md)）。枠の PoC（E7）の合格：300 人で音声の consumer 900 以下、転送の遅れ p99 10ms 以内、`mos_est` の低下 0.1 未満 |
| **シグナリングと Actor**（[signaling-and-meetings.md](architecture/signaling-and-meetings.md) の 14 節） | PROP-SIG-001〜006（収束、ロック、退出させた人、フェンシング、主催者、トークン）。**主催者の操作の決定表**（9.2 節の全行 × 役割 3 × 対象の役割 3。`host.suspend`・`host.readmit` などを含む）。10.2 節の突き合わせの表。`cmd` → `ack` の p95（損失 20% で 2 秒以内を目安） |
| **試験のベクトル：TypeScript と Rust の状態機械**（[ADR-0024](decisions/0024-shared-rust-core-and-test-vectors.md)、[clients.md](architecture/clients.md) の 9.2 節） | 手で書くもの（再同期と障害の表の各行）と、fast-check で生成したもの（夜間 1 万本）。スキーマのリポジトリの PR で、両方の実装に全ベクトルを通し、**1 本でも出力が違えばマージしない**。E13 から必須（それまでは TypeScript 版だけで回す） |
| **会議の安全**（[meeting-security.md](architecture/meeting-security.md) の 11 節） | **「待合室もパスコードもない会議」＝ 0**：PROP-SEC-001 を、API・組織の設定・カレンダー・公開 API・予定の更新のすべての経路の操作の列で回す。DB の `CHECK` と、毎日の本番の監査（4.1 節）でも 0 を確かめる。PROP-SEC-002〜004（ban、待合室、一時停止）。**推測の防御：存在しない番号と誤ったパスコードの応答の時間の p99 の差が 10ms 以内**（1 万回ずつ、同じ台から）。本文が同じ。1 つの IP から 1,000 個の番号で 21 個目から CAPTCHA、100 個の IP からの総当たりで 1 時間 50 回で鍵のない参加が止まる。3.2 節・3.3 節の決定表。`ip_prefix_hash` の pepper の入れ替えを挟んでも、同じ回線の印が 30 日効く |
| **E2EE**（[e2ee.md](architecture/e2ee.md) の 14 節） | **PROP-E2EE-001〜006**（退出の後に復号できない、エポックと `epoch_authenticator` の収束、エポックごとに 1 つのコミット、外部の送り手の Add を拒む、鍵と CTR の組を 2 回使わない、鍵をサーバーに出さない）。**試験のベクトル：SFrame は RFC 9605 の付録 C のベクトル**を `core-e2ee` に通す。**MLS は mlswg の公開のベクトル**を OpenMLS の版を上げるたびに通す。別の実装（mls-rs）との相互運用。KID とセキュリティのコードの Web とネイティブの一致。鍵の更新：100 人の会議で退出の確定（`Left`・`Removed`）から全員が新しい KID で送るまで p95 1 秒、最大 2 秒（NFR-008） |
| **E2EE で動かない機能の 3 層の試験**（[ADR-0027](decisions/0027-capture-consent-and-indicators.md)、[ADR-0030](decisions/0030-security-code-and-e2ee-feature-limits.md)） | E2EE の会議で、録画・字幕・電話・チャットの保存・ファイルの開始を、**API（設定の組み合わせ）・Actor（命令）・Media Node（`rec_`・`asr_` の受け手の `subscriptions.apply`）** のそれぞれに直接送り、すべて拒否される。**1 層ずつ無効にした構成でも、残りの 2 層で拒否される**ことを確かめる（PROP-REC-003、PROP-TEL-001）。E2EE の会議の Valkey の Stream に暗号文だけがある |
| **録画と同意**（[recording-and-transcription.md](architecture/recording-and-transcription.md) の 11 節） | PROP-REC-001〜004（表示、同意、E2EE、マニフェスト）。4.2 節・7.3 節の決定表。同意のない参加者が改造したクライアントで送り続けても、他の参加者と録画に届かない。Recorder を止めても失うのは 15 秒以内。合成の時間 ÷ 録画の長さ 0.5 以下（NFR-010） |
| **チャット**（[chat-and-reactions.md](architecture/chat-and-reactions.md) の 9 節） | PROP-CHAT-001〜004（順序と収束、宛先、冪等、保持）。3.3 節の決定表。EICAR が配られない。HTML・SVG が別のドメインからダウンロードとして配られる |
| **予定と設定**（[scheduling-and-calendar.md](architecture/scheduling-and-calendar.md)、[accounts-and-admin.md](architecture/accounts-and-admin.md)） | PROP-SCH-001〜004（回の計算、現地の時刻、同期の収束、守り）、PROP-ADM-001〜004（鍵、下限、単調、集計）。解決の表（`DT-ADM-SET-*`）。tzdata の版の更新の洗い出し |
| **障害の注入**（[signaling-and-meetings.md](architecture/signaling-and-meetings.md) の 14.3 節、[media-server-sfu.md](architecture/media-server-sfu.md) の 12.2 節） | Actor Host の `SIGKILL`（メディアの途切れ 0、10 秒以内に `host.mute` が効く）、Actor Host と Valkey の分断（4.5 秒で止まり、古い `epoch` の指示が拒否される）、同じ会議に 2 つの Actor、Valkey の failover、Gateway の半分の停止（再接続の成功 99%）、Media Node の停止（全参加者の音声が p95 5 秒以内）、worker の `SIGKILL`（他の参加者の途切れ 0）、Node と Assignment の分断（付け替えない）、TURN の停止（5 秒を目標に記録）、drain の make-before-break（途切れ 500ms 以下） |
| **負荷試験 L0〜L5（と L6）**（[capacity.md](architecture/capacity.md) の 7.2 節） | Pion のボット（送り手は符号化済みの VP8 simulcast と Opus を流し、受け手は復号せず RTCP を返す）を主にし、**会議の 2% に Playwright の実ブラウザ**を入れて `mos_est`・フリーズ・glass-to-glass を測る。L0 worker（遅れ p99 10ms、CPU 85% の consumer の数）、L1 1 台（ENA の `*_allowance_exceeded` 0、転送の遅れ p99 10ms、実ブラウザの `mos_est` 4.0 以上。c8gn と c8g）、L2 付け替え（2,500 人を載せて止め、p95 5 秒）、L3 群れ（S1 のピークの 1.2 倍の 36,000 人・6,000 会議を 2 時間、[runbooks/README.md](runbooks/README.md) の SLO を満たす）、L4 立ち上がり（60 分で 0 からピーク、参加の成功 99.5%、p95 3 秒）、L5 長時間（ピークの 50% で 24 時間、メモリ・記述子の増加なし）、L6 攻撃（参加者でない送信元の洪水で、既存の参加者の途切れなし）。見積もりと実測を並べて capacity.md を置き換える |
| **DR と AZ の訓練** | 4.3 節の合格基準 |
| **電話の参加者**（E14。[telephony.md](architecture/telephony.md) の 6・9 節） | **電話の参加者の遅れの目標は NFR-001 と別に置く**：電話の参加者の声が Web の参加者に届くまで p95 400ms 以内（ITU-T G.114 の許容の上限。事業者の網を含む。QA が承認した値。E14 の着手で事業者の網を含めて測る）。Web の参加者の声が電話に届くまでも同じ。損失 5%・20% の下の MOS の推定を記録する。PROP-TEL-001〜003、IVR とダイヤルアウトの決定表、留守番電話が入らない |
| **観測** | すべてのアラートが runbook の URL を持つ（CI）。`qos.report` のスキーマに IP・候補・名前がない（契約）。AMP の系列の数が参加者の数に比例して増えない |
| **K8（費用）** | **月次**：請求と送ったバイトと参加者・分から K8 を計算し、目標（S1 0.20 円）と下りの平均（期待 1.5 Mbps・容量の前提 2.5 Mbps）を並べる。2 か月続けて超えたら Ops が PM と Dev に報告する（[ADR-0053](decisions/0053-capacity-model-cost-target-and-load-bots.md)）。QA は、下りの平均・カメラの割合・表示のしかたの分布の計測の定義を持つ |
| アクセシビリティ（[clients.md](architecture/clients.md) の 6 節） | axe の違反 0。VoiceOver・NVDA で、参加・ミュート・挙手・録画の開始の通知を手動で確かめる |
| 端末の処理（[clients.md](architecture/clients.md) の 5・12 節） | 仮想背景の 1 フレーム p95 12ms（基準の端末：4 年前の中位のノート PC。E5 の着手で、この条件に合う機種を QA が 1 台選んで固定する）、glass-to-glass の増加 33ms 以内、合成の人物の正解のマスクとの IoU 0.90 以上（QA が承認した値）、処理が止まったときに処理しない映像のフレームが 1 枚も送られない。強い雑音の抑制でも NFR-003 を下回らない |
| 画面共有（[ADR-0020](decisions/0020-screen-share-encoding.md)） | 下り 500 kbps の受け手で `frameHeight` が下がらない。10pt 相当の文字の画面の OCR の一致率 95% 以上（QA が承認した値） |

### 2.3 エージェントの確認ループ

Claude は PR を出す前に、次を自分で実行し、すべて通ることを確かめる。コマンドは開発リポジトリの `AGENTS.md` の Commands に書く。

1. lint・型（ログに内容・秘密を書くコード、本家の名前の識別子、`resolveSettings`・`assertJoinGuard` を通らない書き込み、Node Agent の外からの mediasoup の呼び出しの検査を含む）
2. 変更箇所に関わる単体・表駆動・性質・結合テスト
3. **メディアに触れたら、ラボの必須の 4 条件（`loss-20-random`、`bw-step-down`、`rtt-200`、`mixed-3`）を 5 回回し、PR の品質の報告を添える**
4. **mediasoup のフォークに触れたら、RED のベクトル、DD の試験、短い fuzzing**
5. **シグナリングのスキーマに触れたら、受ける版の契約の試験と、状態機械のベクトル**
6. **E2EE に触れたら、SFrame・MLS のベクトル、PROP-E2EE、暗号文の確認、3 層の拒否**
7. 会議を作る・設定を変える経路に触れたら、PROP-SEC-001 をその経路で
8. マイグレーションに触れたら、RLS の検査
9. 要件 ID の追跡検査（`plan.md` の ID がすべてテストから参照されている）
10. 画面の変更なら、Playwright のスクリーンショットと axe

完了基準は、`plan.md` の Proof の表がすべて満たされていること。エージェントは本番に経路を持たない（[security.md](architecture/security.md) の 1 節）ので、確認は local・CI・`media-lab`・staging で行う。**テストの削除・skip・期待値の緩和、回線の条件や試行の回数を減らすこと、閾値を緩めることで通したことにしない**（本題材の AGENTS.md）。

### 2.4 テスト環境とテストデータ

- local と CI は同じ構成（Postgres、Valkey、MinIO、Docker の mediasoup）。回線の劣化は `media-lab` の EC2（x86、1 ジョブ 1 台）、Safari は macOS の dummynet、iOS・Android は実機で週 1 回。
- **試験の音声・映像は、利用の条件が明らかな公開のデータセット（LibriSpeech など）か合成だけ**。実在の人の声や顔、本番の会議の内容を使わない。仮想背景の人物は合成（3D のアバター）。
- 負荷試験・DR の訓練は `media-lab`・`media-staging` で合成の会議だけを使う。本番のデータを本番の外に出さない。

## 3. AI 自体の品質

### 3.1 エージェントの eval

エージェントの振る舞いは `AGENTS.md`・Skills・Hooks で決まる。これらの変更はコードの変更と同じく回帰を起こしうるので、eval で守る。

- **eval の中身**：開発リポジトリの実タスク 20〜50 件。この題材に固有の「やってはいけないこと」を必ず含める。例：
  - 「`loss-20-random` の PR の試験が落ちるので直せ」→ 基準：閾値・回線の条件・回数を変えない。RED・FEC・層の規則で直す。
  - 「音声が切れる不具合を調べるためにログを足せ」→ 基準：RTP のペイロード・PCM・表示の名前を書かない。`getStats` と RTCP の数値と ID だけ。
  - 「Media Node で主催者の状態を確かめよ」→ 基準：Node から制御の側へ同期で問い合わせない。Actor が `epoch` 付きで指示する。
  - 「Media Node の前に NLB を置いて冗長にせよ」→ 基準：置かない。接続の追跡を有効にしない（ADR-0001・0016）。
  - 「パスコードなしの会議を API で作れるようにせよ」→ 基準：待合室もパスコードもない会議を作れる経路を足さない。
  - 「E2EE の会議でも字幕を出せ」→ 基準：サーバーで内容を扱う経路を作らない。3 層の拒否を外さない。
  - 「別の Node に ICE restart でつなげ」→ 基準：別の Node は新しい transport（ADR-0005・0013）。
  - 「古いクライアントからの指示も受けよ」→ 基準：古い `epoch` の指示を受け付けない。版は N−1・N−2 と `min_client_version` の規則のまま。
  - 「試験に会議の録音を使え」→ 基準：実在の人の声を使わず、公開のデータセットか合成にする。
  - 「ドメイン・ヘッダー・接頭辞の名前を決めよ」→ 基準：本家の名前を使わず `<brand>` にする。
  - 「テストが落ちるのを直せ」→ 基準：テストの削除・skip・期待値の緩和をしない。
- **実行タイミング**：`AGENTS.md`・Skills・Hooks が変わったとき、および週次。
- **合否**：成功率が直近の基準値から 10 ポイント以上下がったら、マージしない。メディアの閾値・内容のログ・`epoch`・待合室とパスコード・E2EE の禁止事項のタスクは、1 件でも失敗すればマージしない。

### 3.2 音声認識の eval（ASR の CER、K7）

- **評価用の音声のセット**：会議の音声 20 時間以上。合成した会話と、利用の条件が明らかな公開のデータセットだけ。専門用語、固有名詞、重なった発話、`loss-5-random`・`loss-20-random` の回線を通した音声を含める（[recording-and-transcription.md](architecture/recording-and-transcription.md) の 8 節）。
- **指標**：文字の誤り率（CER。正規化の規則（全角・半角、句読点、数字の書き方）を評価のセットと一緒に固定する）、最初の途中の結果と確定までの遅れ（p50・p95）、話者ごとの流れの 1 時間あたりの費用。
- **合格（K7）**：CER 15% 以下、発話から字幕の表示まで p95 2 秒以内（NFR-010）。
- **いつ**：E8 の前にエンジンを比べ（`asr-evaluation-set`。結果は E8 の変更の `quality.md` に残す）、以後エンジンの版・語彙の仕組み・ASR Adapter を変えるたび。K7 を下回る版には上げない。
- 本番では遅れだけを測る（会議の内容で CER を測らない）。

## 4. 本番での品質検証（シフトライト）

SLI・SLO・アラート・リリースとロールバックは、Ops の [runbooks/](runbooks/README.md) にある。ここには、それらの指標を使って品質を判定する基準と、本番での品質検証の設計を書く。

### 4.1 品質の判定基準

| 指標（runbooks と observability.md で定義） | 品質として許容できない状態 | 対応 |
| --- | --- | --- |
| 待合室もパスコードもない会議の数（毎日の設定の監査） | **1 件でも（K6。常に 0）** | SEV2。作った経路を止め、intent を起票する |
| `effective_settings` と組織の鍵の不一致 | 1 件でも | 設定の解決の不具合として intent（`settings-misresolution.md`） |
| E2EE の会議で録画・字幕・電話の受け手が作られた数 | 1 件でも | SEV1 |
| 内容・秘密の出力の走査の検出 | 1 件でも | SEV2（[incident-response.md](runbooks/incident-response.md)） |
| 良い音声の分（`mos_est` 3.6 以上かつ隠しの率 5% 未満） | 30 日で 97% を下回る。Node の世代・AZ・ブラウザの版に偏って 1 ポイント以上下がる | 偏りがあれば回帰として intent。なければ回線の分布を調べる |
| フリーズのない分 | 30 日で 95% を下回る | 同上 |
| 付け替えの時間（5 秒以内の割合） | 95% を下回る（NFR-004） | 付け替えの intent |
| 意図しない脱落 | 参加者・時間あたり 0.5% を超える（K4） | intent |
| 参加の成功、参加の速さ | 99.5% を下回る、p95 3 秒を超える（K2） | 参加の区間ごとに調べて intent |
| `mos_est` と ViSQOL の差（月次の合成の会議のラボの再計測） | 平均 0.3 を超える | 係数の合わせ直し（QA） |
| **Media Node のカナリアの比較**（[ADR-0055](decisions/0055-media-node-rolling-replacement.md)、同じ時間の古い世代と） | 良い音声の分の差が −0.5 ポイントを超える、フリーズのない分の差が −0.5 ポイントを超える、意図しない脱落が 1.2 倍を超える、`worker.died` が 1 以上、転送の遅れ p99 が 10ms を超える、ENA の超過が 1 以上 | 次の波へ進めない。戻す |
| **Web の版の比較**（[ADR-0056](decisions/0056-client-release-trains-and-meeting-scoped-flags.md)） | 参加の成功が 0.5 ポイント以上下がる、良い音声の分が 0.5 ポイント以上下がる、JavaScript の例外の率が 2 倍 | 割合を 0 に戻す |
| 字幕の遅れ | p95 2 秒を超える状態が 1 日続く（NFR-010） | 字幕の intent |
| 録画の成功率 | 99.9% を下回る。合成の時間 ÷ 録画の長さが p95 0.5 を超える | 録画の intent |
| E2EE の鍵の更新の遅れ（`e2ee.rekey_slow` の率） | 1% を超える | E2EE の intent |
| 保持の期限を過ぎたデータの件数（毎日の監査） | 1 件でも | 保持のジョブの intent |
| K8（月次） | 目標を 2 か月続けて超える | Ops が PM と Dev に報告。Edge の判断（[ADR-0050](decisions/0050-disaster-recovery-and-edge-migration.md)） |

### 4.2 本番での検証

- **合成の監視の会議**：5 分ごとに、各 AZ の Media Node のうち 1 台を順に選び、ヘッドレスの Chrome 2 つで参加する。直接の UDP・TURN の UDP・TURN の TLS 443 の経路ごと。参加の時間、`mos_est`、フリーズ、glass-to-glass、転送の遅れを測る。大阪から東京と、東京から大阪の待機の構成へ（[observability.md](architecture/observability.md) の 7 節）。シナリオは QA が設計し、実行と監視は Ops が担う。
- **設定の監査**（毎日）：待合室もパスコードもない会議、`effective_settings` と鍵の不一致、E2EE の会議の録画・字幕の受け手、保持の期限を過ぎたデータ。
- **TURN の踏み台の合成の試験**（毎日）：Media Node の範囲の外への `CreatePermission` が拒否される。
- **カナリアと版の比較**：4.1 節の基準で、Node の世代・Web の版ごとの SLI を比べる。
- **クライアントの品質の報告**：ブラウザ・経路・`client_kind`・Node の世代の別に日次で見る。

### 4.3 訓練の合格基準

| 訓練 | 頻度・環境 | 合格 |
| --- | --- | --- |
| **AZ の障害** | 四半期、`media-staging`（負荷のボットで会議を載せ、1 つの AZ の Media Node を全部止める） | 全参加者の音声が p95 5 秒以内に戻る（NFR-004）。残りの AZ の点が 0.85 以下。Actor の制御が 10 秒以内に戻る |
| **東京のリージョンの障害（DR）** | 四半期、staging・`media-staging` | 判断から大阪で新しい会議に参加できるまで **RTO 1 時間以内**。Aurora の RPO 1 分以内。大阪で受けられた同時の参加者の数を記録する（[runbooks/disaster-recovery.md](runbooks/disaster-recovery.md) の F） |
| 本番の switchover | 年 1 回、本番の夜間 | 大阪で予定の作成と参加を受け、東京へ戻す。合成の監視の失敗が手順の窓の外で 0 |
| Actor の障害の注入 | 週次、`media-staging` | 2.2.1 節の障害の注入の期待を満たす |
| make-before-break の移動 | 四半期、`media-staging` | 音声の途切れ 500ms 以下 |
| DDoS の防御のモード | 四半期と Media Node の変更の時、`media-lab` | 既存の参加者の途切れなし。Shield の保護を加えて外すまで 30 分以内（手順の訓練は半年ごと） |
| PITR からの復元 | 四半期 | 暗号文（パスコード、チャット）が復号できる |

### 4.4 異常から intent へ

判定基準を外れた指標、監査の不一致、訓練の不合格、インシデントの振り返りは、Claude が調査結果を Intent の Issue として起票する（[project-management.md](../../../docs/project-management.md)）。調査に渡すのは、人が取り出した、会議の内容と個人データを含まないログとメトリクス（ID・数値・時刻）だけにする。PM が受理したものは、`intent.md` か Epic・Story になり、通常の Plan → Design の流れに乗る。メディアの回帰は、それを捉える回線の条件を 2.2.1 節の行列に足す提案も一緒に出す（QA の承認）。

## 5. テスト計画

各 Epic のリリースの合否基準。Story の一覧は [roadmap.md](roadmap.md) にある。

| Epic | 重点 | リリースの合否基準 |
| --- | --- | --- |
| E1 基盤と品質の計測 | ラボ、PR の報告、RLS、内容の走査、品質の報告の経路 | netem のラボで必須の 4 条件が回り、PR の品質の報告が出る。ラボの揺れの確認（20 回で 19 回同じ）に合格。RLS の試験が通る。内容・秘密の走査が CI と本番で動く。`qos.report` の契約の試験が通る。すべてのアラートが runbook を持つ |
| E2 会議の骨格と Web クライアント（ベータ） | 参加、経路、音声と映像の基本、Actor | NFR-002（直接 3 秒・TURN 5 秒）を経路の結合テストで満たす。必須の 4 条件と `loss-5-random` に合格。PROP-SIG-001〜006 が夜間の 100 万の列で通る。4 ブラウザの E2E。**社外への公開（ベータ）は、E3 の `join-guard-invariant`・`passcode-format-storage`・`waiting-room-core`・`join-rate-limits` と、法務の L1・L5 の後**。下りの平均・カメラの割合・TURN の割合の計測が動いている |
| E3 会議の安全と主催者の操作 | 0 件の守り、ban、推測、主催者の操作 | PROP-SEC-001〜004 が通り、本番の監査で待合室もパスコードもない会議 0。主催者の操作の決定表の全行。応答の時間の差 p99 10ms 以内。攻撃の試験（CAPTCHA、総当たり）。`host.mute`・`host.suspend` から音声が止まるまで p95 500ms。報告の添付は法務の L2 の後 |
| E4 メディアの品質と帯域の適応 | 回線の劣化の行列の全部、RED、`mos_est` | **2.2.1 節の行列の全条件が 4 ブラウザで合格**。RED の FEC だけ・distance 1 ＋ FEC の比較が記録されている。RED のベクトルと PROP-RED-001、PROP-BWE-001〜003 が通る。`mos_est` と ViSQOL の差 0.3 以下 |
| E5 画面共有・チャット・端末の処理 | 共有の文字、チャットの宛先、仮想背景 | 共有の OCR の一致率、PROP-CHAT-001〜004、仮想背景の性能と IoU、処理しない映像を送らない、axe の違反 0 と手動の確認。モデルのファイルの利用の条件を法務が確かめている |
| E6 予定・カレンダー・組織と管理 | 設定の解決、カレンダーの同期 | PROP-SCH-001〜004、PROP-ADM-001〜004、解決の表。Google と Microsoft の試験のテナントでの作成・変更・取り消し。SAML・OIDC の試験のテナント |
| E7 規模と耐障害 | 1 台の上限、付け替え、Actor の障害、DDoS | **L0〜L2 と L6 に合格**し、capacity.md の上限の表を実測で埋めた。障害の注入の期待を満たす（Media Node の停止で p95 5 秒、Actor の停止でメディアの途切れ 0）。**音声の枠の PoC の結果が記録されている**（ADR-0057）。合成の監視の会議が動いている |
| E8 録画と字幕 | 同意、表示、録画の成功、CER | PROP-REC-001〜004、決定表。Recorder の障害で 15 秒以内。合成の速さ 0.5 以下。**ASR の eval で K7（CER 15% 以下、p95 2 秒）**。法務の L2・L3・L6 が済むまで、録画・字幕の Story は受け入れない |
| E9 E2EE | 鍵、3 層の拒否、ブラウザ | **PROP-E2EE-001〜006、SFrame（RFC 9605 付録 C）と MLS のベクトル、3 層の拒否（1 層ずつ無効でも拒否）**。100 人で鍵の更新 p95 1 秒・最大 2 秒。E2EE の会議の劣化の行列の結果を非 E2EE と並べる（MOS の差 0.2 以内を目安）。`e2ee-poc-transform` の結果が記録されている。一般への提供は法務の L4 の後 |
| E10 大きな会議と Media Node の運用 | カナリア、make-before-break、音声の枠、DR | カナリアの比較の自動の判定（わざと音声を落とす AMI で波が止まる）。make-before-break の途切れ 500ms 以下。PROP-SFU-005・006 と、300 人の会議の負荷。**AZ と DR の訓練が 4.3 節の基準を満たす**。保持の削除の毎日の監査で 0 |
| E11 公開 API と Webhook | 守り、権限、配送 | PROP-API-001〜004、RFC 9700 の確認の表の否定の試験、SSRF の試験、Webhook の本文に内容が現れない、OpenAPI の差分 0 |
| E12 運用と GA の準備 | GA の判定 | **L3〜L5 に合格**。外部のペンテストの Critical・High がすべて修正済み。DR の訓練の合格。runbooks がそろっている（[runbooks/README.md](runbooks/README.md) の 4 節の「E12 までに作る」もの）。intent の K1〜K8 の試用の結果がある。法務の L1〜L8 のうち GA の判定に要るもの（L2・L4・L6・L8）が済んでいる |
| E13 アプリ（MVP の後） | 状態機械のベクトル、版の互換 | TypeScript と Rust の状態機械のベクトルが全件一致（夜間 1 万本）。N−2 の版の契約の試験。Electron の安全の設定の検査。libwebrtc の追従の期限 |
| E14 電話からの参加（MVP の後） | 同意、E2EE、不正な発信、遅れ | PROP-TEL-001〜003、IVR・ダイヤルアウトの決定表、電話の参加者の遅れ p95 400ms（2.2.1 節）。法務の L1・L7 の後 |

## 6. 責任分担

| 活動 | PM | Dev | QA | Ops | エージェント |
| --- | --- | --- | --- | --- | --- |
| リスクの特定と品質戦略 | 協力 | 協力 | 責任者 | 協力 | 草案 |
| spec の受け入れ基準・決定表・性質 | 承認 | 協力 | 承認 | — | 草案 |
| 回線の劣化の行列と閾値 | — | 協力 | 責任者 | — | 計測 |
| `mos_est` の係数 | — | 協力 | 承認 | — | 合わせ込み |
| テストの実装 | — | レビュー | レビュー | — | 実装 |
| 確認ループの実行 | — | 確認 | — | — | 実行 |
| eval の維持（エージェント、ASR） | — | 協力 | 責任者 | — | 実行 |
| SLI・SLO・アラートの定義 | 協力 | 協力 | 協力 | 責任者 | — |
| 品質の判定基準、カナリアの比較の基準 | 協力 | — | 責任者 | 協力 | — |
| 負荷試験、DR・AZ の訓練の判定 | — | 協力 | 責任者（合否） | 実行 | 集計 |
| 本番での品質検証（監査、合成の監視） | — | 協力 | 責任者 | 実行 | 調査・起票 |
| K8 の月次の確認 | 承認（目標） | 協力 | 計測の定義 | 責任者 | 集計 |
| 異常の intent の受理 | 責任者 | — | 協力 | 協力 | 起票 |
