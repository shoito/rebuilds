---
status: accepted
date: 2026-10-10
---

# ADR-0020: 相手の応答と受け取った DSN を拡張のコードと事業者ごとの文の型で分類し、評判と乗っ取りの検知に使う。DSN は送信者の受信箱へ mailstore で直接配る。転送は SRS で封筒を書き換え、転送の先の不達は元の MAIL FROM が認証で確かめられたときだけ返す。フィードバックループの報告は追跡の値だけを取り出し、中身はすぐ捨てる

詳細は [outbound-smtp-and-reputation.md](../architecture/outbound-smtp-and-reputation.md) の 8・9 節。

## Context

- 不達の理由（宛先がない、評判で断られた、認証の要件、中身で断られた）で、とるべき手当てが違う。拡張のコード（RFC 3463）だけでは、事業者ごとの意味の違いを区別しきれない。
- 送信者は本システムの利用者なので、送信の DSN を SMTP で送る必要はない。
- 受け付けた後の DSN は、配送の不能で、元の MAIL FROM が確かめられたときだけ送る（[ADR-0002](0002-accept-then-filter.md)）。転送の先の恒久のエラーは、その場合に当たる。
- 転送で MAIL FROM を変えなければ、転送の先の SPF が通らない。変えると、転送の先の不達が本システムに戻る。
- フィードバックループ（ARF、RFC 5965）の報告は、利用者の送ったメッセージの写しを含む。苦情を送信とアカウントに結び付けたいが、中身を残したくない（[ADR-0008](0008-spam-pipeline-boundary-and-secrecy.md)）。

## Options

1. **分類の一覧と DSN の直接の配送、SRS（HMAC）、追跡の値だけを取り出す FBL**
2. 拡張のコードだけで分類し、DSN を SMTP で送る
3. 転送で MAIL FROM を変えない（SRS を使わない）
4. FBL の報告の元のメッセージを残し、調べに使う

## Decision

1 を採用する。

- 分類は 11 の種類（`hard_invalid_recipient`、`hard_domain`、`mailbox_full`、`message_too_big`、`auth_required`、`policy_reputation`、`rate_limited`、`content_rejected`、`tls_required`、`transient_other`、`unknown`）。拡張のコードと、事業者ごとの文の型の一覧（コードのバージョン）で決め、文そのものは残さない。
- DSN は RFC 3464 の形で、説明は利用者の言語、元のヘッダーを添え、`mailstore` で送信者の受信箱に配る。1 時間の中の不達を 1 つにまとめる。
- 外から受け付けたメールの DSN は、元の MAIL FROM の SPF の `pass` か揃う DKIM の `pass` があるときだけ、`system` のプールから `<>` で送る。
- SRS は `SRS0=<hash>=<tt>=<domain>=<local>@srs.<brand>.<domain>`、hash は HMAC-SHA256 の 40 ビットを base32 の 8 文字、21 日で失効、小文字で比べる。鍵は 1 年ごとに替え、前の鍵を 21 日残す。
- 送信に `Feedback-ID` と `X-<Brand>-Trace`（`submission_id` の HMAC）を付け、基盤の DKIM の署名に含める。FBL の報告からは、この 2 つだけを取り出し、元のメッセージはすぐ捨てる。引きの表は 90 日。

### 他の案を選ばなかった理由

- **2**：事業者ごとの意味の違いで誤って分類し、評判の手当てを誤る。DSN を SMTP で送ると、本システムの中で済む配送に外の経路を使う。
- **3**：転送の先の SPF が通らず、DMARC の `p=reject` のメールが ARC だけに頼ることになる。
- **4**：利用者の送ったメールの写しが、本システムの運用の置き場所に残る。

## Consequences

- 良くなること：
  - 不達の手当てを種類ごとに正しく選べる。
  - 後方散乱を作らない。
  - 苦情をアカウントに結び付けながら、中身を残さない。
- 引き受けるコスト：
  - 事業者ごとの文の型の一覧を保守する。
  - SRS の鍵の管理と、21 日を過ぎた不達を捨てること。
  - 追跡のヘッダーを消す相手の報告は、アカウントに結び付けられない（基盤の単位の数えだけになる）。

## Confirmation

- 決定表：DT-OUT-002（不達の分類のベクトル）。
- 性質ベーステスト：PROP-OUT-004（SRS）、PROP-OUT-005（後方散乱 0）。
- 監視：後方散乱の抑えの数、`unknown` の率（型を足す候補）、FBL の報告のうち追跡の値を取れなかった割合。
- lint：`report-ingest` で、FBL の報告の本文をログ・置き場所に書くコードを禁止する。
