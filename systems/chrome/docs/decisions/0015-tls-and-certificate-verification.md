---
status: accepted
date: 2026-09-26
---

# ADR-0015: TLS は rustls、証明書の検証は自作し、ルートストアは Chrome Root Store に揃える

## Context

[ADR-0002](0002-engine-build-vs-reuse.md) は、TLS を「rustls か BoringSSL」、HTTP/3 を「quinn などの QUIC の実装」と候補だけ挙げ、領域の文書で確定するとした。ネットワークのスタックは、信頼できない入力（サーバーの応答、証明書）を最も多く受ける部分で、後から替えるコストが高い。

本家は BoringSSL と、自前の証明書の検証器（Chrome Certificate Verifier）と、自前のルートストア（Chrome Root Store）を使う。OS の検証器から自前の検証器への移行は、Windows・macOS で Chrome 108、Linux で Chrome 114 に既定になった（[Chrome Root Store FAQ](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md)）。失効は OCSP を使わず、CRLSet で配る（同 FAQ）。

## Options

TLS の実装：

1. **rustls（暗号は aws-lc-rs）**
2. **BoringSSL（Rust のバインディング）**：本家と同じ
3. **OS の TLS（SChannel、Secure Transport/Network.framework、OpenSSL）**

証明書の検証：

1. **自作の検証器と、Chrome Root Store に揃えたルートストア**
2. **OS の検証器とルートストア**（`rustls-platform-verifier`）
3. **`webpki-roots`（Mozilla のルート）と `rustls-webpki` をそのまま使う**

## Decision

TLS は 1、検証は 1 を採用する。周辺の部品も合わせて決める。詳細は [networking.md](../architecture/networking.md) の 4・6 節にある。

| 層 | 採用 | 退けたもの |
| --- | --- | --- |
| TLS | `rustls`、暗号の提供者は `aws-lc-rs` | BoringSSL、OS の TLS |
| 証明書の解析・署名の検証 | `rustls-webpki`、`aws-lc-rs` | — |
| パスの構築・ルートの制約・CT・失効 | 自作 | OS の検証器、`rustls-webpki` の検証をそのまま使う |
| ルートストア | Chrome Root Store の内容と制約に揃えたリスト＋OS に追加されたルート | Mozilla のルートだけ、OS のルートだけ |
| 失効 | CRLSet の型の、優先度の高い失効のリストを配る。OCSP・CRL は取りに行かない | オンラインの OCSP |
| HTTP/1.1・HTTP/2 | `hyper` 1.x の低レベルの接続、`h2`。プールは自作 | `reqwest`（高レベル過ぎる） |
| QUIC・HTTP/3 | `quinn`、`h3` | `quiche`（BoringSSL に依存する。`h3` が足りないときの代替） |
| DNS | `hickory-proto` でメッセージを扱い、リゾルバは自作 | `hickory-resolver` をそのまま使う |

- **rustls を選ぶ理由**：TLS の状態機械がメモリ安全な言語で書かれている（[ADR-0001](0001-languages-and-platform.md)）。暗号の実装は BoringSSL から派生した `aws-lc-rs` で、性能と、X25519MLKEM768 の既定での使用（rustls 0.23.27 から。[docs.rs/rustls](https://docs.rs/rustls/latest/rustls/)）、ECH のクライアントを持つ。`quinn` が rustls を使うので、TCP と QUIC で TLS と検証器を 1 つにできる。
- BoringSSL は、本家と同じで実績が最も多いが、TLS の状態機械も C/C++ になり、`quinn` と組み合わせにくい。
- OS の TLS・検証器は、OS ごとに振る舞いが変わり（CT の強制、ルートの制約、エラーの種類）、本家と同じ振る舞いを保証できない。本家が OS の検証器をやめた理由と同じ。
- **ルートストアを自前で審査しない**：認証局の審査の体制（監査、事故の対応）を持つのは、この題材の範囲を超える。本家のリストは Chromium のソースで公開されており、本家の不信任の決定（日付による制約を含む）をそのまま取り込む。
- OS に利用者・企業が追加したルートは信頼し、CT を求めない（本家と同じ。企業の TLS の検査の装置のため）。
- 失効をオンラインで確かめないのは、閲覧先を CA に知らせないため（[ADR-0005](0005-privacy-first-services.md)）と、遅さのため。CA/B Forum の SC-081 で証明書の有効期間が短くなる（2029 年に 47 日）ことも、全件の失効のリスト（CRLite の型）を MVP で作らない理由である。

## Consequences

- 良くなること：
  - TLS から HTTP までの主な解析が Rust になり、メモリ安全性の欠陥を減らせる。
  - 3 OS で同じ検証の振る舞い（CT、ルートの制約、エラー）になり、本家と比べて試験できる。
- 引き受けるコスト：
  - 検証器（パスの構築、名前の制約、CT のポリシー）を自作・保守する。本家の検証器の試験のデータ（Chromium の `net/data/ssl`、`net/data/verify_certificate_chain_unittest`）を取り込んで試す。
  - ルートストア・CT のログの一覧・失効のリスト・HSTS の事前読み込みを、部品の更新で配り続ける運用が要る（[update-and-release.md](../architecture/update-and-release.md)）。本家の変更の追従が遅れると、不信任の反映が遅れる。
  - `h3` の本番での実績が少ない。E4 で相互接続と負荷の試験を行い、足りなければ `quiche` に替える。
  - 本家の CRLSet を再配布してよいか（利用条件）が 未検証。だめなら、CCADB の CRL から自前で作る。

## Confirmation

- 本家の検証器の試験のデータ（証明書の連鎖と期待する結果）を、自作の検証器の表駆動テストとして CI で回す。
- ルートストアの差分を、本家の Chrome Root Store の最新のリストと毎日比べ、ずれたら警告する。
- TLS の相互接続の試験（主要な CDN・サーバーの実装、BoringSSL・OpenSSL のサーバー）と、ファズ（証明書の解析、TLS のメッセージ）を常時回す（[build-and-test.md](../architecture/build-and-test.md)）。
- `unsafe` と C の部品（`aws-lc-rs`、SQLite）の境界の変更は、セキュリティのレビューを必須にする（ADR-0001）。
