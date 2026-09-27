---
status: accepted
date: 2026-09-27
---

# ADR-0029: 通話は自前の中継の論理と 050 の番号で相手の番号を隠し、本人と車は顔の照合と PIN で確かめ、評価の低い組は二度と配車しない。録音・録画は法務の確認まで作らない

詳細は [safety-and-trust.md](../architecture/safety-and-trust.md) の 5〜7・9 節。

## Context

迎車の間、乗客とドライバーは連絡を取る必要がある（「どこにいますか」）。互いの電話番号を知らせると、乗車の後に相手に連絡できてしまう。日本版ライドシェアの車は自家用車で、乗客が乗る車を見分けにくい。評価は、乗客とドライバーの互いの安心と、事業者の指導の材料になる。

事実（2026-09-27 に確認）：

- 本家の日本の安全の機能は、電話番号の匿名化、車とドライバーの写真での確認、顔での本人確認、相互の評価を含む（[Uber の安全（日本）](https://www.uber.com/jp/ja/ride/safety)、[Uber アプリの安全機能](https://www.uber.com/jp/ja/newsroom/uber-app-safety-features)）。
- Twilio の Proxy は Public Beta で SLA の対象外（[Twilio Proxy](https://www.twilio.com/docs/proxy)）。Twilio の日本の音声は緊急の番号への発信を許さず、国内の通話は東京の edge を使う（[Japan: Voice Guidelines](https://www.twilio.com/en-us/guidelines/jp/voice)）。Amazon Connect は東京で 050・03・06 の番号を日本の法人の書類つきで取れる（[Claim phone numbers in the Tokyo Region](https://docs.aws.amazon.com/connect/latest/adminguide/connect-tokyo-region.html)）。Amazon Chime SDK の海外の番号は SIP Media Application の着信（Dial-In）にだけ使え（[Requesting international phone numbers](https://docs.aws.amazon.com/chime-sdk/latest/ag/request-intl-numbers.html)、2026-09-27 に確認）、proxy のセッションは Voice Connector の機能（`CreateProxySession`）なので、日本の番号の proxy は候補にしない。

## Options

通話：

1. **自前の中継の論理（`call-proxy`）と、提供者の 050 の番号。提供者は PoC で選ぶ**
2. **提供者の番号の匿名化の製品（Twilio Proxy など）をそのまま使う**
3. **アプリの中の VoIP の通話だけにする**

確認：

- a. **ドライバーは顔の照合（その日の最初の出庫と 1 日 1 回の抜き打ち）、日本版ライドシェアの乗車は PIN**
- b. **車とドライバーの写真の表示だけ**

評価の結果：

- i. **2 以下で組を拒否し、タクシーのドライバーの停止は事業者が決める**
- ii. **平均が閾値を下回ったらこの基盤が自動で停止する**

## Decision

1、a、i を採用する。

- セッションの鍵は `(中継の番号, 発信の番号)`。有効な期間は受諾から終わりの 30 分後まで。登録の番号でない発信・非通知はつながない。録音しない。記録（時刻・長さ）は 90 日。中継の番号から緊急の番号にはつながない。
- 安全とサポートの担当も同じ仕組みで番号を隠して電話する。理由と監査ログを必須にする。
- 乗車の中のメッセージは定型文と 200 文字の文。電話番号・URL は伏せ字。保持は 30 日（L4・L7 の確認で直す）。
- ドライバーは、その日の最初の出庫と、1 日 1 回の抜き打ち（出庫中の無作為な時刻。迎車中・乗車中は避ける）で顔の照合をする（統合の工程で「出庫のたび」から改めた。[ADR-0037](0037-authentication-device-integrity-and-fraud-response.md) と同じ）。画像は 30 日、生体の情報の専用の KMS の鍵（`biometric`。[ADR-0036](0036-location-privacy-keys-retention-and-audited-access.md)）で暗号化し、テンプレートは持たない。2 回続けて通らなければ出庫させず（抜き打ちなら新しいオファーを止め）、事業者が確かめる。L4 の確認まで `legal.l4.driver_face_check` の裏に置き（[ADR-0043](0043-flag-taxonomy-legal-gates-and-safety-defaults.md)）、その間は事業者の点呼の本人確認に頼る。
- 日本版ライドシェアの乗車は 4 桁の PIN を必須にする。タクシーは乗客の設定で任意。
- 評価は双方向の 1〜5、降車から 7 日まで、直近 100 の平均（5 件未満は出さない）。2 以下で組を `safety_pair_blocks` に入れ、配車の除外に使う。タクシーのドライバーの停止は事業者が決め、この基盤は安全の担当が確かめた重大な問題のときだけ止める。
- 車内の録音・録画は、L7 の確認まで作らない。
- 2 を採らない理由：提供者の製品の状態（Public Beta、新規の受け付け）が不確かで、提供者を替えると論理ごと作り直しになる。
- 3 を採らない理由：迎車の場面で、データの通信が弱い場所では VoIP がつながりにくい。S2 で電話の代わりの経路として加える。
- b を採らない理由：なりすまし（登録と違う人の乗務）と、見分けにくい自家用車の取り違えを防げない。
- ii を採らない理由：タクシーのドライバーは事業者に属し、処置は雇用と労働の論点（L5）に触れる。評価は利用者の外の要因（渋滞・規制）で下がる。

## Consequences

- 良くなること：
  - 乗車の外で相手に連絡できない。提供者を替えても論理は変わらない。
  - 乗る車の取り違えと、なりすましを減らせる。
- 引き受けるコスト：
  - 050 の番号の取得の書類と、中継の運用。つながるまでの時間は提供者次第（**未検証**。E10 の `masked-calling-poc`）。
  - 顔の照合は L4 の確認まで legal のフラグの裏で、その間の本人確認は事業者に頼る。
  - 評価の閾値は **未検証** で、見直しが要る（E10 の `ratings-and-pair-blocks`。QA・PM の確認事項）。

## Confirmation

- 性質ベーステスト：PROP-SAFE-003（通話の期間と発信の番号）、PROP-SAFE-004（拒否の組にオファーを作らない）。
- PoC：E10 で提供者を選び、選定の続きの ADR を書く。
- レビュー：録音・録画を始める変更、相手の電話番号をアプリに返す API を差し戻す。
