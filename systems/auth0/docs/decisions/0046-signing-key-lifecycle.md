---
status: accepted
date: 2026-09-27
---

# ADR-0046: 署名鍵は `next`・`current`・`previous`・`revoked` で持ち、`next` を先に配ってから切り替える

詳細は [keys-and-secrets.md](../architecture/keys-and-secrets.md) の 5 節。

## Context

[ADR-0003](0003-token-formats-and-signing-keys.md) は、テナントごとの署名鍵を `next`・`current`・`previous`・`revoked` の状態で持ち、JWKS に `next`・`current`・`previous` を載せると決めた。定期の自動のローテーションと、細かな規則はこの領域に任された。

本家 Auth0（2026-09-27 に確認）：

- 状態は「使用中」「前の鍵」「次の鍵」。ローテーションは手で行う。自動のローテーションの記述はない（[Signing Keys](https://auth0.com/docs/get-started/tenant-settings/signing-keys)）。
- 失効できるのは前の鍵だけで、先にローテーションが要る。失効した鍵は再び使えない（[Revoke Signing Keys](https://auth0.com/docs/get-started/tenant-settings/signing-keys/revoke-signing-keys)）。

テナントの API と RP は、JWKS をキャッシュする。ローテーションの直後に、キャッシュにない鍵で署名すると、検証が失敗する。漏えいの疑いのときは、キャッシュを待たずに古い鍵を止めたい。

## Options

1. **`next` を JWKS に載せて確かめてから 15 分で ready とし、ready の `next` だけを通常のローテーションで `current` にする。緊急のローテーションは ready を問わず、`current` を直接 `revoked` にする。`previous` は 2 つまで。定期の自動のローテーションは既定で無効**
2. 本家と同じく、`next` の配布を待たずにいつでもローテーションし、`previous` の数を限らない
3. 定期の自動のローテーション（例：90 日）を既定で有効にする

## Decision

1 を採用する。

- 通常のローテーション：`next`→`current`、`current`→`previous`、新しい `next`。`next` が ready でなければ 409。`previous` が 2 つなら 409（古い方の失効を先に求める）。
- 失効：`previous` だけ。JWKS から外し、秘密鍵の暗号文を消す。戻せない。大阪への複製と JWKS の配信を確かめてから完了とする（[ADR-0060](0060-disaster-recovery-and-stages.md)）。
- 緊急のローテーション：テナントの 1 つの鍵（`current` を直接 `revoked`）と、全部（すべての鍵を `revoked` にして作り直す）の 2 つ。Signer の侵害の疑いでは、全テナントに全部の緊急のローテーションを行う。
- 失効した `kid` の JWT は、本システムの側では即時に拒否する。
- 定期の自動のローテーションは既定で無効。テナントが 30〜365 日で有効にできる。
- `kid` は RFC 7638 の thumbprint。
- ローテーションの API は、テナントごとに 1 時間 10 回（緊急は 3 回）。
- 2 は、ローテーションの直後に RP の検証が失敗しうる。`previous` が増え続けると JWKS が大きくなり、漏えいした古い鍵が残り続ける。
- 3 は、証明書や公開鍵を固定している RP を、テナントの知らないうちに壊しうる。本家から移るテナントの期待とも違う。

## Consequences

- 良くなること：
  - 通常のローテーションで、RP の検証が失敗しない。
  - 漏えいの疑いのときに、1 回の操作で古い鍵を止められる。
- 引き受けるコスト：
  - ローテーションの直後の 15 分は、次のローテーションができない。
  - 緊急のローテーションの直後は、JWKS をキャッシュした RP で数分の検証の失敗がありうる。

## Confirmation

- 表駆動テスト：[keys-and-secrets.md](../architecture/keys-and-secrets.md) の 5.2 節の各行。
- 性質ベーステスト：任意の操作の列で、`current`・`next` はちょうど 1 つずつ、`previous` は 2 つ以下。JWKS は `revoked` を含まない。通常のローテーションの前に出したトークンは、`previous` の失効まで検証できる。
- 訓練（四半期）：監視用のテナントで緊急のローテーションを行い、JWKS の確かめまでの時間を測る。
