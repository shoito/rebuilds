---
status: accepted
date: 2026-09-27
---

# ADR-0018: 証明書は ACME で自前で発行し、リージョンのデータ鍵で包んで全ノードへ配る

詳細は [edge-network-and-routing.md](../architecture/edge-network-and-routing.md) の 6 節と 7 節。

## Context

[ADR-0003](0003-edge-locations.md) は、TLS をエッジのノードで終端し、既定のドメインとカスタムドメインの証明書を自分たちで ACME で発行して配ると決めた。S1 で証明書は数万枚（アカウント 1 万、カスタムホスト名 2 万の見込み。[architecture/README.md](../architecture/README.md) の 2 節の S1 の規模からの仮定）になる。

- 既定のサブドメインは `<worker>.<account>.<brand>.<domain>` の 2 段で、1 枚のワイルドカードでは覆えない。
- ACME（[RFC 8555](https://www.rfc-editor.org/rfc/rfc8555.html)）の HTTP-01 はポート 80 で、ワイルドカード不可。DNS-01 は TXT でワイルドカード可、`_acme-challenge` を CNAME で委ねられる（[Challenge Types](https://letsencrypt.org/docs/challenge-types/)）。
- Let's Encrypt の上限：新しい注文 300／3 時間、登録ドメインあたり 50 枚／7 日（引き上げ可）、認可の失敗 5／時。ARI（[RFC 9773](https://www.rfc-editor.org/rfc/rfc9773.html)）の更新はすべての上限の対象外（[Rate Limits](https://letsencrypt.org/docs/rate-limits/)）。
- 証明書の期間は 2028-02-16 に既定で 45 日、認可の再利用 7 時間になる（[Decreasing Certificate Lifetimes to 45 Days](https://letsencrypt.org/2025/12/02/from-90-to-45)）。
- Let's Encrypt は複数の地点から検証する（[Princeton partnership](https://letsencrypt.org/2024/05/30/princeton-partnership)）。この基盤は anycast なので、各地点の要求は別のリージョンに届きうる。
- ZeroSSL は EAB 必須で、90 日の証明書を数の制限なく発行する（[ZeroSSL ACME](https://zerossl.com/documentation/acme/)）。
- 本家の既定のドメインは Public Suffix List に載っている。PSL はレート制限の回避だけを目的とする登録を断る（[PSL Guidelines](https://github.com/publicsuffix/list/wiki/Guidelines)）。
- すべて 2026-09-27 に確認した。

## Options

1. **ACME で自前で発行する。既定のドメインはアカウントごとのワイルドカードを DNS-01、カスタムホスト名は所有の確認の後に HTTP-01（DNS-01 の委任も可）。鍵はリージョンのデータ鍵で包んで設定の写しで配る**
2. ACM の書き出せる公開の証明書を使う（1 FQDN 7 ドル、ワイルドカード 79 ドル。発行と更新のたび。[ACM Pricing](https://aws.amazon.com/certificate-manager/pricing/)、2026-09-27 に確認）
3. 要求の時点で発行する（最初の ClientHello で発行を始める、いわゆる on-demand TLS）
4. 関数ごとに証明書を発行する

## Decision

1 を採用する。

- 発行局は Let's Encrypt を主、ZeroSSL を予備にする。主が 1 時間続けて失敗したら予備で発行する。鍵は ECDSA P-256。
- 既定のサブドメイン：アカウントがサブドメインを選んだ時点で `*.<account>.<brand>.<domain>` を DNS-01（Route 53）で発行する。最初のデプロイの経路に発行を入れない。
- カスタムホスト名：ドメインの所有を TXT で確かめ、向き先（CNAME・A）を確かめてから HTTP-01 で発行する。利用者が `_acme-challenge` の CNAME の委任を置けば DNS-01 で発行でき、ワイルドカードも発行できる。
- **HTTP-01 のトークンは、変更のログで全リージョンの全ノードに届いたこと（適用の番号）を確かめてから、検証を頼む**（最大 60 秒待つ）。
- 更新は ARI の窓で行う。ARI がなければ期間の 2/3 で更新する。
- 既定のドメインは、ダッシュボードと別の登録ドメインにし、PSL に載せる（目的は Cookie の分離）。Let's Encrypt の「登録ドメインあたり」の上限の引き上げも申請する。間に合わない間は ZeroSSL で補う。
- CAA で 2 つの発行局だけを許し、`accounturi`（RFC 8657）で自分たちのアカウントに限る。
- 秘密鍵は cert-manager で作り、リージョンごとのデータ鍵（RDK。KMS で包む。毎月入れ替え）で AES-256-GCM で包む。包んだ鍵を設定の写しで配る。ノードの入口のプロキシは起動時に RDK を KMS で 1 回開き、鍵をメモリにだけ置く。
- SNI がない・未登録のホスト名には既定の証明書を出さず、`unrecognized_name` で閉じる。SNI と Host の食い違いは 421。0-RTT は受けない。OCSP の stapling はしない。
- 2 を採らない理由：S1 の 3 万枚を 60 日ごとに更新すると、年に数百万ドル規模になる（1 万のワイルドカード×79 ドル×年 6 回だけで約 470 万ドル）。
- 3 を採らない理由：最初の要求が発行の時間（数秒〜数十秒）待たされ、発行局の上限を攻撃者の要求で使い切られうる。所有の確認の順序も守れない。
- 4 を採らない理由：関数の数（S1 で 5 万）だけ発行と更新が要り、上限に当たる。

## Consequences

- 良くなること：
  - 証明書の費用がほぼない。自前の PoP（S3）に移っても同じ仕組みで続く。
  - 秘密鍵の平文は、cert-manager とノードのメモリにしかない。
  - 期間の短縮（45 日）にも、ARI と 2/3 の規則で追従できる。
- 引き受けるコスト：
  - ACME の運用（上限、失敗の切り分け、予備の発行局）を自分たちで持つ。
  - 既定のドメインのアカウントごとのレコードで、Route 53 の上限（10,000）を引き上げる必要がある。
  - PSL への掲載は期間の約束がなく、取り消しも難しい。既定のドメインを長く保つ前提になる。
  - KMS に届かない間は、新しいノードが TLS を終端できない（動いているノードは続ける）。

## Confirmation

- 結合テスト（Pebble）：HTTP-01・DNS-01・CAA の拒否・検証の失敗。全リージョンの適用を待たずに検証を頼むと失敗することの回帰テスト。
- 性質ベーステスト：任意の 2 アカウントの登録と確認の列で、1 つのホスト名が同時に 2 つのアカウントで `active` にならない。
- 監視：証明書の残りの日数の最小値。14 日で警報、7 日で当番を呼ぶ。
- 訓練（四半期）：主の発行局を止めた状態で、予備の発行局で発行と更新ができる。
- レビュー：秘密鍵の平文をログ・ディスク・LMDB に書く変更を拒む。
