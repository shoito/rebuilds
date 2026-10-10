---
status: accepted
date: 2026-10-10
---

# ADR-0012: 受信は STARTTLS を出すが求めない。本システムのドメインの MTA-STS は testing から enforce へ段で上げ、max_age を延ばす。組織のドメインの方針を本システムが代わりに持てる。TLS-RPT の報告を受けて送り手の組織ごとの失敗の率を見る。受信の DANE は MVP の後

詳細は [inbound-smtp.md](../architecture/inbound-smtp.md) の 7 節。

## Context

- 本システムのドメインに MTA-STS を `enforce` で公開し、TLS-RPT の報告を受けると決めた（[architecture/README.md](../architecture/README.md) の 6 節）。上げ方の順序と、組織のドメインの扱いは決めていない。
- RFC 3207 の 4 節は、公開の SMTP のサーバーがローカルの配送に TLS を求めることを禁じる。平文でしか送れない送り手が残る（**未検証**の割合）。
- MTA-STS の `enforce` は、方針を覚えた送り手に、証明書の検証に失敗したら送らないことを求める（RFC 8461）。設定の誤りは、そのまま受信の止まりになる。`max_age` が長いほど、誤りを直しても送り手の覚えが残る。
- 組織の管理者が、自分のドメインの MTA-STS の方針（HTTPS のサイトと証明書）を作るのは負担が大きい。本システムの MX を指すドメインの方針は、本システムが一番正しく作れる。
- 受信の DANE（TLSA）は DNSSEC の署名の運用が要る。

## Options

1. **STARTTLS は求めない。MTA-STS は段で上げる。組織の方針を代わりに持てる。TLS-RPT を受ける。DANE は後**
2. 最初から `enforce` と長い `max_age` で出す
3. MTA-STS の代わりに受信の DANE を出す
4. 組織のドメインの方針は、組織が自分で出す

## Decision

1 を採用する。

- STARTTLS は TLS 1.2・1.3、前方秘匿の AEAD だけ。平文も受け、TLS の有無を選別の特徴にする。
- MTA-STS の段：`testing`・`max_age` 1 日 →（TLS-RPT の失敗の率 0.1% 未満が 14 日）→ `enforce`・7 日 →（30 日）→ `enforce`・14 日。
- MX や証明書を変えるときは、方針に新しい MX を足して `id` を変え、旧い `max_age` が過ぎてから MX を変える。
- 組織のドメインは、`mta-sts.<orgdomain>` と `_mta-sts.<orgdomain>` を本システムの名前へ CNAME すると、本システムが方針・`id`・証明書（ACME の HTTP-01）を持つ。組織が自分で出してもよい。
- TLS-RPT は `rua` に `mailto:` と `https:` の両方を出す。報告は送り手の組織・結果の種類ごとの数だけを残す。
- 受信の DANE は E21 で、DNSSEC の運用が整ってから出す。

### 他の案を選ばなかった理由

- **2**：証明書や MX の誤りが、送り手の覚えている間（最大 1 年）直らない。段で上げると、TLS-RPT で誤りを先に見つけられる。
- **3**：DNSSEC の署名の運用が MVP に間に合わない。送り手の DANE の対応は広くない（**未検証**）。MTA-STS と DANE は両立するので、後から足せる。
- **4**：多くの組織が方針を出さず、組織のドメインのメールが下位の TLS の攻撃から守られない。

## Consequences

- 良くなること：
  - 誤りで受信を止めにくい順で、`enforce` に上げられる。
  - 組織のドメインも、手間なく MTA-STS で守れる。
- 引き受けるコスト：
  - 組織の `mta-sts` の名前ごとに証明書を作り、更新する運用が要る。
  - 平文の受信を残すので、下位の TLS の攻撃を受けうる送り手が残る（MTA-STS を守る送り手を除く）。

## Confirmation

- 試験：方針のファイルを RFC 8461 の文法で検査する。外部の MTA の模型で、段ごとの振る舞いと、MX の変更の順序を確かめる。
- 監視：TLS-RPT の失敗の率、証明書の期限（30 日前に入れ替え、14 日前に page）、方針の HTTPS の取得の合成監視。
