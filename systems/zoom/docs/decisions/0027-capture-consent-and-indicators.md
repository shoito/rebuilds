---
status: accepted
date: 2026-09-27
---

# ADR-0027: 録画・文字起こしの間は、本人が同意するまで話させない。表示できないクライアントは入れず、E2EE の会議では 3 か所で開始を拒否する

## Context

[intent.md](../intent.md) の「守るべき振る舞い」は、次を求める。

- 録画・文字起こしが動いている間は、すべての参加者にそれが見える。途中から入った人にも見える。
- E2EE の会議で、録画・字幕・電話からの参加は動かない。

本家は、録画が始まると同意の表示を出し、OK で同意、Leave で退出を選ばせる。管理者は、表示を社外の参加者だけに出すか全員に出すかを選べる（[Providing consent to be recorded](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059819)、2026-09-27 に確認）。表示に応えないまま会議に残る人の音声と映像をどう扱うかは、文書に書かれていない。

同意の取り方、同意しない人の扱い、社外の参加者への通知は、法務の確認待ちである（intent.md の L3）。設計はどの結論にも対応できる形にする必要がある。

会議の状態は Meeting Actor が持ち（[ADR-0005](0005-meeting-state-and-signaling.md)）、ミュートの強制は Media Node で producer を止めて行う（[ADR-0009](0009-host-controls-enforcement.md)）。録画は Actor が作る購読の集合で決まる（[ADR-0025](0025-recording-per-track-capture-and-offline-compose.md)）。

## Options

1. **通知だけ出し、残ることを同意とみなす（本家に近い形）**
2. **本人が「同意して続ける」を押すまで、その人のマイク・カメラ・共有を止める。見る・聞くことはできる**
3. **同意しない人の音声と映像を、録画からだけ外す（会議では話せる）**

## Decision

2 を採用する。詳細は [recording-and-transcription.md](../architecture/recording-and-transcription.md) の 7 節と 10 節。

- **状態**：録画（`off`・`starting`・`on`・`paused`・`stopping`・`failed`）と文字起こし（`off`・`on`）は Actor の状態に入れ、全員に配る。待合室の人にも録画中であることだけを示す。
- **表示**：クライアントは `hello` で `capture_indicator.v1` を申告する。申告しない版は、録画か文字起こしが動いている会議に入れない。入った後に動き出したら、その接続を閉じる（ban にはしない）。
- **同意**：
  - 動いている種類（`recording`・`transcription`）ごとに、本人の同意の記録が要る。記録は Aurora に書いてから配る。表示した文言の版も残す。
  - 記録がない人の `self.update{muted:false}`・`video:true`・`share.request` を、Actor が `consent_required` で拒否する。Media Node の producer は `paused` のままにする。
  - Recorder・Transcriber の購読に、同意していない人の producer を入れない。
- **E2EE**：開始を 3 か所で拒否する。API（`auto_recording`・`auto_captions` を E2EE の会議に付けられない）、Actor（`e2ee_incompatible`）、Media Node（`e2ee: true` の router に `rec_…`・`asr_…` の受け手を作らない）。
- 1 を採らない理由：表示を見ていない人（画面を見ていない、古いクライアント、改造したクライアント）の声も録られる。「同意した」という記録が、実際の意思と結び付かない。L3 の結論が「明示の同意」になったとき、対応できない。
- 3 を採らない理由：会議では聞こえていた発言が、録画では抜ける。録画を議事の記録として使う主催者にとって、欠けた録画になる。欠けたことに気づきにくい。

## Consequences

- 良くなること：
  - 同意していない人の音声と映像が、録画・文字起こしに入らない。改造したクライアントでも、Media Node で止まる。
  - 同意の記録が、本人の操作と文言の版に結び付く。
  - L3 の結論が「残れば同意」でも「明示の同意」でも、文言と画面の差し替えで対応できる（2 は厳しい方に合わせている）。
- 引き受けるコスト：
  - 録画中の会議に入った人は、1 回の操作をしないと話せない。途中で録画が始まると、全員が 1 回押す必要がある。
  - 古いクライアントを、録画中の会議から締め出す。
  - 同意の記録を書くために、Aurora が書けないときは同意できない（話せない）。

## Confirmation

- 性質ベーステスト：Recorder・Transcriber の購読に入る producer は、すべて同意の記録を持つ人のもの（PROP-REC-002）。録画が動いている間、Admitted の人のクライアントは録画の状態を持つ（PROP-REC-001）。
- 結合試験：同意しない人が改造したクライアントで音声を送り続けても、他の参加者と録画に届かない。
- 結合試験：E2EE の会議で、API・Actor・Media Node のそれぞれに直接の開始の要求を送り、すべて拒否される（PROP-REC-003）。
- 契約の試験：`capture_indicator.v1` を申告しないクライアントが、録画中の会議に入れない。
