---
status: accepted
date: 2026-09-27
---

# ADR-0054: 回線の劣化の試験は、media-lab の EC2 の上で、参加者ごとのネットワークの名前空間と tc netem で作る。Safari は macOS の dummynet で夜間に回す

## Context

本題材の [AGENTS.md](../../AGENTS.md) は、メディアに触れる PR に、損失・揺らぎ・帯域の制限・遅れを加えた試験を求め、遅れ・MOS の推定・フリーズ・追従の時間を PR に載せることを求めている。試験の条件は各領域で決めた（[codecs-and-bandwidth-adaptation.md](../architecture/codecs-and-bandwidth-adaptation.md) の 11.1 節、[media-server-sfu.md](../architecture/media-server-sfu.md) の 12 節、[network-traversal.md](../architecture/network-traversal.md) の 12 節）。

- Linux の `tc` の `netem` は、遅れ・揺らぎ・損失（ランダム、Gilbert-Elliott の型）・重複・並べ替え・帯域の制限を加えられる（[tc-netem(8)](https://man7.org/linux/man-pages/man8/tc-netem.8.html)、2026-09-27 に確認）。
- Chromium は、偽のカメラ・マイクにファイルを入れられる（[clients.md](../architecture/clients.md) の 12 節）。
- Playwright の WebKit は Safari そのものではない（同上）。
- 試験の結果は、実行ごとに揺れる。閾値に近い値は、1 回の実行では判定できない。

## Options

1. **`media-lab` のアカウントの EC2 の上で、参加者ごとにネットワークの名前空間を作り、名前空間の間の veth に netem を掛ける。Media Node と TURN は同じ構成の AMI で同じ台か別の台に置く。Safari は macOS の上で dummynet を使う**
2. GitHub のホストのランナーの上で netem を掛ける
3. 実機の端末と、網の機器（回線の模擬の装置）を置いた試験室

## Decision

1 を採用する。詳細は [delivery.md](../architecture/delivery.md) の 3 節。

- **基盤**：
  - `media-lab` のアカウントに、一時的なセルフホストのランナー（x86 の EC2、1 つのジョブで 1 台、終わったら消す）を置く。Chrome・Edge・Firefox は x86 の Linux で動かす。
  - 1 台の中に、参加者ごとのネットワークの名前空間（`ns-p1`…）、Media Node の名前空間（`ns-sfu`）、TURN の名前空間（`ns-turn`）、それらをつなぐ「WAN」の名前空間を作る。netem と帯域の制限（`tbf`）は、WAN の側の veth の出口に掛ける（入りは `ifb` で掛ける）。
  - Media Node と TURN は、本番と同じ AMI の中身（Node Agent、mediasoup、coturn）を、コンテナか同じ台の上のプロセスで動かす。
  - 大きな会議（25 人以上）と負荷の試験は、Media Node を別の EC2（本番と同じ種類）に置き、ボット（[ADR-0053](0053-capacity-model-cost-target-and-load-bots.md)）を使う。
- **測り方**：
  - glass-to-glass：送り手の偽のカメラに、フレームごとの時刻を埋めた映像（合成）を入れ、受け手のページで描画したフレームを canvas に取って時刻を読む。
  - mouth-to-ear：送り手の偽のマイクに、印の音（チャープ）を入れ、受け手の音声のトラックを WebAudio で取り出して印の時刻を比べる。
  - 音声の品質：ViSQOL v3（speech モード）と、`mos_est`（[ADR-0052](0052-media-slis-and-mos-estimation.md)）の両方を出す。
  - フリーズ、解像度、fps、追従の時間：`getStats`（[codecs-and-bandwidth-adaptation.md](../architecture/codecs-and-bandwidth-adaptation.md) の 11.2 節）。
- **揺れの扱い**：各条件を 5 回回し、中央値で判定する。基準（`main` の直近 7 日の結果）との差も PR に載せる。閾値そのものは quality.md で決める（QA の承認）。
- **回し方**：
  - PR：メディアに触れる変更（[delivery.md](../architecture/delivery.md) の 2 節のパスの一覧）で、代表の条件（`loss-20-random`、`bw-step-down`、`rtt-200`、`mixed-3`）を Chrome で必須にする。約 20 分の見込み（**未検証**。E1 の `media-paths-and-required-checks` で実測する）。
  - 夜間：全部の条件 × 4 ブラウザ（Safari を含む）× Beta・Dev の版。
  - Safari：macOS の EC2（mac のインスタンス）か社内の Mac で、`dnctl`・`pfctl`（dummynet）で同じ条件を作る。iOS は実機を週に 1 回。
- 試験の音声と映像は、利用の条件が明らかな公開のデータセットか合成だけ（本題材の AGENTS.md）。
- 2 を採らない理由：共有の台の揺れ（CPU の奪い合い）が結果に混ざる。台の種類と CPU の固定を選べない。
- 3 を採らない理由：PR ごとに回せない。S1 の段階では、網の機器の模擬は netem で足りる。実機の試験は週に 1 回で補う。

## Consequences

- 良くなること：
  - PR ごとに、本番と同じ部品で、決まった回線の条件を再現できる。
  - 結果の数（遅れ、MOS、フリーズ）を、基準との差で示せる。
- 引き受けるコスト：
  - `media-lab` の EC2 と mac のインスタンスの費用（mac のインスタンスは Dedicated Host で、解放できるまでの最低の割り当ての時間が 24 時間ある。[Amazon EC2 Mac instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html)、2026-09-27 に確認）。
  - netem は端末の OS の中の網の処理（Wi-Fi の再送、モバイルの網の振る舞い）を再現しない。実機の週次の試験で補う。
  - 5 回の実行で、PR の待ちが伸びる。

## Confirmation

- 同じコミットで同じ条件を 20 回回し、判定（合格・不合格）が 19 回以上同じになる（揺れの確認。基盤を変えたときに行う）。
- 基盤の自己診断：試験の前に、netem を掛けない条件で `mos_est` 4.2 以上・フリーズ 0 を確かめ、満たさなければ試験の基盤の失敗として扱う（PR の失敗にしない）。
