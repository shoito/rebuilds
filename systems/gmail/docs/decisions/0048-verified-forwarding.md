---
status: accepted
date: 2026-10-10
---

# ADR-0048: 転送の先は、確かめのメールのリンクの画面での確定（POST）か 9 桁の番号で確かめ、確かめるまで転送しない。転送するのは最後の判定が受信箱のものだけで、配る形に本システムのヘッダーを足し、SRS と ARC を付けて `forward` のプールから送る。ループは本システムのヘッダーと `Received` の数で止める。恒久のエラーが 7 日に 5 回続いたら止めて知らせる

詳細は [filters-forwarding-and-automation.md](../architecture/filters-forwarding-and-automation.md) の 5 節。

## Context

- 本家は、転送の先に確かめのリンクを送り、押して確かめる。転送を始めた最初の週は知らせを出す（[Automatically forward Gmail messages](https://support.google.com/mail/answer/10957)、2026-10-10 に確認）。
- 確かめない転送は、他人のアドレスへ大量のメールを送る踏み台になり、送信の評判を壊す（NFR-012）。
- メールの中のリンクを自動で開く検査の仕組み（組織のゲートウェイ）が、GET のリンクを押してしまい、確かめが勝手に済むことがある。
- 乗っ取られたアカウントは、転送を仕込んでメールを抜かれる（[architecture/README.md](../architecture/README.md) の 6 節）。
- 転送は SRS（[ADR-0020](0020-bounces-dsn-srs-and-feedback-loops.md)）と ARC（[ADR-0017](0017-arc-sealing-trusted-sealers-and-dmarc-reports.md)）を使う。[outbound-smtp-and-reputation.md](../architecture/outbound-smtp-and-reputation.md) の 8.4 節は、恒久のエラーで何回で止めるかをこの領域に任せた。
- 受け取ったメールの止めた添付と偽の `Authentication-Results` は、配る形で返す（[ADR-0032](0032-served-view-edits.md)）。

## Options

1. **確定の画面の POST か番号で確かめ、受信箱のものだけを配る形で転送し、本システムのヘッダーでループを止め、失敗の連続で止める**
2. GET のリンクで確かめる
3. 確かめない（利用者の責任で転送する）

## Decision

1 を採用する。

- 確かめ：`system` のプールから確かめのメール（リンクと 9 桁の番号）。リンクの画面の「確定する」の POST か、利用者が番号を入れて `verified`。7 日で `expired`。確かめた先は 20 まで、確かめのメールは 1 日 10 通まで。
- 転送するもの：最後の判定が `inbox`・`inbox_warn` のもの。配る形に `Received` と `X-<Brand>-Forwarded-By: <アカウントの HMAC>` を足し、ARC で封印し、SRS の `MAIL FROM` で `forward` のプールから送る。1 日 5,000 通まで。
- ループ：自分の HMAC の `Forwarded-By` があるか、`Forwarded-By` が 5 以上か、`Received` が 50 以上なら転送しない（配送はする）。
- 失敗：恒久のエラーを先ごとに数え、7 日の中で 5 回続いたら `disabled` にして知らせる。
- 知らせ：転送を始めたら、受信箱への知らせのメールと 7 日の帯。組織の方針で外への転送を禁止できる。

### 他の案を選ばなかった理由

- **2**：自動で開く検査の仕組みが確かめを済ませ、受け手の同意のない転送になる。
- **3**：踏み台と評判の崩れを防げない。

## Consequences

- 良くなること：
  - 受け手が同意した先にだけ転送する。
  - 迷惑メールと止めた添付を外へ中継しない。
  - 転送の輪が有限で止まる。
- 引き受けるコスト：
  - 確かめの画面と番号の 2 つの経路を保守する。
  - 本システムの中のアカウントの間の輪では、同じメッセージが 2 通届くことがある（転送は止まる）。

## Confirmation

- 性質ベーステスト：PROP-FWD-001（輪が有限）、PROP-FWD-002（確かめていない先へ送らない）。
- 相互運用：転送したメールが、外部の受け手の模型で DMARC を通る（[quality.md](../quality.md) の 2.2.1 節 C）。
- 監視：転送の量、`disabled` の数、確かめのメールの送り直しの数。
