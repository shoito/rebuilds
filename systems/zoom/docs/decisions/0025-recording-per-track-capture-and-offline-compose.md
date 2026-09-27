---
status: accepted
date: 2026-09-27
---

# ADR-0025: 録画は SFU から producer ごとの生の RTP を受けて書き、1 本の動画への合成は会議の後に行う

## Context

クラウド録画（[intent.md](../intent.md) の MVP）は、音声・映像・画面共有を 1 つの動画にまとめて保存する。SFU は映像を合成しないので（[ADR-0002](0002-media-topology.md)）、録画のためだけにサーバーで合成が要る。

求めることは次のとおり。

- 成功を知らせた録画は失わない。会議の終了から、録画の長さの半分以内に見られる（NFR-010）。
- 録画の障害で、会議のメディアを止めない（本題材の AGENTS.md）。
- 同意していない人の音声と映像を録らない（[ADR-0027](0027-capture-consent-and-indicators.md)）。
- E2EE の会議では動かない（[ADR-0004](0004-encryption-and-e2ee.md)）。

Media Node は、受け手ごとの購読の集合を `subscriptions.apply` で受ける。Recorder・Transcriber は、この受け手の 1 つとして足す想定になっている（[ADR-0011](0011-forwarding-and-layer-selection.md)、[media-server-sfu.md](../architecture/media-server-sfu.md) の 11 節）。mediasoup は、WebRTC ではない RTP の受け渡しのために PlainTransport を持ち、SRTP を有効にできる（[mediasoup v3 API](https://mediasoup.org/documentation/v3/mediasoup/api/)、2026-09-27 に確認）。

## Options

1. **見えない参加者のボット**：ヘッドレスのブラウザ（Chrome）で会議に入り、画面を描いて、その画面を符号化して保存する（Jitsi の Jibri のような形）
2. **SFU から受けて、その場で合成する**：Recorder が RTP を受け、復号し、会議の間に 1 本の動画に合成して符号化する
3. **SFU から受けて生の RTP を書き、会議の後に合成する**：Recorder は復号せずに producer ごとの RTP を保存し、Composer が会議の後にまとめて合成する

## Decision

3 を採用する。詳細は [recording-and-transcription.md](../architecture/recording-and-transcription.md) の 4 節。

- Actor が `subscriptions.apply{receiver: "rec_…", plain: {...}}` で、Node に Recorder 向けの PlainTransport（SRTP あり）と consumer を作らせる。
- Recorder は SRTP を外した RTP を、受けた時刻と一緒に producer ごとに書き、10 秒で区切って S3 に上げる。マニフェスト（producer の出入り、話者、共有、一時停止、欠け）を追記する。
- 話者と共有の出来事は Actor から受ける。録画の話者は会議の画面の話者と同じにする。
- Composer は会議の後に区切りを並べ、時刻を合わせ、`speaker_share`（720p）・`audio` などを作る。成果物を書き終えたら「成功」とし、通知する。
- 生の区切りは合成の成功から 7 日残し、合成をやり直せるようにする。
- 1 を採らない理由：会議 1 つにブラウザ 1 つと描画・符号化の CPU（GPU）が要り、費用が大きい。ブラウザの描画の不具合がそのまま録画に入る。落ちたら、その間の録画はすべて失われる。参加者の一覧に出ない参加者として WebRTC で入るので、同意していない人を録画から外す制御が、画面の描画の側に分散する。
- 2 を採らない理由：会議の間ずっと、復号・合成・符号化の CPU を使う。Recorder が落ちると、書きかけの符号化の出力が壊れやすい。合成の不具合を直しても、過去の録画を作り直せない。ライブ配信（MVP の外）をするなら、別の ADR で 2 を足す。

## Consequences

- 良くなること：
  - Recorder は符号を解かないので、CPU をほぼ使わない。1 会議 1 タスクの小さなタスクで足りる見込み（未検証）。
  - Recorder が落ちても、失うのは閉じていない区切り（最大 10 秒）と付け替えの数秒だけ。
  - 合成の不具合やレイアウトの変更を、生の区切りが残っている間は作り直せる。
  - 同意と E2EE の制御は、Actor が作る購読の集合だけで決まる。
- 引き受けるコスト：
  - 見られるようになるまで、会議の後の合成の時間がかかる。NFR-010（録画の長さの半分以内）を満たすには、録画の長さの 2 倍より速く合成する必要がある。足りなければ区間ごとに並列で合成する。
  - 生の RTP の置き場所の費用がかかる（合成の成功から 7 日）。
  - RTP の時刻合わせ、欠けの埋め方、simulcast の層の切り替えの処理を、Composer に自分で書く必要がある。

## Confirmation

- 結合試験：3 人の会議を 10 分録画し、`speaker_share` と `audio` ができる。話者の切り替わりが Actor の出来事と 500ms 以内で合う。
- 障害の注入：録画中に Recorder を止めても、失う長さが 15 秒以内で、合成が成功する。
- 性質ベーステスト：マニフェストの区切りの番号の欠けが、必ず `gap` の行で説明される（PROP-REC-004）。
- 計測：合成の時間 ÷ 録画の長さを E8 で測り、0.5 を超えたら並列の合成に切り替える。
