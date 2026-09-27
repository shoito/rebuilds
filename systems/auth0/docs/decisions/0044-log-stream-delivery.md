---
status: accepted
date: 2026-09-27
---

# ADR-0044: ログストリームはストリームごとのカーソルで少なくとも 1 回送り、Webhook に本文の署名を足す

詳細は [logs-and-streams.md](../architecture/logs-and-streams.md) の 6 節。

## Context

テナントは、ログを SIEM や自前の分析へ送る。NFR-010 は、最初の送信 p95 60 秒と、少なくとも 1 回の配信を求める。

本家の振る舞い（2026-09-27 に確認。[Log Streams](https://auth0.com/docs/customize/log-streams)、[Check Log Stream Health](https://auth0.com/docs/customize/log-streams/check-log-stream-health)、[Custom Log Streams](https://auth0.com/docs/customize/log-streams/custom-log-streams)）：

- 少なくとも 1 回。順序は保証しない。1 件ごとに最大 3 回試し、失敗は Health に出し、解決するまで繰り返す。7 日続けて届かないと止める。
- `paused` の間のログは、保持の期間の中で溜め、再開で送る。作り直すときに、開始の位置を保持の期間の中の日時にできる。
- Webhook は `Authorization` の値だけで守り、本文の署名はない。個人データの伏せ字の hash は xxHash。

ログは 1 日約 1 億件で、Stripe の再構築の Webhook のような、イベント × 宛先の配信の記録（[Stripe の ADR-0025](../../../stripe/docs/decisions/0025-webhook-signing-and-isolated-delivery.md)）は量が合わない。`log_id` はテナントの中でコミットの順に単調である（[ADR-0042](0042-log-event-model-and-type-codes.md)）。

## Options

1. **ストリームごとのカーソル（最後に届けた `log_id`）。成功の後にだけ進める。1 つのストリームの送り手は 1 つ**
2. イベント × ストリームの配信の記録を持ち、1 件ずつ再試行する
3. Kinesis Data Streams などに書き、テナントの宛先ごとの消費者を持つ

## Decision

1 を採用する。

- 送り手は、`log_id > cursor` を最大 100 件（1 MiB、または 1 秒）読み、フィルターと伏せ字をかけて送る。2xx（EventBridge は失敗の件数 0）でカーソルを進める。
- 再試行は同じまとまりを 3 回（1 秒・5 秒・30 秒）。その後は Health に記録し、1 分・5 分・15 分・1 時間ごとに試す。最初の失敗から 7 日成功しなければ `disabled`。
- `paused` と `disabled` からの再開は、カーソルの続きから。カーソルが保持の期間より古ければ、残る最も古いログから再開し、欠けを知らせる。
- 順序は、実際には `log_id` の順だが、契約としては保証しない。利用者には `log_id` で重複を捨ててもらう。
- 種類は MVP で Webhook と EventBridge。EventBridge はパートナーのイベントソース。登録は、AWS Partner Network に登録してから EventBridge の統合のチームに連絡し、パートナーの API を使えるようにする（[Amazon EventBridge Integrations](https://aws.amazon.com/eventbridge/integrations/)、2026-09-27 に確認。かかる期間は未検証）。間に合わなければ利用者のイベントバスへの `PutEvents` で代える。
- **Webhook に `<Brand>-Signature`（HMAC-SHA-256、タイムスタンプ付き、Stripe の再構築と同じ形）を足す。** 本家の `Authorization` の値も受ける。
- **伏せ字の hash は、ストリームごとの鍵の HMAC-SHA-256 にする。** xxHash は非暗号で、メールアドレスの辞書で元に戻せるため。
- 送信は `worker-egress` から。宛先の IP の検査、リダイレクトを追わない、443 だけ。
- ストリームの作成・宛先の変更は step-up、監査、テナントの `admin` 全員へのメール。
- 2 は、1 日 1 億件 × ストリームの数の記録を書くことになり、ログの取り込みと同じ量の書き込みがもう 1 つ増える。
- 3 は、テナントごとのカーソルを Kinesis の外に持つことになり、1 と同じ仕組みに外部のサービスを足すだけになる。保持の期間の中の開始の位置も、ログの表から読む必要がある。

## Consequences

- 良くなること：
  - 配信の記録が、ストリームごとに 1 行（カーソル）で済む。
  - 開始の位置、`paused` の間のログの送り直しが、同じ仕組みで自然に書ける。
  - 本家より、本文の改ざんとなりすましに強い。
- 引き受けるコスト：
  - 1 件の不正な形のログ（宛先が 400 を返し続けるもの）で、そのストリームの全体が止まる。宛先の 4xx が同じまとまりで 24 時間続いたら、そのまとまりを 1 件ずつに分けて送り、それでも拒否される 1 件を飛ばして Health に記録する。
  - 本家の署名のない Webhook に合わせた受け口は、そのまま動く（署名を検証しなくても受けられる）。署名の検証は、文書と SDK で勧める。
  - EventBridge の登録の手続きが間に合わないと、形が 2 つになる。

## Confirmation

- 性質ベーステスト：任意の送信の失敗の列（タイムアウト、5xx、送信の後の Worker の停止、送り手の交代）について、宛先が受け取った `log_id` の集合は、フィルターに合うログの集合を含む。
- 結合テスト：7 日の失敗で `disabled`、再開で続きから。`paused` の間のログが再開で届く。保持の期間を過ぎたカーソルで、欠けの知らせが出る。
- 結合テスト：署名の検証（正しい鍵、ローテーション中の 2 つの鍵、改ざん、古いタイムスタンプ）。
- 結合テスト：宛先の検査（プライベートの IP、IMDS、リダイレクト、443 以外）。
- 合成監視：本システムの受け口のストリームで、NFR-010 の最初の送信 p95 60 秒と、取りこぼしの日次の突き合わせ。
