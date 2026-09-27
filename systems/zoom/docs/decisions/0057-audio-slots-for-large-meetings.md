---
status: accepted
date: 2026-09-27
---

# ADR-0057: 100 人を超える会議の音声は、受け手ごとに 3 つの「音声の枠」を持たせ、話者の音声を枠へ付け替えて送る

## Context

[ADR-0011](0011-forwarding-and-layer-selection.md) は、受け手に送る音声を最大 3 本にすると決めた。実装は、受け手ごとに、すべての送り手の音声の producer の consumer を作り、上位 3 人以外を止める（`pause`）形である（[media-server-sfu.md](../architecture/media-server-sfu.md) の 5.3 節）。

この形では、音声の consumer の数が参加者の数の 2 乗で増える（[capacity.md](../architecture/capacity.md) の 4 節）。

| 会議 | 音声の consumer（作る数 N × (N − 1)） | 動いている数 |
| --- | --- | --- |
| 100 人（S1 の上限） | 9,900 | 300 |
| 300 人（S2 の上限） | 約 9 万（89,700） | 900 |
| 1,000 人（S3 の上限） | 約 100 万（999,000） | 3,000 |

- 1 台の Media Node の consumer の上限は、初期見積もりで 24,800（62 worker × 400。[ADR-0053](0053-capacity-model-cost-target-and-load-bots.md)）。300 人の会議は、音声だけで 1 台の約 3.6 倍を使う。
- 止めた consumer でも、作る・止める・再開の操作、worker のメモリ、`inventory` の大きさ、付け替えのときの作り直しの量が、人数の 2 乗で増える。
- mediasoup の consumer は 1 つの producer に結び付き、途中で別の producer に付け替えられない（[mediasoup v3 API](https://mediasoup.org/documentation/v3/mediasoup/api/)、2026-09-27 に確認）。
- mediasoup は、Node.js の側で RTP を受け取り・送り出す `DirectTransport`（`DataProducer`・`DataConsumer` と、RTP の `producer.send()`・consumer の `rtp` イベント）と、別の router・別のプロセスと RTP をやり取りする `PipeTransport`・`PlainTransport` を持つ（同上、2026-09-27 に確認。`DirectTransport` の RTP の扱いの性能は**未検証**で、E7 の `audio-slot-forwarder-poc` で測る）。

S1（100 人まで）は今の形で収まる。S2 の前に、大きな会議の音声の形を決める必要がある（capacity.md と media-server-sfu.md の持ち越し）。

## Options

1. **100 人を超える会議では、受け手ごとに 3 つの「音声の枠」を持たせる。会議ごとに枠の数だけの「枠の producer」を作り、話者の音声を枠へ付け替えて流す（枠の切り替えの転送器）。受け手は枠の producer の consumer を 3 つだけ持つ**
2. 今の形のまま（受け手ごとに全員の consumer を作り、止める）
3. サーバーで音声を混ぜる（音声だけの MCU）
4. mediasoup の worker（C++）に、consumer の producer を付け替える機能を足す

## Decision

1 を採用する。

- **使う条件**：開催の参加者の上限（予定の人数か、組織の設定）が 100 人を超える会議。Actor が開催の開始で決め、会議の状態（`audio_mode`：`per_sender`・`slots`）に入れる。100 人以下の会議（S1 のすべて）は、ADR-0011 の形のまま。途中で 100 人を超えても、その開催の間は形を変えない（開始のときに上限で決める）。
- **枠**：会議ごとに 3 つの枠（`slot-0`〜`slot-2`）。受け手の下りが 150 kbps 未満のときは、その受け手は枠 2 つだけを受ける（ADR-0011 と [ADR-0019](0019-bandwidth-estimation-and-layer-allocation.md) の音声の枠に合わせる）。
- **枠の転送器**：
  - Node Agent が、会議の主な worker（話者の検出を置く worker。media-server-sfu.md の 6 節）に、枠ごとの producer を作る。枠の producer の入力は、`DirectTransport`（Node Agent の中で RTP を受けて送り直す）を既定にする。
  - 転送器は、`AudioLevelObserver`・`ActiveSpeakerObserver` の結果から、枠に入れる話者を選ぶ（上位＋主な話者＋直近 1.5 秒。ADR-0011 と同じ選び方と、1.5 秒の保持）。選んだ送り手の音声の producer の consumer（転送器の側に 1 本ずつ、話者の候補だけ）から RTP を受け、枠の SSRC・連番・時刻に書き換えて、枠の producer へ送る。
  - 切り替えは、送り手の DTX の無音の区切りか、新しい話者の最初のパケットで行う。切り替えのときに時刻を連続させ、受け手のジッタバッファに大きな飛びを見せない。
  - 各枠に今どの参加者が入っているかは、`eph` の `audio.slots`（`{slot, participant_id}` の列、変わったときだけ）で受け手に知らせる。音量の輪と字幕の話者の表示に使う。
  - 性能が足りなければ（1 会議あたりの転送器の処理が Node Agent のイベントループを 1 ms 以上止める、など）、転送器を `PipeTransport` でつないだ別のプロセス（Rust）に移す。どちらにするかは PoC で決める（下）。
- **受け手**：枠の producer の consumer を 3 つ（か 2 つ）だけ持つ。音声の consumer は受け手 1 人あたり 3 で、会議の人数によらない。300 人で 900、1,000 人で 3,000。
- **RED**：枠の producer は、送り手が送った形（RED か Opus）をそのまま流す。受け手ごとの RED の剥がし（残すか剥がすか。[ADR-0017](0017-opus-dtx-fec-red.md)）は、枠の consumer に今と同じく当てる。
- **E2EE**：枠は SFrame の暗号文をそのまま流す。受け手は SFrame のヘッダーの KID で送り手と鍵を選ぶので、枠の中で送り手が替わっても復号できる（[ADR-0028](0028-sframe-encoded-transform-and-dependency-descriptor.md)）。E2EE の会議の上限は S1 で 100 人なので（[ADR-0030](0030-security-code-and-e2ee-feature-limits.md)）、枠と E2EE の組み合わせは S2 で上限を上げるときに確かめる。
- **Recorder・Transcriber・Phone Bridge**：今と同じく、送り手ごとの producer を受ける（録画と字幕は話者ごとの音声が要る。[ADR-0025](0025-recording-per-track-capture-and-offline-compose.md)、[ADR-0026](0026-asr-engine-amazon-transcribe-with-adapter.md)）。枠を使うのは参加者の受け手だけ。
- **カスケード（S2）**：枠の producer は主な Node で作り、他の Node の受け手へは、枠の producer を pipe で送る（3 本）。送り手ごとの音声を Node の間で全部運ばない。
- **PoC**：E7 に `audio-slot-forwarder-poc` を置き、E10 の `audio-slot-forwarder` の spec を承認する前に結果を記録する。確かめること：
  - 300 人（ボット）の会議で、転送器の CPU と遅れの増加（p99 5 ms 以内を目安）
  - 切り替えのときの音声の途切れと雑音（聞いた人の評価と、`concealedSamples` の増加）
  - Chrome・Firefox・Safari の受け手が、1 つの SSRC の中の送り手の切り替えを問題なく再生するか
  - `DirectTransport` と、`PipeTransport` の別のプロセスの比較
- 2 を採らない理由：上の表のとおり、300 人の会議で音声だけで 1 台に収まらず、S2 の台数の見積もりが成り立たない。
- 3 を採らない理由：サーバーで復号と符号化が要り、遅れと CPU が増える。E2EE と両立しない。受け手ごとに自分の声を除いた混ぜ方が要る。
- 4 を採らない理由：mediasoup の consumer の中心の仕組みに手を入れることになり、RED（ADR-0017）と DD（ADR-0028）に加えて、フォークの差分が大きくなる。上流に取り込まれる見込みも低い。1 の結果が悪いときの退路にする。

## Consequences

- 良くなること：
  - 音声の consumer の数が、会議の人数に比例する（受け手ごとに 3）。S2・S3 の台数の見積もりが、映像の consumer で決まるようになる。
  - 付け替え（[ADR-0013](0013-media-node-failover-and-reattach.md)）のときに作り直す音声の consumer が少ない。
- 引き受けるコスト：
  - 枠の転送器という新しい部品を持つ。RTP の書き換え（SSRC・連番・時刻）の誤りは、音声の途切れとして現れる。試験のベクトルで守る（PROP-SFU-005）。
  - 話し始めの欠け（250〜500ms）と、4 人目以降の声が届かないことは、ADR-0011 と同じく残る。
  - 受け手の側の音声の要素は、枠の数（3）に固定される。音量の輪の表示は `audio.slots` で付け替える。
  - 100 人を境に 2 つの形を持つ。試験の組み合わせが増える。

## Confirmation

- 性質ベーステスト（PROP-SFU-005）：任意の話者の列と切り替えで、枠の出力の RTP の連番は抜けも重なりもなく増え、時刻は減らない。枠の中の送り手の切り替えは、保持の 1.5 秒より短い間隔で起きない。
- 性質ベーステスト（PROP-SFU-006）：`audio_mode = slots` の会議で、受け手 1 人の音声の consumer は 3 以下（下り 150 kbps 未満なら 2 以下）。
- 負荷試験（E7 の PoC、E10）：300 人の会議を 1 台に置き、音声の consumer が 900 以下で、転送の遅れの p99 が 10ms 以内、見張りの実ブラウザの `mos_est` が 100 人以下の形と比べて 0.1 以上下がらない。
- 回線の劣化の試験：`loss-20-random` で、枠の形の NFR-003（MOS 3.0 以上）を満たす。
