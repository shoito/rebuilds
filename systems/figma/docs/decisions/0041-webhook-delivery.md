---
status: accepted
date: 2026-09-27
---

# ADR-0041: Webhook は中身を含まない HMAC で署名したイベントを、配送の時点の権限で判定し、隔離した egress から少なくとも 1 回送る

## Context

連携は、ファイルの更新・名前付きのバージョン・削除・コメントを知りたい。本家の Webhook の V2 は次の形である（[Webhooks](https://developers.figma.com/docs/rest-api/webhooks/)、[Webhooks Events](https://developers.figma.com/docs/rest-api/webhooks-events/)、[Webhooks Endpoints](https://developers.figma.com/docs/rest-api/webhooks-endpoints/)、[Webhooks Security](https://developers.figma.com/docs/rest-api/webhooks-security/)、いずれも 2026-09-27 に確認）。

- 文脈はチーム（管理者、20 個まで）・プロジェクト（編集の権限、5 個）・ファイル（編集の権限、3 個）。
- 種類は `PING`・`FILE_UPDATE`（編集が 30 分止まったとき）・`FILE_VERSION_UPDATE`・`FILE_DELETE`・`LIBRARY_PUBLISH`・`FILE_COMMENT`・`DEV_MODE_STATUS_UPDATE`。本文にファイル名やコメントの本文が入る。
- 作るときに利用者が `passcode` を決め、本家はそれを本文に入れて返す。受け手が違う passcode に 400 を返すと、Webhook は止まる。
- 200 以外は失敗として、5 分・30 分・3 時間の後に再試行する。失敗が続いても止めない。配送の記録は 7 日。

送り先は利用者が決める任意の URL で、SSRF の危険がある。rebuilds の Notion は、中身を含まないイベントを、配送の時点の権限で判定し、隔離した egress から送ると決めた（[Notion の ADR-0025](../../../notion/docs/decisions/0025-webhook-delivery.md)）。Slack は、VPC の外の権限のない Lambda で外部の URL に届く（[Slack の ADR-0016](../../../slack/docs/decisions/0016-isolated-link-unfurling.md)）。

## Options

1. **ID だけの本文、HMAC の署名、配送の時点の判定、隔離した egress**
2. **本家と同じ：内容を含む本文と、本文の中の passcode**
3. **1 の本文で、判定はイベントの発生の時点**

## Decision

1 を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 6 節。

- **文脈と上限は本家と同じ**（チーム 20・プロジェクト 5・ファイル 3、組織のファイルの Webhook は 300）。
- **本文は ID だけ。** ファイル名・コメントの本文を入れない。受け手は API で取りに来る。2 は、共有を外した後に届く再試行が、読めなくなった内容を運ぶ。受け手の記録に内容が残る。
- **署名はサーバーが作る秘密による HMAC-SHA256。** `<Brand>-Signature: t=<unix 秒>,v1=<16 進>` を付け、署名の対象は `"{t}.{本文}"`。時刻の差 5 分以内を求める。入れ替えの 24 時間は 2 つの署名を付ける。2 の passcode は、本文に秘密が入るので、本文が記録に残ると秘密も漏れる。改ざんとリプレイも検出できない。
- **配送の時点で判定する。** 再試行を含め、送る直前に、作った人が対象のファイルを読めるかを判定関数で確かめる。読めなければ送らない（`skipped_forbidden`）。作った人が組織から外れたら、その組織の Webhook を止める。3 は、共有を外した後の再試行で、ファイルの ID と変化の事実が漏れる。
- **配送**：少なくとも 1 回、順序は保証しない。10 秒以内の 2xx を成功とし、1 分・5 分・30 分・3 時間・12 時間の後に再試行する。3 日続けて失敗したら止め、作った人に知らせる。410 は即時に止める。記録は 7 日（本家と同じ）。
- **`file.updated` は編集が 5 分止まったとき**（本家は 30 分）。1 ファイル 30 分に 1 回までに間引く。
- **隔離した egress**：Worker が判定・封筒・署名を行い、VPC の外の権限のない Lambda（`webhook-egress`）が送る。宛先の検査は Slack の ADR-0016 と同じ。秘密は Lambda に渡さない。

## Consequences

- 良くなること：
  - 共有の取り消しが、Webhook にも即時に効く。
  - 本文から内容と秘密が漏れない。
  - 内部のネットワークを踏み台にされない。
- 引き受けるコスト：
  - 受け手は、イベントのたびに API を呼ぶ。その呼び出しもレート制限の対象になる。
  - 本家の passcode の形から移る連携は、署名の検証を実装し直す。
  - egress の Lambda と、Webhook ごとの同時の上限を運用する。

## Confirmation

- 結合テスト：共有を外した後の再試行が送られず、`skipped_forbidden` が記録される。
- 結合テスト：署名が本文と秘密から検証でき、時刻の差が 5 分を超えると検証に失敗する。入れ替えの 24 時間は、古い秘密と新しい秘密のどちらでも検証できる。
- SSRF：Slack の ADR-0016 と同じ宛先の一覧に送らない。
- 指標：配送の遅れの p95・p99、失敗率、止めた Webhook の数、egress での拒否の数。
