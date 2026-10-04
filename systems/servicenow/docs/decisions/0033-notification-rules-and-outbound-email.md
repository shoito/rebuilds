---
status: accepted
date: 2026-09-28
---

# ADR-0033: 通知は Notifier で受け手ごとに作り、`(事象, 規則, 受け手, 経路)` の一意で 1 回だけ送る。本文は受け手の主体で ACL を判定して差し込み、送るメールには推測できない参照の印を付け、返信は印と SES が付けた `Message-ID` で紐付ける

詳細は [notifications-and-email-ingest.md](../architecture/notifications-and-email-ingest.md) の 3・4 節。

## Context

通知のメールは、チケットの受け付け・割り当て・コメント・解決・承認の依頼・SLA の違反で、1 日に数十万通になる（S1 のチケットの作成 20 万件/日）。通知の本文にはレコードの値が入り、ACL で読めない値を漏らしてはならない（[access-control.md](../architecture/access-control.md) の 6.2 節の 11 行、NFR-010）。outbox の配送は少なくとも 1 回で、同じ事象が 2 回届く。受け手の返信は、元のチケットに結び付けたい。

本家は、通知の本文の末尾に参照の印（`Ref:` で始まり、既定の接頭辞 `MSG`、自動の番号とランダムな文字列）を入れ、返信の紐付けに使う（[Working with watermarks](https://www.servicenow.com/docs/r/platform-administration/c_WorkingWithWatermarks.html)、2026-09-28 に確認）。SES は、送る側が付けた `Message-ID` を自分の値で上書きする（[Amazon SES header fields](https://docs.aws.amazon.com/ses/latest/dg/header-fields.html)、2026-09-28 に確認）。

## Options

### 本文の作り方

1. **受け手ごとに、受け手の主体で ACL を判定して差し込む**
2. 規則ごとに 1 つの本文を作り、全員に同じものを送る

### 重複の防止

- a. **`(事象, 規則, 受け手, 経路)` の一意の行を先に作り、送信の状態をバージョンの条件で進める**
- b. 送信の後に SES のメッセージの ID で重複を見る

### 参照の印

- x. **通知の 1 通ごとの推測できない乱数**
- y. レコードの番号を含む形（本家に近い）

## Decision

1、a、x を採用する。

- Notifier は、規則の選択 → 受け手の解決 → 利用者の設定 → `notification_message` の作成（一意） → 受け手ごとの本文 → 経路ごとの送信、の順に処理する。
- レコードの値は事象の時点のバージョン（監査の履歴から）で読み、ACL は送る時点の権限で判定する。読めないレコードの受け手には送らない。社外の宛先には公開の項目だけ。
- 送信は `pending` → `sending` → `sent` / `failed` / `suppressed`。`sending` のまま落ちた行は 1 回だけ再送する（重複は高々 1 通）。
- 送るメールは UTF-8。ヘッダー：同じ受け手への直前の通知（SES が付けた `Message-ID`）への `In-Reply-To`・`References`、`Auto-Submitted: auto-generated`、`X-Auto-Response-Suppress: OOF, AutoReply`、`<Brand>-Loop`。
- `Message-ID` は付けない（SES が上書きする）。SES が返す ID と、受け手に届く `Message-ID` を `email_outbound` に 90 日記録する。
- 参照の印 `<Brand>-Ref:` ＋ 100 ビットの乱数を通知ごとに作り、1 年保つ。印は紐付けの手がかりで、権限ではない。
- 恒久のバウンスと苦情の宛先は、テナントの抑止のリストに入れる。

> 2026-09-28 の注記：起票の時は、送るメールに自前の `Message-ID` を付け、SES が保つかを未検証とした。検証の工程で、SES は送る側の `Message-ID` を自分の値で上書きすることを公式の文書で確かめた（Context）。そのため自前の `Message-ID` をやめ、SES の ID から受け手に届く `Message-ID` を記録して返信の照合に使う。SES の送信の応答の ID と、受け手に届く `Message-ID` のドメインの部分の対応は、E6 `notifier-outbound-email` で確かめる。返信の紐付けの主な手がかりは、これまでどおり参照の印である。

2 を採らない理由：受け手ごとに読める範囲が違う（依頼者と担当者、社外の宛先）。1 つの本文にすると、最も弱い権限の受け手に合わせるか、漏らすかのどちらかになる。

b を採らない理由：送った後では、同じ通知の 2 通目を止められない。

y を採らない理由：番号は推測できるので、他人のチケットへの紐付けを作れる（印を権限にしないとしても、紐付けの候補を作らせない）。本家の形を識別子として写すことにもなる（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## Consequences

- 良くなること：
  - 通知の本文から、読めない値が漏れない。
  - outbox の重複でも、同じ通知は 1 回（最悪 2 通）。
- 引き受けるコスト：
  - 受け手ごとの本文の作成と ACL の判定で、Notifier の計算が増える。同じ主体の組（ロールと属性が同じ受け手）で結果をまとめる最適化は、E6 の計測の後に考える。
  - 事象の時点のバージョンの組み立てに、監査の履歴を読む。

## Confirmation

- 性質ベーステスト PROP-NTF-001（通知は 1 回）、PROP-NTF-002（通知は漏らさない）。
- 出口ごとの漏れの試験の通知の出口（[access-control.md](../architecture/access-control.md) の 12.3 節）。
- lint：Notifier のテンプレートの描画のモジュールが、判定の関数を通さずにレコードの値を読むことを禁止する。
