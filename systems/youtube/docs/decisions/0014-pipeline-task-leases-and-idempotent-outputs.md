---
status: accepted
date: 2026-10-10
---

# ADR-0014: 段の作業は Aurora の行の貸し出し（120 秒、30 秒ごとの心拍）で受ける。出力は決まったキーへ `If-None-Match: *` で書き、412 なら置かれたものを採る。確定は貸し出しの印を条件にした `UPDATE` で 1 回だけにし、やり直しは 5 回まで

## Context

- [ADR-0002](0002-upload-and-pipeline-orchestration.md) は、段の状態を `pipeline_runs`・`pipeline_tasks` に持ち、SQS で作業を配り、出力のキーを（`video_id`、段、入力のハッシュ、設定のバージョン、区切り）から決め、同じ作業を 2 回しても同じキーに同じ中身を書くと決めた。
- SQS の標準のキューは、同じメッセージを 2 回以上渡すことがある。Spot の中断と見えなくする時間の切れで、同じ作業を 2 つの作業者が同時に行う。
- 符号化器の出力はバイトの単位で決定的とは限らない（SVT-AV1 のスレッド、x264 の一部の設定）。「同じキーに同じ中身」をコードの約束だけでは守れない。
- 照合の段が止まったとき、公開に倒してはいけない（[ADR-0008](0008-fingerprinting-and-match-engine.md)）。

## Options

作業の受け方：

1. **Aurora の行の条件つきの `UPDATE` で貸し出しを取り、SQS は合図だけにする**
2. SQS の見えなくする時間だけで貸し出しを表す
3. Valkey の鍵で貸し出しを表す

出力の 1 回性：

- a. **キーへの `If-None-Match: *` の PUT。412 なら置かれたものを採る**
- b. 試みごとに別のキーへ書き、確定の行にキーを持つ
- c. 符号化器を決定的に設定し、上書きを許す

## Decision

1 と a を採用する。詳細は [transcoding-pipeline.md](../architecture/transcoding-pipeline.md) の 3 節。

- 貸し出し：`state='ready'` か、期限の切れた `leased` の行だけを、新しい `lease_token` と `lease_until = now() + 120 秒` で取る。心拍は 30 秒ごと。
- 確定：`lease_token` が自分のものである行だけを `succeeded` にし、同じトランザクションで依存先を `ready` にして outbox に SQS の合図を書く。
- 出力のキー：`r/{video_id}/{stage}/{cfg}/{inp}/{chunk}`。`cfg` は設定の要約、`inp` は入力の要約（元のファイルの CRC64NVME、`probe_version`、区切りの範囲）。PUT は `If-None-Match: *`。412 なら置かれたオブジェクトのチェックサムを確定に使う。
- やり直し：失敗・期限切れ・中断で `retry_wait` にし、10 秒 × 2 の n 乗（上限 10 分）待つ。5 回のやり直しの後は `dead`。急ぎの組（`probe`、`fast_encode`、`fingerprint`、`match`）の `dead` は run を `stalled` にし、Ops を呼ぶ。
- 優先度の組（急ぎ・通常・後ろ）ごとに SQS を分ける。1 チャンネルが急ぎの組で同時に持てる作業は 200 まで。

### 他の案を選ばなかった理由

- **2（SQS だけ）**：見えなくする時間の切れの後に、古い作業者が確定を書く。誰が持ち主かを DB で確かめられない。
- **3（Valkey）**：失ってよい部品（[architecture/README.md](../architecture/README.md) の 1.2 節）に、正しさを持たせることになる。
- **b（試みごとのキー）**：「同じキーに同じ中身」の規則（AGENTS.md）に合わない。どの試みの出力が使われたかを、行を読まないと分からない。
- **c（決定的に設定）**：符号化器と CPU の型で保証できない。速さも落ちる。

## Consequences

- 良くなること：
  - 2 つの作業者が同じ作業をしても、キーの中身と確定は 1 つになる。
  - どこで落ちても、その作業から同じ結果でやり直せる。
- 引き受けるコスト：
  - 貸し出しと心拍が Aurora に書き込みを足す（S1 のピークで数百件/秒と見込む。capacity の領域で確かめる）。
  - 412 の後にチェックサムを読む 1 回の HEAD が要る。

## Confirmation

- 性質ベーステスト：PROP-PIPE-001（任意の位置の停止と並びで、確定が 1 回・中身が 1 つ）、PROP-PIPE-002（依存）、PROP-PIPE-003（照合なしで公開しない）。
- 表駆動テスト：DT-PIPE-001（作業の状態の遷移表）。
- 障害の注入：PUT の後・確定の前、確定の後・依存の解放の前で止める（[quality.md](../quality.md) の 2.2.1 節 F）。
