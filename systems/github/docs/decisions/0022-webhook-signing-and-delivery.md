---
status: accepted
date: 2026-09-26
---

# ADR-0022: Webhook は本家と同じ HMAC-SHA256 で署名し、隔離した egress から送り、送る直前に権限を確かめる

> 識別子（ヘッダー・接頭辞・ドメイン・環境変数・パスの名前）は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に合わせて `<Brand>`・`<brand>`・`<BRAND>` の置き換え用の名前にした（2026-09-26）。本家の名前は、出典の説明としてだけ書く。

## Context

Webhook は、非公開のリポジトリの中身（コミットのメッセージ、Issue の本文など）を、利用者が指定した任意の URL へ送る。intent.md は「非公開のリポジトリの中身が Webhook から漏れない」ことを求める。受け手は、送り手が本物であることを確かめる必要がある。任意の URL への送信は SSRF の危険を持つ。

本家は、`X-Hub-Signature-256: sha256=<HMAC-SHA256 の 16 進>` で署名し、10 秒で応答がなければ失敗とし、失敗した配信を自動では送り直さず、3 日以内なら UI か API で再配信できる（[Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)、[Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)、[Redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)、2026-09-26 に確認）。

Slack のアプリのイベントは、Standard Webhooks の形式（時刻を署名に含める）にした（Slack の apps.md の 8 節）。

## Options

### 署名

A. **本家と同じ方式の `X-<Brand>-Signature-256`**（本家の `X-Hub-Signature-256` と同じ値の形）
B. Standard Webhooks の形式（時刻を含め、リプレイを防ぐ）

### 失敗の扱い

1. 本家と同じ（自動の再試行なし、3 日以内の手動の再配信）
2. **短い自動の再試行（3 回）＋ 3 日以内の手動の再配信**
3. 長い自動の再試行（Slack と同じ、約 9 時間）

## Decision

A と 2 を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 9 節にある。

- **署名は本家と同じ（A）。** 値の形が本家と同じなので、本家の受け手の検証のコード（`@octokit/webhooks` の `verify` など）は、読むヘッダーの名前を変えるだけで使える（名前は ADR-0006 で違える）。B の方がリプレイに強いが、本家の受け手が検証できなくなる。リプレイは `X-<Brand>-Delivery` の重複の排除で防ぐ（本家と同じ）。
  - 秘密を必須にする。本家の SHA-1 の `X-Hub-Signature` に相当するものは送らない。宛先は `https` だけで、TLS の検証を外せない（いずれも本家との違い。非公開の中身を、署名なし・平文で出さない）。
- **自動の再試行を 3 回（1 分・10 分・1 時間の後）行い、手動の再配信は 3 日以内（2）。** 一時的な失敗で事象を失わないため、本家から外して加える。`X-<Brand>-Delivery` は再試行・再配信で変えないので、受け手は重複を捨てられる。3 は、本家の受け手が長時間の重複に備えていないことと、滞留が大きくなることから採らない。
- **送る直前に権限を確かめる。** 再試行・再配信のたびにも、Webhook の存在、インストールの範囲と権限、リポジトリの持ち主の変化を確かめ、満たさなければ送らない。ペイロード自体は事象の時点の写し（本家と同じ）。
- **外向きの送信は、隔離した egress から出す。** 署名は VPC の中の Worker が行い、送信は権限と秘密を持たない Lambda が、本体の VPC とつながらない専用の VPC から、固定の IP の NAT を通して行う。宛先の検査（私的な IP の拒否、検査したアドレスへの直接の接続、リダイレクトを追わない）は Slack の ADR-0016 と同じ。送信元の IP の範囲を公開する（本家に寄せる）。

## Consequences

- 良くなること：
  - 本家の受け手のコードで、署名を検証できる。
  - 権限が変わった後に、写しのペイロードが送られない。
  - 一時的な障害（受け手の再起動など）で、事象を失いにくい。
  - 受け手が送信元の IP で絞れる。
- 引き受けるコスト：
  - 署名に時刻を含めないので、受け手が重複の排除をしなければリプレイに弱い（本家と同じ弱さ）。
  - 自動の再試行は、本家の振る舞いを前提にした受け手に、同じ配信を複数回届けうる。
  - 固定の IP の NAT と専用の VPC を保つ運用が要る。送信元の IP の変更は、利用者への事前の告知が要る。
  - 配信の記録（本文を 3 日）の保存の費用がかかる。

## Confirmation

- 結合テスト：本家と同じ方式の検証の実装（`@octokit/webhooks` の `verify` など）に値を渡して、署名が通る。宛先の検査が、私的な IP、DNS の再束縛、リダイレクト、`http` を拒否する。
- 性質ベーステスト：任意の権限の変更と事象の列で、送る直前の確認を満たさない配信は送られない。再試行・再配信で `X-<Brand>-Delivery` と本文が変わらない。
- 監視：最初の配信までの遅延（NFR-006：p95 10 秒）、滞留の最古の年齢、egress での拒否の件数。
