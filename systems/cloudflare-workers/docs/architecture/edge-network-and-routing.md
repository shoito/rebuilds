# Edge Network and Routing: Cloudflare Workers

利用者の要求を、エッジのノードの関数まで届ける経路の設計。anycast の IP（Global Accelerator）と DNS、TLS の終端と証明書（ACME）、ホスト名とパスからのルートの解決、リージョンの間の迂回と退かせ方、ノードの間の負荷分散、外向きのプロキシの実装を決める。本家との遅延の差も、率直に書く。

| 関連 | 決定 |
| --- | --- |
| [ADR-0003](../decisions/0003-edge-locations.md) | S1・S2 は AWS のリージョンのノードを Global Accelerator の anycast の IP の後ろに置き、TLS はノードで終端する |
| [ADR-0004](../decisions/0004-config-and-code-distribution.md) | 設定は変更のログとノードの LMDB で配る。要求の処理で制御プレーンを呼ばない |
| [ADR-0010](../decisions/0010-process-sandbox-and-egress-invariants.md) | 外への経路は外向きのプロキシだけ。名前の解決の後に内部のアドレスを拒否し、止まったら閉じる |
| [ADR-0016](../decisions/0016-request-brand-metadata.md) | `request.<brand>` の値は入口のプロキシが 1 か所で計算する |
| [ADR-0017](../decisions/0017-global-accelerator-and-regional-nlb.md) | デュアルスタックの標準のアクセラレーターと、リージョンごとの TCP の NLB。予備のアクセラレーターを持ち、リージョンの退かせ方はデータプレーンの印で行う |
| [ADR-0018](../decisions/0018-acme-certificates-and-sni.md) | 証明書は ACME で自前で発行する。既定のドメインはアカウントごとのワイルドカード（DNS-01）、カスタムホスト名は TXT の所有の確認の後に HTTP-01。鍵はリージョンのデータ鍵で包んで配る |
| [ADR-0019](../decisions/0019-route-matching-and-home-node-forwarding.md) | ルートはホスト名の表と、制限した文法のパターンで解決する。リージョンの中はランデブーハッシュでホームのノードへ転送する |
| [ADR-0020](../decisions/0020-pingora-ingress-and-egress-proxies.md) | 入口と外向きのプロキシは Pingora の上に Rust で作る。外向きは専用の再帰のリゾルバーと、アカウントごとの接続のプールを使う |

isolate の温め方（SNI の先読み、ホームのノード）の方針は [runtime-and-isolates.md](runtime-and-isolates.md) の 5 節、外向きのプロキシが守る不変条件は [sandbox-and-security.md](sandbox-and-security.md) の 7 節、`fetch` の振る舞いと `request.<brand>` の欄は [web-apis-and-compat.md](web-apis-and-compat.md) の 4.2 節と 5 節、設定の配信（証明書・ルートがノードへ届く仕組み）は [deployment-and-config-distribution.md](deployment-and-config-distribution.md) にある。VPC・サブネット・AWS のアカウント・インスタンスの型は [infrastructure.md](infrastructure.md)、ノードの台数は [capacity.md](capacity.md)、不正な内容の停止は [abuse-and-trust-safety.md](abuse-and-trust-safety.md) にある。

本家・AWS・ACME の振る舞いと数値は、2026-09-27 に各社の文書、RFC、本家のブログで確かめた。

## 1. 目的と範囲

- 目的：利用者の要求を、最寄りのリージョンの、温かい isolate を持つノードへ届ける。リージョンやノードが落ちても、新しい接続は自動で別の場所へ向かう。証明書の期限切れで止まらない。他のテナントのホスト名を奪えない。
- 範囲と、範囲の外：

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| Global Accelerator・NLB の構成、トラフィックダイヤル、クライアントのアフィニティ | VPC、サブネット、AWS のアカウントの分け方（infrastructure） |
| 既定のサブドメインとカスタムドメインの DNS、所有の確認 | ドメインの管理画面・API の形（dashboard-and-api） |
| TLS の終端、ACME での証明書の発行・更新、鍵の保管と配布、SNI | シークレットの鍵の階層の全体（security） |
| ルートのパターンと解決、オリジンへの転送、自分のホスト名への内部の経路 | 版の選び方（段階的なデプロイ。[deployment-and-config-distribution.md](deployment-and-config-distribution.md)） |
| リージョンの迂回と退かせ方、ノードの間の負荷分散、ホームのノードへの転送 | ノードの台数とインスタンスの型（capacity、infrastructure） |
| 外向きのプロキシの実装（名前の解決、接続、数の強制） | 外向きのプロキシが守る不変条件（sandbox-and-security の 7 節） |
| 遅延の見積もりと本家との比較 | 合成監視の基盤（observability） |

## 2. 本家と AWS・ACME の仕組み（確かめたこと）

| 項目 | 事実 | 出典（すべて 2026-09-27 に確認） |
| --- | --- | --- |
| 本家の網 | 100 か国以上の 348 都市。インターネットの利用者の 95% が 50ms 以内 | [Cloudflare Global Network](https://www.cloudflare.com/network/) |
| 本家のルートの文法 | 演算子はワイルドカード `*` だけ。途中の `*` とクエリは不可。ホスト名は先頭の `*`、パスは末尾の `*` だけ。複数が当たるときは「最も具体的なもの」が勝つ。関数のないルートは、それより弱いパターンを打ち消す。`*example.com` は `myexample.com` にも当たる | [Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/) |
| 本家のカスタムドメイン | 関数をオリジンにする。ホスト名と完全一致（ワイルドカードの DNS は不可）。同じホスト名のルートがあればルートが先に動き、`fetch(request)` でカスタムドメインの関数を呼べる | [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) |
| 本家の上限 | ゾーンあたりルート 1,000、カスタムドメイン 100。URL 16KB、要求ヘッダー 128KB、要求の本文は無料・Pro で 100MB | [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Global Accelerator の IP | 標準のアクセラレーターは静的な anycast の IPv4 を 2 つ。デュアルスタックでは IPv6 も 2 つ（同じ 2 つの /64 から）。アクセラレーターを消すと IP を失う | [How AWS Global Accelerator works](https://docs.aws.amazon.com/global-accelerator/latest/dg/introduction-how-it-works.html) |
| TCP の終端 | 利用者の TCP を AWS の edge で終端し、ほぼ同時にエンドポイントへ新しい TCP を張る | 同上 |
| アイドルのタイムアウト | TCP 340 秒、UDP 30 秒。変えられない。TCP の keep-alive では延ばせない（1 バイト以上のデータが要る）。確立済みの接続は、エンドポイントが不健全・削除でもタイムアウトまで元へ流れる | 同上 |
| 健全性と迂回 | 不健全を検知すると、新しい接続を直ちに他の健全なエンドポイントへ向ける。エンドポイントグループに健全なものがなければ、近い 3 つのグループまで探す。見つからなければ最寄りのグループの任意のエンドポイントへ送る（fail open）。迂回ではトラフィックダイヤル 0 のグループも候補になる。回復後は約 30 秒で元の振り分けに戻る | 同上、[How failover works](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-endpoints-endpoint-weights.unhealthy-endpoints.html) |
| トラフィックダイヤルと重み | ダイヤルはエンドポイントグループ（リージョン）ごとの 0〜100%。既定は 100。変更は新しい接続にだけ効く。重みはエンドポイントごとの 0〜255（既定 128） | [Traffic dials](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-endpoint-groups-traffic-dial.html) |
| クライアントのアフィニティ | 既定は None で、5 つ組のハッシュ。Source IP では送信元と宛先の IP の 2 つ組のハッシュで、同じ送信元を同じエンドポイントグループへ送る。edge の位置が変わると保たれない | [Client affinity](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-listeners-client-affinity.html) |
| NLB のエンドポイント | 利用者の IP を保つのは、セキュリティグループを持つ NLB の TCP・UDP のリスナーだけ（TLS のリスナーでは保たない）。デュアルスタックのアクセラレーターには、IP を保つエンドポイントだけを足せる。既存の IPv4 のアクセラレーターを、NLB のエンドポイントのままデュアルスタックへ上げられない。NLB はゾーンをまたぐ振り分けを切ることを勧める（接続の衝突を避ける） | [Endpoint requirements](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-endpoints-caveats.html) |
| 上限 | 標準のアクセラレーター 20／アカウント、リスナー 10、エンドポイントグループはリスナーの数×グループの数で 42 まで、グループあたりの NLB 10、カスタムルーティングのアクセラレーター 10 | [Quotas](https://docs.aws.amazon.com/global-accelerator/latest/dg/limits-global-accelerator.html) |
| 料金 | アクセラレーター 1 つ 0.025 ドル／時（約 18 ドル／月）。加えて DT-Premium（多い方向だけ）。価格表の使用量の種類は `<エンドポイントのリージョンの地域>-<利用者の地域>-OUT-Bytes-Internet` で、アジア太平洋のリージョンからアジア太平洋の利用者へ 0.010、北米の利用者へ 0.012、欧州の利用者へ 0.043 ドル／GB。北米・欧州のリージョンから同じ地域の利用者へは各 0.015 ドル／GB | [Pricing](https://aws.amazon.com/global-accelerator/pricing/)、価格表の API（`AWSGlobalAccelerator`、2026-09-27） |
| edge の数 | 53 か国の 95 都市に 130 の PoP | [Features](https://aws.amazon.com/global-accelerator/features/) |
| API の場所 | Global Accelerator の API はすべて us-west-2 で呼ぶ | [Quotas](https://docs.aws.amazon.com/global-accelerator/latest/dg/limits-global-accelerator.html) |
| BYOIP | IPv4 だけ。他所での広告を止めてから AWS で広告する。自前の範囲から割り当てられるのはアクセラレーターの 1 つの IP で、もう 1 つは Amazon の範囲から（範囲を 2 つ持てば両方を自前にできる） | [BYOIP](https://docs.aws.amazon.com/global-accelerator/latest/dg/using-byoip.html) |
| カスタムルーティング | 静的な IP とポートの組で、VPC のサブネットの特定の EC2 とポートへ送る。IPv4 だけ。健全性の検査も迂回もない | [How AWS Global Accelerator works](https://docs.aws.amazon.com/global-accelerator/latest/dg/introduction-how-it-works.html) |
| NLB のアイドル | TCP のリスナーは既定 350 秒、60〜6,000 秒で変えられる | [Update the TCP idle timeout](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/update-idle-timeout.html) |
| ACME | 注文の状態は `pending`→`ready`→`processing`→`valid`（または `invalid`）。HTTP-01 は `http://<ドメイン>/.well-known/acme-challenge/<token>` に鍵の認可を置く。DNS-01 は `_acme-challenge.<ドメイン>` の TXT に `base64url(SHA-256(鍵の認可))` を置く。外部のアカウントの結び付け（EAB）がある | [RFC 8555](https://www.rfc-editor.org/rfc/rfc8555.html) の 7.1.6 節、8.3 節、8.4 節、7.3.4 節 |
| 更新の時期 | ACME のサーバーが更新の推奨の窓を示す（ARI） | [RFC 9773](https://www.rfc-editor.org/rfc/rfc9773.html)（2025-06） |
| Let's Encrypt の上限 | 新しい注文 300／3 時間／アカウント。登録ドメインあたり 50 枚／7 日。同じ名前の組 5 枚／7 日。識別子ごとの認可の失敗 5／時。1 枚に 100 名まで。ARI による更新はすべての上限の対象外。上限の引き上げは「注文」と「登録ドメインあたり」だけ | [Rate Limits](https://letsencrypt.org/docs/rate-limits/) |
| 証明書の期間 | 2026-05-13 に `tlsserver` のプロファイルが 45 日に。既定の `classic` は 2027-02-10 に 64 日（認可の再利用 10 日）、2028-02-16 に 45 日（認可の再利用 7 時間） | [Decreasing Certificate Lifetimes to 45 Days](https://letsencrypt.org/2025/12/02/from-90-to-45)、[Shorter Certificate Lifetimes and Rate Limits](https://letsencrypt.org/2026/02/24/rate-limits-45-day-certs) |
| 検証の方式 | HTTP-01 はポート 80、ワイルドカード不可。DNS-01 はワイルドカード可、`_acme-challenge` を CNAME・NS で委ねられる。TLS-ALPN-01 はポート 443、ワイルドカード不可 | [Challenge Types](https://letsencrypt.org/docs/challenge-types/) |
| 検証の地点 | 複数のネットワークの地点から検証する（2024 年の時点で主 1 と遠隔 4。いまの数と定足数は公開の文書で確かめられなかった。この設計は「全リージョンの適用を待つ」ので数に依らない。7.2 節） | [Princeton partnership](https://letsencrypt.org/2024/05/30/princeton-partnership) |
| OCSP | Let's Encrypt は 2025-08-06 に OCSP の応答を止めた | [Ending OCSP Support in 2025](https://letsencrypt.org/2024/12/05/ending-ocsp/) |
| ZeroSSL | ACME の窓口は EAB が必須。90 日の証明書を無償で数の制限なく発行。EAB の資格情報の発行に 1 日の上限（値は非公開）。サブドメインのラベルは 6 つまで | [ZeroSSL ACME](https://zerossl.com/documentation/acme/) |
| Public Suffix List | 本家の既定のドメイン（`workers.dev`）は PSL の私的な部分に載っている。PSL は「他社のレート制限を避けるだけの目的」の登録を断る。処理の期限の約束はない。登録ドメインの残りの期間 2 年以上が要る | [public_suffix_list.dat](https://publicsuffix.org/list/public_suffix_list.dat)、[PSL Guidelines](https://github.com/publicsuffix/list/wiki/Guidelines) |
| Route 53 | 1 ホストゾーンのレコード 10,000（引き上げは有料） | [Route 53 quotas](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSLimitations.html) |
| Pingora | Apache-2.0。HTTP/1・HTTP/2 の端から端までのプロキシ、gRPC・WebSocket、TLS は OpenSSL・BoringSSL・s2n・rustls（実験）。無停止の再読み込み。本家で毎秒 4,000 万要求以上を数年扱う | [pingora](https://github.com/cloudflare/pingora) |

## 3. 原則

- **要求の処理で、制御プレーンを呼ばない。** ホスト名、ルート、証明書、版の割合は、ノードの LMDB の写しから引く（ADR-0004）。
- **健全性の検査は、ノードの局所の故障だけを見る。** 制御プレーンや設定の配信が止まっても、全ノードが一斉に不健全にならないようにする（静的な安定。[deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 9 節）。
- **退かせる操作は、データプレーンで完結させる。** Global Accelerator の API（us-west-2）が使えなくても、リージョンとノードを退かせられるようにする。
- **ホスト名は、所有を確かめたアカウントにだけ結び付ける。** DNS が向いているだけでは結び付けない。
- **利用者が送った `<Brand>-*` のヘッダーを信じない。** 入口で消し、入口が計算した値だけを付ける（ADR-0016）。

## 4. 経路の全体

```
利用者
  │ DNS：<worker>.<account>.<brand>.<domain> → CNAME edge.<brand>.<domain> → A/AAAA（GA の 4 つの IP）
  │      app.example.jp → CNAME <hostname-id>.cname.<brand>.<domain> → 同上
  ▼
Global Accelerator の edge（TCP を終端）──AWS のバックボーン──▶ 最寄りのリージョン
  ▼
NLB（TCP 80・443、利用者の IP を保つ、ゾーンをまたがない）
  ▼
エッジのノード A（受けたノード）
  入口のプロキシ（Pingora）
   1. ClientHello の SNI → 証明書を選ぶ（7.5 節）。ホームのノードへ先読みを送る
   2. TLS の終端、HTTP の解析、`<Brand>-*` のヘッダーの削除
   3. ルートの解決（8 節）→ 関数と版（段階的なデプロイ）
   4. ランデブーハッシュでホームのノードを決める（9.1 節）
      ├─ 自分 → 自分のスーパーバイザーへ
      └─ 他のノード B → mTLS の HTTP/2 で転送（1 回だけ）。B が断ったら自分で動かす
  ▼
ランタイム（isolate）→ サブリクエスト → 外向きのプロキシ（10 節）→ インターネット
```

- 1 つのノードは、入口のプロキシ、スーパーバイザー、ランタイムのプロセス、外向きのプロキシ、設定の写しの受け手を持つ（[runtime-and-isolates.md](runtime-and-isolates.md) の 5.1 節）。
- 入口のプロキシと外向きのプロキシは、ノードの上の別のプロセスにする。片方の欠陥で、もう片方の権限（TLS の秘密鍵、外への網）に届かないようにする。

## 5. anycast と Global Accelerator

[ADR-0017](../decisions/0017-global-accelerator-and-regional-nlb.md)。

### 5.1 構成

| 資源 | S1 の設定 | 理由 |
| --- | --- | --- |
| アクセラレーター | 標準、デュアルスタック（IPv4 2＋IPv6 2）。本番用 `ga-primary` と予備 `ga-standby` の 2 つ | 既存の IPv4 のアクセラレーターは NLB のままデュアルスタックへ上げられない（2 節）。最初からデュアルスタックにする |
| リスナー | TCP 443 と TCP 80 の 1 つのリスナー（ポートの範囲 2 つ）。クライアントのアフィニティは None | リスナーを 1 つにすると、エンドポイントグループを最大 42 のリージョンに向けられる（S2 の 12〜15 に足りる） |
| エンドポイントグループ | 5 リージョン（東京・大阪・海外 3）。ダイヤル 100 | ADR-0003 |
| エンドポイント | リージョンごとに NLB 1 つ。利用者の IP を保つ（`ClientIPPreservationEnabled`） | 入口のプロキシが利用者の IP を直接見る。Proxy Protocol は使わない |
| NLB | インターネット向け、デュアルスタック、セキュリティグループあり。TCP のリスナー 80・443。ゾーンをまたぐ振り分けを切る。3 つの AZ。アイドル 350 秒（既定） | 2 節の要件。TLS は NLB で終端しない |
| ターゲットグループ | インスタンスのターゲット（エッジのノード）。登録の解除の遅延 60 秒。解除時に接続を切る設定は切る（入口のプロキシが GOAWAY で閉じる） | 9.2 節 |
| NLB の健全性の検査 | HTTP、ポート 8081 の `/healthz`、10 秒ごと、2 回で不健全・3 回で健全 | 9.3 節 |

- 利用者の IP が GA → NLB → インスタンスで保たれることは、文書で確かめた（デュアルスタックのアクセラレーターは IP を保つエンドポイントだけを受け、NLB のエンドポイントでは GA と NLB が元の IP を IP ヘッダーに入れる。[ADR-0017](../decisions/0017-global-accelerator-and-regional-nlb.md)、2026-09-27）。IPv4・IPv6 の両方を、E4 の最初（`client-ip-preservation-check`）に実機でも確かめる。
- ノードは NLB 以外からの 80・443 を受けない（セキュリティグループ）。GA の後ろのエンドポイントへ直接の通信を送ると、接続の衝突が起きうるため（2 節）。

### 5.2 アフィニティ・ダイヤル・重み

| 仕組み | 使い方 |
| --- | --- |
| クライアントのアフィニティ | None。関数の状態は isolate に持たない前提で、同じ利用者を同じリージョンに固定する必要がない。Source IP にすると、大きな NAT の後ろの利用者が 1 つのエンドポイントグループに偏る |
| トラフィックダイヤル | 計画した作業（リージョンの追加、段階的な流し込み）にだけ使う。新しいリージョンは 0 → 10 → 50 → 100 と上げる。API が us-west-2 にあるので、障害の対応の主な手段にはしない |
| 重み | NLB が 1 つなので使わない（128 のまま） |
| 健全性による迂回 | 障害の対応の主な手段。リージョンを退かせるときも、健全性の検査を落として迂回させる（9.2 節） |

### 5.3 IPv6・BYOIP・予備のアクセラレーター

- **予備のアクセラレーター**：`ga-standby` を同じ NLB に向けて常に作っておく（約 18 ドル／月）。`edge.<brand>.<domain>` の CNAME・A・AAAA を切り替えれば、既定のドメインと CNAME のカスタムドメインは予備へ移る。apex を A レコードで向けた利用者は移らない（6.2 節で危険を示す）。
- **BYOIP（S2）**：自前の IPv4 の範囲を 2 つ用意し、`ga-primary` の 2 つの IPv4 を両方とも自前にする（範囲 1 つだと 1 つは Amazon の IP のまま。2 節）。S3 で自前の PoP へ移るとき、apex の A レコードを変えずに済む。
- **IPv6**：BYOIP は IPv4 だけ。IPv6 は S3 まで Amazon の IPv6 のまま。S3 の移行で IPv6 の AAAA は変わる。apex の AAAA を固定で書く利用者には、この点を文書で示す。
- **HTTP/3**：S1 では持たない（`Alt-Svc` を出さない）。UDP のアイドルのタイムアウトが 30 秒であること、QUIC の接続の移動と NLB の振り分けの相性を、S2 の前に確かめる。NLB は QUIC・TCP_QUIC のリスナー（通すだけ、QUIC v1 だけ）を持つ（[Listeners](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-listeners.html)、2026-09-27 に確認）。GA の UDP のリスナーから NLB の QUIC のリスナーへの組み合わせは未検証（HTTP/3 は延期の一覧。S2 の前に確かめる）。

## 6. DNS

### 6.1 既定のサブドメイン

- 形：`<worker>.<account>.<brand>.<domain>`（intent）。`<account>` はアカウントが最初に選ぶサブドメインの名前（英小文字・数字・ハイフン、3〜40 文字、予約語を除く）。
- **既定のドメインは、ダッシュボード・API と別の登録ドメインにする。** 既定のドメインがフィッシングで遮断の一覧に載っても、管理の画面が止まらないようにする。Cookie の範囲も分かれる。
- **既定のドメインを Public Suffix List に載せる。** 目的は、アカウントの間で Cookie を共有させないこと（`<a>.<brand>.<domain>` が `<brand>.<domain>` の Cookie を設定できないようにする）。本家の既定のドメインも PSL に載っている（2 節）。副次的に Let's Encrypt の「登録ドメインあたり」の上限がアカウントごとになるが、PSL はレート制限の回避だけを目的とする登録を断るので、それを理由にしない。載るまでの期間は約束されない（2 節）。
- ゾーンは Route 53 に置く。

| レコード | 値 | 備考 |
| --- | --- | --- |
| `edge.<brand>.<domain>` | A・AAAA：`ga-primary` の 4 つの IP（TTL 300） | 予備への切り替えはこの 1 つを書き換える |
| `*.<account>.<brand>.<domain>` | CNAME `edge.<brand>.<domain>`（TTL 3600） | アカウントごとに 1 つ |
| `_acme-challenge.<account>.<brand>.<domain>` | TXT（発行の間だけ） | 7.2 節 |
| `<hostname-id>.cname.<brand>.<domain>` | CNAME `edge.<brand>.<domain>` | カスタムホスト名の向き先（6.2 節） |

- **ゾーン全体のワイルドカード（`*.<brand>.<domain>`）は使わない。** `_acme-challenge.<account>…` を作ると `<account>.<brand>.<domain>` が「空の中間の名前」になり、その下の名前はゾーン全体のワイルドカードに当たらなくなる（DNS のワイルドカードの規則。RFC 4592）。アカウントごとにワイルドカードのレコードを置く。
- S1 の 1 万アカウントで約 1 万レコードになり、Route 53 の既定の上限（10,000）に当たる。E4 の前に上限を引き上げる。S2 の 10 万アカウントでも Route 53 で扱う。S3（100 万）では、名前を合成して答える自前の権威 DNS を検討する（未解決の問い）。
- アカウントのサブドメインを取り消した（アカウントの削除）名前は、90 日は他のアカウントに渡さない。古い URL に残る利用者を、別のテナントの関数へ送らないため。

### 6.2 カスタムドメインとカスタムホスト名

本家は利用者の DNS を自分で持つ（ゾーン）。この題材は DNS の製品を持たないので、**所有を確かめた「ドメイン」と、その下の「ホスト名」**で扱う。考え方は Auth0 の題材のカスタムドメイン（[auth0 の custom-domains.md](../../../auth0/docs/architecture/custom-domains.md)）に寄せる。

1. **ドメインの所有の確認**：アカウントが `example.jp` を登録すると、`_<brand>-challenge.example.jp  TXT "<brand>-domain-verification=<128 ビットの乱数の base32>"` を示す。異なる事業者の 2 つ以上の公開のリゾルバーで同じ値が見えたら `verified`。サブドメイン（`api.example.jp`）でも確かめられる。
2. **ホスト名の追加**：`verified` のドメインの下のホスト名（`app.example.jp`）をアカウントに足す。ホスト名は全体で 1 つのアカウントにだけ属す（一意の索引）。同じホスト名を覆う確認済みのドメインが 2 つのアカウントにあるときは、より具体的なドメインを確かめたアカウントが勝つ。
3. **向き先**：`app.example.jp CNAME <hostname-id>.cname.<brand>.<domain>`。apex は CNAME を置けないので、ALIAS・CNAME のフラット化か、A・AAAA で `ga-primary` の IP を向ける（予備への切り替えと S3 の IPv6 の変更に追従しない危険を画面で示す）。
4. **証明書**：向き先を確かめてから HTTP-01 で発行する（7 節）。DNS-01 の委任（`_acme-challenge.app.example.jp CNAME <hostname-id>.acme.<brand>.<domain>`）を置けば、向き先を切り替える前に発行でき、ワイルドカード（`*.example.jp`）も発行できる。
5. **有効化**：証明書を配り、全リージョンのノードの適用を確かめてから `active` にする。

```
hostnames.status：
 pending_domain ─(親のドメインが verified)─▶ pending_dns ─(CNAME・A が向いた、または DNS-01 の委任がある)─▶ issuing
   issuing ─(証明書の発行、全リージョンのノードの適用)─▶ active
   issuing ─(CAA の拒否、検証の失敗 5 回)─▶ failed ─(再試行の要求)─▶ pending_dns
   active ─(TXT が 30 日見えない、向き先が 30 日外れた、アカウントの停止)─▶ suspended ─(回復)─▶ active
   * ─(削除)─▶ deleting → 設定の写しから消す → deleted
```

- `active` の後も、24 時間ごとに TXT と向き先を確かめる。7 日見えなければ警告し、30 日で `suspended` にする（Auth0 の題材の ADR-0038 と同じ間隔）。向き先が外れたまま更新の時期が来ると HTTP-01 の更新は失敗するので、更新の失敗より先に警告を出す。
- **ホスト名の制約**：PSL の公開のサフィックスそのもの、自分たちのドメイン（既定のドメイン、管理のドメイン）とその下、異なる文字体系を混ぜた IDN、253 文字を超える名前を拒否する。IDN は Punycode で持つ。
- **上限（S1）**：1 アカウントのドメイン 100、ホスト名 1,000、ルート 1,000（本家はゾーンあたりルート 1,000・カスタムドメイン 100。2 節）。値は limits-and-billing で確定する。

## 7. TLS と証明書

[ADR-0018](../decisions/0018-acme-certificates-and-sni.md)。

### 7.1 発行の方式

| 対象 | 証明書 | 検証 | 理由 |
| --- | --- | --- | --- |
| 既定のサブドメイン | アカウントごとに `*.<account>.<brand>.<domain>` の 1 枚 | DNS-01（自分たちの Route 53） | 2 段のワイルドカードは 1 枚で覆えない。関数ごとの証明書は数が多すぎる |
| カスタムホスト名 | ホスト名ごとに 1 枚 | HTTP-01（既定）。DNS-01 の委任があれば DNS-01 | 利用者に DNS の API の資格情報を求めない |
| ワイルドカードのカスタムホスト名（`*.example.jp`） | 1 枚 | DNS-01 の委任だけ | HTTP-01 はワイルドカード不可（2 節） |
| 内部（ノードの間の転送、中継） | 内部の CA（AWS Private CA、または自前の CA。infrastructure で決める） | — | 公開の CA を使わない |

- **証明書の発行局**：Let's Encrypt を主に、ZeroSSL を予備にする。両方の ACME のアカウントを常に持ち、主が 1 時間続けて失敗したら予備で発行する。
- **鍵**：ECDSA P-256。RSA 2048 の証明書も併せて持つかは、E4 で古い端末の割合を見て決める（S1 の既定は ECDSA だけ）。
- **更新**：ARI（RFC 9773）の推奨の窓で更新する。ARI の更新は Let's Encrypt の全上限の対象外（2 節）。ARI が使えないときは、有効期間の 2/3 を過ぎたら更新する。45 日の証明書（2028 年から既定）でも、残り 15 日の余裕を持つ。
- **CAA**：既定のドメインのゾーンに、2 つの発行局だけを許す CAA を置き、`accounturi`（RFC 8657）で自分たちの ACME のアカウントに限る。カスタムホスト名で利用者の CAA が発行局を許していなければ、`failed`（`caa_forbidden`）と足すべきレコードを示す。
- **OCSP の stapling はしない**（Let's Encrypt は OCSP を止めた。2 節）。

### 7.2 ACME の流れ

証明書の管理は、制御プレーンの `cert-manager`（東京の ECS のワーカー、1 つのリーダー）が行う。

```
HTTP-01（カスタムホスト名）
cert-manager             Aurora / 変更のログ          全リージョンのノード           ACME（Let's Encrypt）
 │ newOrder(app.example.jp) ───────────────────────────────────────────────────────▶│
 │◀──────────────────────────── authz と http-01 の token ─────────────────────────│
 │ acme_challenges に (host, token, 鍵の認可) を書く（優先の印）─▶ 配信 ─▶ LMDB に適用
 │ 全リージョンの全ノードの適用の番号 ≥ その番号 を待つ（最大 60 秒）
 │ challenge の応答 ───────────────────────────────────────────────────────────────▶│
 │                                              ◀── 複数の地点から GET http://app.example.jp/.well-known/acme-challenge/<token>
 │                                                 （anycast で各地点に近いリージョンへ届く。どのノードも答えられる）
 │ 注文が ready → CSR で finalize → 証明書を得る ◀─────────────────────────────────│
 │ 鍵を包み（7.4 節）、certificates に書く → 配信 → ノードが SNI で使う
 │ acme_challenges を消す
```

- **全リージョンの適用を待ってから検証を頼む。** 発行局は複数の地点から検証し（2 節）、各地点の要求は anycast で別のリージョンへ届きうる。1 つのリージョンでもトークンがないと失敗しうる。
- HTTP-01 の要求は、入口のプロキシがルートの解決より先に答える。答えるのは、そのホスト名に対して自分たちが発行したトークンだけ。それ以外の `/.well-known/acme-challenge/` はルートの解決へ回す（利用者が自分で ACME を使う場合のため）。
- ポート 80 の他の要求は、ルートの解決に回す（8 節。既定は HTTPS への 301）。
- DNS-01（既定のサブドメイン）は、Route 53 に TXT を書き、変更が `INSYNC` になってから検証を頼む。
- **発行の時期**：既定のサブドメインの証明書は、アカウントがサブドメインを選んだ時点で発行する。最初のデプロイ（K4 の 5 分）の経路に発行を入れない。

### 7.3 レート制限への対応

| 上限（Let's Encrypt） | S1 の見込み | 対応 |
| --- | --- | --- |
| 登録ドメインあたり 50 枚／7 日 | 既定のドメインで新しいアカウントが週 50 を超えうる（1 万アカウント／年で週約 200） | 引き上げを申請する（この上限は引き上げの対象。2 節）。PSL への掲載が済めばアカウントごとの登録ドメインになる。どちらも間に合わない週は ZeroSSL で発行する |
| 新しい注文 300／3 時間／アカウント | 新規の発行は 1 日 100 未満の見込み（S1 の 1 年でアカウント 1 万・ホスト名 2 万の仮定から 1 日 約 80） | 足りる。越えたら引き上げを申請する |
| 識別子ごとの認可の失敗 5／時 | 利用者の DNS の誤りで失敗が続く | 向き先の確認（DNS の問い合わせ）を通ってから注文する。失敗は 1 時間に 2 回までに抑え、`failed` の後は利用者の再試行の要求を待つ |
| 同じ名前の組 5 枚／7 日 | 再発行の繰り返し | 鍵の紛失以外で再発行しない |
| 更新 | S1 で証明書 3 万枚（アカウント 1 万＋ホスト名 2 万の仮定）を 60 日ごとなら 1 日約 500 | ARI の更新は上限の対象外 |

### 7.4 保管と配布

- **秘密鍵は cert-manager で作り、平文で保存しない。** 鍵はリージョンのデータ鍵（RDK）で AES-256-GCM で包み、`certificates` に保存し、設定の写しで全ノードへ配る。
- **RDK**：リージョンごとの 256 ビットの鍵。そのリージョンの KMS の鍵（`edge-tls`）で包んだ形で、設定の写しに入れる。毎月入れ替え、前の版は 2 か月残す。cert-manager は、証明書の鍵を 5 つのリージョンの RDK でそれぞれ包む（1 枚あたり 5 つの包み）。
- **ノードは RDK を起動時に 1 回だけ KMS で開く**（暗号化の文脈 `purpose=edge-tls, region=<r>` を必須にする）。開いた RDK と証明書の鍵は、入口のプロキシのメモリにだけ置く（`mlock`、コアダンプなし）。
- KMS に届かないとき：動いているノードは、メモリの RDK で続ける。新しく起動したノードは RDK を開けるまで健全にならない（NLB に入らない）。
- 入口のプロキシのプロセスだけが、LMDB の `certs` の読み込みと KMS の復号の権限を持つ。外向きのプロキシ、ランタイムは持たない。
- 証明書の鍵の包みは 1 枚約 1KB、証明書の鎖は約 3KB。S1 の 3 万枚で約 150MB を各ノードの LMDB に持つ（capacity で確かめる）。

### 7.5 SNI とハンドシェイク

1. ClientHello の SNI を小文字にし、末尾のドットを除く。
2. 引く順：`certs_by_host/<host>`（完全一致）→ `certs_by_host/*.<親>`（1 段のワイルドカード）。
3. 見つからない、または SNI がない：GA の IP への直接の接続か、未登録のホスト名。自分たちの既定の証明書は出さず、TLS のアラート `unrecognized_name` で閉じる（名前の列挙を防ぐ）。
4. 証明書と鍵は、メモリの LRU（既定 2 万枚）に復号した形で持つ。外れたら LMDB から読み、RDK で開く（1ms 未満の見込み。未検証。E4 の `ingress-proxy` の性能の試験で測る）。
5. ホスト名がルートを持てば、SNI の時点でホームのノードへ先読みを送る（[runtime-and-isolates.md](runtime-and-isolates.md) の 5.2 節）。
6. **SNI と `Host` の食い違い**：HTTP/1.1 で `Host` が SNI と違う、または HTTP/2 で `:authority` が証明書の名前に含まれないときは 421 を返す。別のテナントのホスト名への要求を、他のテナントの TLS の接続で通さない。HTTP/2 の接続の合体（coalescing）は、同じ証明書が覆う名前の中でだけ起きる。

### 7.6 TLS の方針

- TLS 1.2 と 1.3。1.2 は ECDHE と AEAD の暗号だけ。1.0・1.1 は受けない。
- **0-RTT（early data）は受けない。** 再送の攻撃の危険を、関数の書き手に負わせないため。
- セッションの再開は、チケットで行う。チケットの鍵はリージョンごとに 1 時間で入れ替え、設定の写しで配る（同じリージョンのノードの間で再開できる）。
- 応答に HSTS は付けない。付けるのは関数の判断にする（既定のサブドメインは S2 で PSL の掲載の後に、`max-age` だけの HSTS を検討する）。
- ALPN：`h2` と `http/1.1`。

## 8. ルートの解決

[ADR-0019](../decisions/0019-route-matching-and-home-node-forwarding.md)。

### 8.1 表とパターン

本家の文法に寄せ、誤解の多い形を削る。

| 形 | 受け付けるか | 例 |
| --- | --- | --- |
| ホスト名の完全一致＋パス | 受ける | `example.jp/api/*`、`app.example.jp/` |
| 先頭の `*.`（サブドメインだけ） | 受ける | `*.example.jp/*` |
| 先頭の `*`（ドットなし） | **受けない** | `*example.jp/*`（本家では `myexample.jp` にも当たる。2 節）。`example.jp/*` と `*.example.jp/*` の 2 つで書いてもらう |
| スキームの指定 | 受ける | `https://example.jp/*`（HTTPS だけに当たる） |
| パスの末尾の `*` | 受ける | `/images/*`、`/path*` |
| 途中の `*`、クエリ | 受けない | `example.jp/*.jpg`、`example.jp/?a=*` |
| 関数のないルート | 受ける | それより弱いパターンを打ち消す（本家と同じ） |

- パターンのホスト名は、そのアカウントが持つホスト名（`active`）か、確認済みのドメインの下にあること。ホスト名の部分は大文字と小文字を区別しない。パスは区別する（本家の 2023-10-15 以降と同じ）。
- **カスタムドメイン**（本家の Custom Domains に当たる）は、ホスト名に「既定の関数」を結ぶもの。パスを見ない。

ノードの LMDB の形（配信の器は [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 6.3 節）：

```
host/<hostname>                    → { account_id, kind: default|custom, hostname_id,
                                       default_script_id?,             // custom domain or <worker>.<account>
                                       origin?: { url, host_header?, tls: "strict" },
                                       http_policy: "redirect_https" | "allow_http",
                                       status: active|suspended }
routes/<hostname>                  → [ { pattern_id, scheme?: "https"|"http", path, path_wildcard: bool,
                                         script_id? } ... ]  // exact-host routes, sorted by specificity
routes_wild/<parent-hostname>      → same list for "*.<parent>" patterns
```

- 既定のサブドメインは `host/<worker>.<account>.<brand>.<domain>` を、関数の作成時に書く（`default_script_id` だけ）。
- ホスト名の表と既定の関数は、アカウント・関数の停止のとき `suspended` になる（優先の印で配る）。

### 8.2 解決の順（決定表）

`DT-ROUTE-001`：要求 `(scheme, host, path+query)` に対し、上から順に最初に当たった行。

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | `host` が `host/` にない | 421（SNI で既に閉じているはず。平文の 80 番ではここで 404） |
| 2 | `host` が `suspended` | 403 と `<brand>` のエラーの頁（停止の理由は出さない） |
| 3 | ポート 80 で、自分たちが発行した ACME のトークンのパス | トークンを返す（7.2 節） |
| 4 | ポート 80 で、`http_policy = redirect_https` | 301 で `https://` へ |
| 5 | `routes/<host>` に当たるものがある | 最も具体的なもの（下の順位）。`script_id` がなければ 8 番へ |
| 6 | `routes_wild/<親>` に当たるものがある | 同上 |
| 7 | `default_script_id` がある | その関数 |
| 8 | `origin` がある | オリジンへ転送（8.3 節） |
| 9 | それ以外 | 404 と `<brand>` のエラーの頁 |

**「最も具体的」の順位**（本家は順位を細かく公開していないので、ここで決める）：

1. ホスト名の完全一致は、`*.` のワイルドカードに勝つ。ワイルドカード同士は、親の名前が長い方が勝つ。
2. パスの前方の部分が長い方が勝つ（`/hello/*` は `/*` に勝つ）。
3. 同じ長さなら、末尾の `*` のないもの（完全一致）が勝つ。
4. スキームを指定したものが、指定のないものに勝つ。
5. それでも同じなら、作成の早いもの（`pattern_id` の小さいもの）。同じアカウントの中でしか起きない。

- パスの照合は、URL のパスとクエリを合わせた文字列に対して行う（本家と同じ。末尾が `*` でないパターンは、クエリのある要求に当たらない）。パスの正規化（`%2F`、`..`）はしない。照合の前に `..` を含むパスは 400 にする。
- 照合は、ホスト名ごとの並べ替え済みの一覧を前から見るだけ（1 ホスト名 1,000 ルートで 10µs 未満の見込み。未検証。E4 の `route-resolution` のベンチマークで測る）。

### 8.3 オリジンと、自分のホスト名への内部の経路

- **オリジン**：ホスト名に `origin` を設定すると、どのルートにも当たらない要求を、そのオリジンへ転送する。関数の中の `fetch(request)`（同じホスト名の同じ URL）も、ルートを通らずオリジンへ行く（本家のルートの「関数はオリジンの前に立つ」振る舞い）。
- オリジンへの転送は、**外向きのプロキシを通す**（10 節）。宛先の検査（内部のアドレスの拒否）を同じにし、利用者がオリジンに `10.0.0.1` を設定して内部へ届くことを防ぐ。オリジンの TLS は検証する（`strict` だけ。S1 は検証を切る設定を持たない）。
- **自分のホスト名への `fetch`**（既定のサブドメインと、この基盤のカスタムホスト名）：外向きのプロキシは宛先のホスト名を `host/` で引き、あればインターネットへ出さず、同じノードの入口のプロキシへ内部の経路で渡す。

`DT-ROUTE-002`：関数 F（ホスト名 H のルートで動く）の `fetch(url)` の宛先。

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | `url` のホスト名が `host/` にない | インターネットへ（外向きのプロキシの検査） |
| 2 | `url` のホスト名が H で、F が H の「ルート」で動いている | H の `origin` へ（ルートを通らない）。`origin` がなければ 8.2 節の 7 番（既定の関数）、それもなければ 404 |
| 3 | それ以外（別のホスト名、または H の既定の関数） | 8.2 節の解決で、そのホスト名の関数を動かす（本家のカスタムドメインの重ね方） |

- 内部の経路の深さを、内部のヘッダー `<Brand>-Loop`（入口のプロキシが付け、外からの値を消す）で数え、16 を超えたら 508 にする（値は既定案）。
- 内部の経路の要求も、サブリクエストの数に数える（web-apis-and-compat の 4.2 節）。

### 8.4 入口が付けるヘッダー

関数へ渡す要求（利用者が送った同じ名前のヘッダーは消してから付ける）：

| ヘッダー | 値 |
| --- | --- |
| `<Brand>-Connecting-IP` | 利用者の IP（NLB が保ったもの） |
| `<Brand>-IPCountry` | 国の 2 文字（`request.<brand>.country` と同じ計算。ADR-0016） |
| `<Brand>-Ray` | 要求の ID（16 進 16 文字＋`-`＋リージョンの記号）。ログ・tail と応答でも使う |
| `X-Forwarded-Proto` | `https`・`http` |
| `X-Forwarded-For` | 利用者が送った値の後ろに利用者の IP を足す |

応答に付けるもの：`<Brand>-Ray`。`Server` は関数が付けなければ `<brand>`。

- `request.<brand>`、`<Brand>-*` の値、選んだ版、転送の情報は、ノードの間の転送で内部のヘッダー（`<Brand>-Internal-*`）に入れる。受けたノードは、NLB から来た要求（ポート 443・80）の `<Brand>-Internal-*` を必ず消す。内部の転送はポートを分け（8443）、mTLS でノードの証明書を確かめたものだけを受ける。

## 9. 負荷分散と迂回

### 9.1 ノードの間

| 段 | 方式 | 目的 |
| --- | --- | --- |
| GA → リージョン | 近さと健全性（5 節） | 利用者を最寄りのリージョンへ |
| NLB → ノード | NLB の流れのハッシュ（同じ AZ の中） | 接続をノードへ均等に |
| 受けたノード → ホームのノード | ランデブーハッシュ（HRW） | 同じ関数の版を同じノードに寄せ、isolate を温かく保つ（[runtime-and-isolates.md](runtime-and-isolates.md) の 5.4 節） |

- **ホームのノード**：鍵 `(script_id, version_id)` と、そのリージョンの健全なノードの一覧から、`score = SipHash-2-4(seed, key ‖ node_id)` が最大のノードを選ぶ。ノードが 1 台抜けると、そのノードをホームにしていた鍵だけが動く。ノードが 60 台でも 1 要求あたりの計算は数 µs の見込み（未検証。E4 の `home-node-forwarding` のベンチマークで測る）。結果は鍵ごとに 10 秒持つ。
- **ノードの一覧**：リージョンの中継（[deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 6 節）が、ノードの心拍（1 秒ごと）と Auto Scaling の状態から作り、リージョンの中だけの流れで配る。3 秒心拍のないノード、健全でないノードは一覧から外す。要求の処理で一覧を問い合わせない。
- **転送**：受けたノードは、ホームのノードの内部のポートへ、ノードの間で張りっぱなしの HTTP/2（mTLS）で要求を流す。転送は 1 回だけ（ホームは再転送しない）。
- **断る**：ホームのノードは CPU の使用率 70% 以上、またはその cordon のプロセスが hard のメモリの段なら、すぐに「断る」（内部の 503 と印）を返す。受けたノードが自分で動かす（runtime-and-isolates の 5.4 節）。ホームが 50ms で応答の頭を返さないときも、要求の本文を送り始める前なら自分で動かす。
- **同じ AZ を先にするか**：AZ をまたぐ転送は、AZ の間の転送の料金（両方向で各 0.01 ドル/GB。[infrastructure.md](infrastructure.md) の 10.2 節）と約 1ms の往復がかかる（往復の値は未検証。E4 の `ga-cost-check` で量と一緒に測る）。S1 はリージョン全体で 1 つのランデブーにする（温かさを優先）。費用が合わなければ capacity で見直す。
- WebSocket と長い応答も、ホームのノードで動かす。転送の HTTP/2 の流れが、そのまま続く。

### 9.2 リージョンとノードを退かせる

| 対象 | 手順 | 新しい接続が止まるまで | 既存の接続 |
| --- | --- | --- | --- |
| ノード（入れ替え、AMI の更新） | 1. ノードが自分を「退避中」にし、`/healthz` を 503 にする 2. NLB が 2 回の失敗（約 20 秒）で外す 3. 入口のプロキシが HTTP/2 に GOAWAY、HTTP/1.1 に `Connection: close` を返す 4. 処理中の要求を最大 30 秒待つ 5. ターゲットの登録を外す | 約 20 秒 | 30 秒で閉じる。WebSocket も 30 秒で閉じる（runtime-and-isolates の 5.5 節と同じ） |
| リージョン（障害の疑い、計画の作業） | 1. 運用者が `region_flags/<r>` の `drain=true` を設定の写しで配る（制御プレーンが止まっていれば、そのリージョンの中継に直接書く手順を runbooks に置く） 2. そのリージョンの全ノードの `/healthz` が 503 になる 3. NLB の全ターゲットが不健全 → GA がそのエンドポイントを不健全と見て、新しい接続を近い別のリージョンへ 4. 入口のプロキシが 10 秒後に GOAWAY を送る | 約 30 秒（NLB の検知 20 秒＋GA の反映。GA の反映の時間は未検証。T5 で測る。E4 の `load-test-t5-t6-t9`） | GOAWAY と 30 秒の待ちで閉じる。GA のアイドルの 340 秒を待たない |
| リージョン（計画の、ゆっくりした移動） | トラフィックダイヤルを 100 → 50 → 0 | ダイヤルの変更は新しい接続にだけ効く | 同上 |

- **退かせる操作を、Global Accelerator の API に依存させない。** API は us-west-2 にだけある（2 節）。健全性の検査を落とせば、データプレーンだけで迂回する。
- **fail open に注意する。** GA は近い 3 つのグループに健全なものがなければ、最寄りのグループの任意のエンドポイントへ送る（2 節）。S1 の 5 リージョンで 3 つ以上を同時に退かせない。`drain` の印は、同時に 2 リージョンまでしか受け付けない（中継が 3 つ目を拒む）。
- 迂回した先のリージョンの容量：S1 は、東京が退いたときに大阪が国内の全量を受けられる台数を持つ（capacity で決める）。海外は、1 リージョンが退くと近い別のリージョンへ流れ、遅延が大きくなる（11 節）。
- **データの所在**：国内の要求が、東京・大阪の両方が退いたときに海外のリージョンで処理されうる（intent の L3）。S1 では、東京と大阪を同時に退かせる操作に、Dev と Ops の 2 人の承認を要る形にする。国内の処理に限る約束（海外へ迂回しない）を持つかは、法務の確認の後に決める。

### 9.3 健全性の検査

`/healthz`（ポート 8081、NLB からだけ届く）は、次の**局所の**条件だけで 503 にする。

| 条件 | 理由 |
| --- | --- |
| 入口のプロキシ・スーパーバイザー・外向きのプロキシのどれかが応答しない | 要求を処理できない。外向きが止まると閉じる（ADR-0010） |
| ランタイムのプロセスを 1 つも起動できない | 同上 |
| RDK を開けていない（起動の直後） | TLS を終端できない |
| 設定の写しの適用が、同じリージョンの中継の先頭より 60 秒以上遅れている（中継には届いている） | そのノードだけの故障。最新の設定を持つ他のノードへ回す |
| `region_flags/<r>.drain` または自分の退避中の印 | 9.2 節 |

**503 にしないもの**（全ノードが一斉に落ちる原因になる）：

- 中継の先頭そのものが古い（制御プレーン・配信の元の停止）。古さは警報にするが、要求は処理し続ける（ADR-0004 の静的な安定）。
- KV・オブジェクトストレージ・Durable Objects などのリージョンのサービスの不調。関数ごとのエラーとして返す。
- 証明書の更新の失敗、ACME の発行局の停止。

## 10. 外向きのプロキシの実装

[ADR-0020](../decisions/0020-pingora-ingress-and-egress-proxies.md)。守る不変条件は [sandbox-and-security.md](sandbox-and-security.md) の 7.1 節。

### 10.1 構成

```
ランタイムのプロセス（網なし）
  │ 受け継いだ Unix ドメインソケット（プロセスごとに 1 本。スーパーバイザーが作る）
  │ 内部の要求の形：HTTP/2 の上に、:authority・:path と内部のヘッダー
  │   <Brand>-Internal-Invocation: <呼び出しの ID>（ランタイムが付ける）
  ▼
外向きのプロキシ（Rust、Pingora。ノードに 1 つ、専用の Linux の利用者）
  1. ソケット → どのプロセスか（スーパーバイザーが登録）
  2. 呼び出しの ID が、そのプロセスで進行中の呼び出しか（スーパーバイザーの表）。違えば拒否
  3. 呼び出しの ID → (account_id, script_id, version_id, 制限) を引く
  4. 数の強制：サブリクエストの数、同時の接続の数（応答の頭を待つもの）
  5. 宛先が自分たちのホスト名か（host/）→ 内部の経路（8.3 節）
  6. 名前の解決（専用の再帰のリゾルバー）→ 全アドレスを拒否の一覧で検査 → 通ったアドレスにだけ接続
  7. TLS の検証（Mozilla の信頼の根の一覧）→ 送信
  8. リダイレクトは、ランタイムが次の要求として送る（プロキシは追わない）。毎回 6 の検査を受ける
```

- **呼び出しの ID の限界**：1 つのプロセスの中の isolate が乗っ取られると、同じプロセスの別の呼び出しの ID を使える。これは同じ cordon の中の話で、同じプロセスのメモリに届く攻撃者はすでにその情報を持つ。プロセスの外（他の cordon）の呼び出しの ID は、ソケットが違うので使えない。この境界を明記し、cordon（ADR-0011）で被害の範囲を限る。
- **バインディングの呼び出し**（KV など）は、同じソケットの別の `:authority`（`binding.internal`）で受け、呼び出しの ID から許されたバインディングだけを通す。バインディングの先のサービスの形は各ストレージの領域で決める。

### 10.2 名前の解決

- リージョンごとに、専用の再帰のリゾルバー（Unbound を 2 台以上。エッジの VPC の中で、私的なホストゾーンに結び付けない）を置く。**VPC の既定のリゾルバー（`169.254.169.253`）を使わない。** 私的なホストゾーンの名前（内部のサービスの名前）を、利用者のコードに解決させないため。
- 外向きのプロキシは、解決の結果を TTL に従って持つ（下限 5 秒、上限 300 秒）。否定の応答は 30 秒。
- 解決の結果に、拒否の範囲のアドレスが 1 つでもあれば、その名前への接続をすべて拒否する（混ぜた応答で内部へ誘う手口を防ぐ）。
- 拒否の範囲の一覧は、設定の写しの `egress_policy` で配る。自分たちの anycast の IP（`ga-primary`・`ga-standby` の 4＋4）と、各リージョンの NLB の IP、ノードの公開の IPv4（外向きの送信元。[ADR-0049](../decisions/0049-aws-accounts-and-network.md)）を必ず含める。

### 10.3 接続

- **接続のプールは `(account_id, scheme, host, port, 接続したIP)` ごと。** テナントの間で接続を共有しない。オリジンの側での接続ごとの状態（接続ごとのレート制限、HTTP/2 の設定）や、TLS のセッションの再開を、別のテナントと混ぜないため。代わりに接続の数が増える（capacity で見積もる）。
- 外への送信元の IP は、**ノードの公開の IPv4** にする（NAT ゲートウェイを通さない。外向きのプロキシのプロセスだけがその IP で外へ出る。[ADR-0049](../decisions/0049-aws-accounts-and-network.md)）。IP はノードの入れ替えで変わり、一覧は公開しない（S1）。不正な利用の通報で送信元を特定できるよう、送信元の IP（`egress_ip`）と時刻と `<Brand>-Ray` を結び付けて記録し、`node_public_ips` でノードを引く（[ADR-0044](../decisions/0044-egress-abuse-controls.md) の注記）。
- すべてのサブリクエストに `<Brand>-Worker: <送り元の関数のホスト名>` を付ける（利用者は消せない）。受け手が送り元を知り、不正な利用を通報できるようにする。本家の `CF-Worker` は、`fetch()` のすべてのサブリクエストに付き、値は関数を持つ**ゾーンの名前**（[Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)、2026-09-27 に確認）。この基盤は DNS のゾーンを持たないので、関数のホスト名にする（既定のサブドメインでは `<worker>.<account>.<brand>.<domain>`）。
- タイムアウト：接続 10 秒、TLS の握手 10 秒、応答の頭 100 秒（既定案）。本家は個々のサブリクエストの時間の上限を置かず、利用者が接続している間は続ける（[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)、2026-09-27 に確認）。この基盤は接続のプールを守るため、応答の頭までに上限を置く（本家との差として文書に書く）。本文の読み込みの時間は制限しない（利用者の切断で中止）。
- 外向きの宛先のポート（cordon ごと。[ADR-0044](../decisions/0044-egress-abuse-controls.md)）：`c0-untrusted` は 80・443、`c1-free` は 80・443・8080・8443、`c2-paid`・`c3-dedicated` は 80・443 と 1024〜65535（`fetch` の URL の任意のポート）。25 番（SMTP）は全 cordon で拒否。アカウントごとの上書きは `account_egress/` の器（[abuse-and-trust-safety.md](abuse-and-trust-safety.md) の 7.1 節）。

### 10.4 入口のプロキシ

- 同じく Pingora の上に作る。TLS は BoringSSL（workerd と同じ系統）。証明書の選択は、BoringSSL の証明書の選択のコールバックで、7.5 節の表から引く。
- 無停止の再読み込み（Pingora の機能）で、入口のプロキシの更新で接続を切らない。
- 上限（S1。本家に合わせる）：URL 16KB、要求のヘッダー 128KB、応答のヘッダー 128KB、要求の本文 100MB（有料でも同じ。値は limits-and-billing で確定）。超えたら 414・431・413。
- HTTP の解析はファズの対象にする（[AGENTS.md](../../AGENTS.md)）。

## 11. 遅延の率直な比較

新しい接続での最初の応答までの時間（TTFB。関数の処理の時間を除く）を、往復の数で比べる。TLS 1.3、0-RTT なし。

- 本家：TCP・TLS・HTTP の 3 往復を、最寄りの PoP（往復 `r_pop`）と行う。`TTFB ≈ 3 × r_pop`。
- S1：TCP は GA の edge（往復 `r_edge`）で終わる。TLS と HTTP は、edge からリージョンのノードまで（片道の和の往復 `r_edge + r_bb`）行く。`TTFB ≈ 3 × r_edge + 2 × r_bb`。
- 接続を使い回すとき：本家 `r_pop`、S1 `r_edge + r_bb`。

| 利用者の場所 | S1 の最寄りのリージョン | `r_bb`（edge → リージョン）の見込み | S1 の TTFB の見込み | 本家の TTFB の見込み（`r_pop` 5〜10ms） |
| --- | --- | --- | --- | --- |
| 東京・大阪 | 東京・大阪 | 1〜5ms | 20〜35ms | 15〜30ms |
| 札幌・福岡・那覇 | 東京・大阪 | 10〜30ms | 40〜90ms | 15〜30ms（国内の他の都市の PoP） |
| ソウル・台北 | 東京・大阪 | 20〜40ms | 55〜95ms | 15〜30ms |
| シンガポール・ジャカルタ | シンガポール | 1〜20ms | 20〜70ms | 15〜30ms |
| シドニー | シンガポール | 90〜100ms | 200〜230ms | 15〜30ms |
| ムンバイ | シンガポール | 55〜65ms | 125〜160ms | 15〜30ms |
| 米国の西海岸 | オレゴン | 5〜25ms | 25〜80ms | 15〜30ms |
| 米国の東海岸 | オレゴン | 60〜75ms | 135〜180ms | 15〜30ms |
| 欧州 | フランクフルト | 5〜30ms | 25〜90ms | 15〜30ms |
| サンパウロ | オレゴン（またはフランクフルト） | 170〜200ms | 355〜430ms | 15〜30ms |
| ヨハネスブルグ・ドバイ | フランクフルト | 110〜170ms | 235〜370ms | 15〜30ms |

- **この表の値はすべて未検証の見積もり**（地理と一般的な海底ケーブルの経路からの概算）。E4 の `isp-vantage-probes` で、各地の合成監視から実測して置き換え、公開する（NFR-003）。
- 読み取れること：
  - 国内の主要都市は、本家に近い（K3 の TTFB p50 30ms は東京・大阪の周辺で満たせる見込み）。地方は、往復 2 回分の `r_bb` が効いて本家より遅い。
  - 海外の S1 の 5 リージョンから遠い地域（南米、アフリカ、中東、オセアニア）は、本家の 10 倍以上になりうる。
  - GA は TCP の握手を edge で済ませるので、DNS で直接リージョンへ向ける方式（ADR-0003 の案 3）より 1 往復分（`r_bb`）速い。
  - 接続を使い回す利用者（ブラウザの HTTP/2）では差は `r_bb` の 1 回分に縮む。
- 本家との差を縮める手段は、リージョンを増やす（S2 の 12〜15）ことと、S3 の自前の PoP だけ。0-RTT は再送の危険があるので使わない（7.6 節）。

## 12. 障害の型

| 障害 | 検知 | 振る舞い |
| --- | --- | --- |
| 1 つのノードが落ちた | NLB の健全性の検査（20 秒） | NLB が外す。ランデブーの一覧から 3 秒で外れ、そのノードがホームだった鍵は別のノードで冷たく起動する |
| 1 つのリージョンの全体の障害 | NLB の全ターゲットの不健全、合成監視 | GA が新しい接続を近いリージョンへ。既存の接続は切れる（ノードがないので）。国内は東京 ↔ 大阪 |
| リージョンの灰色の障害（一部の関数だけ失敗、遅い） | 合成監視、5xx の率 | 自動では迂回しない。当番が `drain` で退かせる（runbooks） |
| GA のアクセラレーター自体の障害 | 外からの合成監視（GA の IP へ直接） | `edge.<brand>.<domain>` を `ga-standby` へ書き換える。apex を A で向けた利用者は戻るまで届かない |
| GA の API（us-west-2）の障害 | API の失敗 | ダイヤルは変えられない。退かせる操作は `drain` の印で行う |
| Route 53 の障害 | 外からの DNS の監視 | 既定のドメインの解決は Route 53 のデータプレーンに頼る。DNS の TTL（3600・300 秒）の間は、キャッシュで届く |
| 証明書の更新の失敗 | 期限の 14 日前に未更新、ARI の窓を過ぎた | 予備の発行局で発行。7 日前に当番を呼ぶ。期限が切れたホスト名は、TLS のアラートで閉じる（期限切れの証明書を出さない） |
| 利用者の向き先の外れ | 24 時間ごとの確認 | 7 日で警告、30 日で `suspended`（6.2 節） |
| ACME の検証が一部のリージョンで失敗（トークンが届いていない） | 検証の失敗の理由 | 全リージョンの適用の待ちを延ばし、1 時間後に再試行。認可の失敗の上限（5／時）を超えない |
| KMS に届かない | RDK の開き直しの失敗 | 動いているノードは続ける。新しいノードは健全にならない（7.4 節） |
| 外向きのプロキシが止まった | スーパーバイザーの健全性 | 閉じる。ノードを 503 にし、NLB から外す（ADR-0010） |
| 専用の再帰のリゾルバーの障害 | 外向きのプロキシの解決の失敗の率 | リージョンの他のリゾルバーへ。すべて落ちたら、別のリージョンのリゾルバーへ（遅いが、VPC の既定のリゾルバーは使わない） |
| ホームのノードが遅い・断る | 転送の遅延、断りの率 | 受けたノードで動かす。断りの率が 20% を超えたら、そのリージョンの台数を増やす警報 |
| 内部の経路のループ | `<Brand>-Loop` の深さ | 508 で止める |
| SNI と Host の食い違い | 入口の解析 | 421 |

## 13. セキュリティ

| 脅威 | 対策 |
| --- | --- |
| 他のテナントのホスト名の乗っ取り（dangling CNAME） | ドメインの所有を TXT で先に確かめる。DNS が向いているだけでは結び付けない（6.2 節）。削除した既定のサブドメインは 90 日渡さない |
| 既定のドメインの Cookie の共有 | PSL に載せる。ダッシュボードと別の登録ドメイン（6.1 節） |
| TLS の秘密鍵の漏れ | 鍵は RDK で包んで配る。平文はノードの入口のプロキシのメモリだけ。ランタイム・外向きのプロキシは読めない（7.4 節） |
| 不正な証明書の発行 | CAA の `accounturi` で、自分たちの ACME のアカウントに限る |
| 別のテナントのホスト名を、自分の TLS の接続で要求する | SNI と Host・`:authority` の食い違いを 421 にする（7.5 節） |
| `<Brand>-*`・内部のヘッダーの偽装 | 入口で消す。内部の転送は別のポートと mTLS（8.4 節） |
| SSRF（内部・IMDS・自分たちの IP への接続） | 外向きのプロキシの、名前の解決の後の検査。VPC の既定のリゾルバーを使わない（10 節）。オリジンへの転送も同じ検査 |
| 外向きの接続での、テナントの間の混線 | アカウントごとの接続のプール（10.3 節） |
| 中間者による ACME の検証の乗っ取り | 発行局の複数の地点の検証。自分たちの側では、トークンを持つのは自分たちが注文したホスト名だけ |
| 0-RTT の再送 | 受けない |
| 入口の HTTP の解析の欠陥 | Pingora の上で、自分たちの足した解析をファズの対象にする |

- この領域の変更（入口・外向きのプロキシ、証明書、拒否の一覧、内部の経路）は `security:sensitive` にする（[AGENTS.md](../../AGENTS.md)）。
- 通信の秘密：入口のプロキシのアクセスのログに、要求の本文と `Authorization`・`Cookie` のヘッダーを残さない。何を残すかは法務の確認（intent の L2）の後に observability の領域で決める。

## 14. テスト

| 種類 | 対象 | 内容 |
| --- | --- | --- |
| 表駆動 | `DT-ROUTE-001`・`DT-ROUTE-002` | 各行を 1 つ以上の要求で確かめる |
| 性質ベース | ルートの順位 | 任意のパターンの集合と URL で、(1) 結果は集合の並べ順によらない (2) 当たったパターンより具体的で、同じ URL に当たるパターンは集合にない (3) 関数のないルートが当たったら関数を動かさない |
| 性質ベース | ランデブーハッシュ | ノードを 1 台足す・抜くと、動く鍵は約 1/N で、抜けたノード以外の鍵は動かない |
| 性質ベース | ホスト名の所有 | 任意の 2 アカウントの登録と確認の列で、1 つのホスト名が同時に 2 つのアカウントで `active` にならない |
| 結合 | 利用者の IP | GA → NLB → ノードで `<Brand>-Connecting-IP` が利用者の IP（IPv4・IPv6） |
| 結合 | ACME | Pebble（ACME の試験用のサーバー）で HTTP-01・DNS-01・失敗・CAA の拒否。全リージョンの適用を待たずに検証を頼むと失敗すること（回帰） |
| 結合 | SNI | 未登録の SNI・SNI なしで `unrecognized_name`。SNI と Host の食い違いで 421 |
| 結合 | 外向きのプロキシ | 拒否の一覧の全範囲、IPv6 の IMDS、DNS の再束縛、混ぜた応答、私的な IP へのリダイレクト、自分たちの anycast の IP、オリジンに私的な IP、`<Brand>-Worker` を消せないこと |
| 結合 | ヘッダーの偽装 | 利用者が `<Brand>-*`・`<Brand>-Internal-*` を送っても上書きされる |
| ファズ | 入口の HTTP の解析、ルートのパターンの解析、内部の転送の形 | cargo-fuzz |
| 障害の注入 | リージョンの退かせ方 | `drain` から新しい接続の迂回までの時間と、失敗した要求の割合（四半期。ADR-0003 の Confirmation） |
| 障害の注入 | 予備のアクセラレーター | `edge` の書き換えで、既定のドメインが予備で応答する（半期） |
| 本番の探り | 合成監視 | 各地から最小の関数の TTFB と TLS の握手（11 節の表の実測） |

テスト名には要件 ID（開発リポジトリの `REQ-EDGE-*`・`PROP-EDGE-*`）を含める。

## 15. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0017](../decisions/0017-global-accelerator-and-regional-nlb.md) | デュアルスタックの標準のアクセラレーター（本番と予備）、1 つのリスナー（TCP 80・443）、リージョンごとの TCP の NLB（利用者の IP を保つ、ゾーンをまたがない）。アフィニティは None。リージョンの退かせ方は健全性の検査で行い、ダイヤルは計画の作業だけ。カスタムルーティングと HTTP/3 は S1 で使わない |
| [0018](../decisions/0018-acme-certificates-and-sni.md) | 証明書は ACME で自前で発行（Let's Encrypt を主、ZeroSSL を予備）。既定のドメインはアカウントごとのワイルドカードを DNS-01、カスタムホスト名は TXT の確認の後に HTTP-01（DNS-01 の委任も可）。全リージョンの適用を待ってから検証を頼む。ARI で更新。鍵はリージョンのデータ鍵で包んで配る。既定のドメインは PSL に載せる |
| [0019](../decisions/0019-route-matching-and-home-node-forwarding.md) | ホスト名の表と、`*example.jp` を除いた本家の文法のルート。順位を決定表で固定する。どのルートにも当たらない要求はオリジンへ。自分のホスト名への `fetch` は内部の経路。リージョンの中はランデブーハッシュでホームのノードへ 1 回だけ転送する |
| [0020](../decisions/0020-pingora-ingress-and-egress-proxies.md) | 入口と外向きのプロキシは Pingora の上に Rust で別々のプロセスとして作る。外向きは呼び出しの ID の検査、専用の再帰のリゾルバー、名前の解決の後の検査と固定、アカウントごとの接続のプール、`<Brand>-Worker` のヘッダー |

## 16. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | 既定のドメインの登録ドメインの取得、Route 53 のゾーン、CAA、PSL への申請（早めに出す） |
| E1 | 各リージョンの VPC・NLB・セキュリティグループ（infrastructure と合わせて） |
| E1 | Let's Encrypt の「登録ドメインあたり」の上限の引き上げの申請、ZeroSSL の EAB |
| E4 | 確認：GA → NLB → インスタンスで利用者の IPv4・IPv6 が保たれるか（着手の最初） |
| E4 | アクセラレーター（本番と予備）、リスナー、エンドポイントグループ、`edge` のレコード（Terraform） |
| E4 | 入口のプロキシ（Pingora）：TLS の終端、SNI での証明書の選択、ヘッダーの削除と付与、上限 |
| E4 | ルートの解決（ホスト名の表、パターンの解析と検証、`DT-ROUTE-001`） |
| E4 | ランデブーハッシュとホームのノードへの転送、断り、内部のポートの mTLS |
| E4 | ノードの一覧（中継の心拍）の配信 |
| E4 | `/healthz` の条件と、ノードの退避の手順 |
| E4 | `drain` の印とリージョンの退かせ方、同時に 2 リージョンまでの制限 |
| E4 | cert-manager：ACME の注文、DNS-01（Route 53）、HTTP-01（全リージョンの適用の待ち）、ARI、予備の発行局 |
| E4 | 鍵の包みと RDK、KMS の暗号化の文脈、ノードの RDK の開き方 |
| E4 | カスタムドメイン：所有の確認、ホスト名の状態機械、定期の再確認 |
| E4 | オリジンへの転送と `DT-ROUTE-002`（内部の経路、`<Brand>-Loop`） |
| E4 | 外向きのプロキシ（Pingora）：呼び出しの ID の検査、数の強制、専用の再帰のリゾルバー、拒否の一覧、アカウントごとの接続のプール（sandbox-and-security と合わせて） |
| E4 | 合成監視：各地からの TTFB の実測と、11 節の表の置き換え |
| E5 | 証明書・ルート・ホスト名の変更を、優先の印で配る器（deployment-and-config-distribution と合わせて） |
| E6 | CLI とダッシュボードでのルート・カスタムドメインの設定と、向き先の案内 |
| E11 | GA のデータの転送の費用を、使用量の集計に入れる（capacity・limits-and-billing と合わせて） |
| E12 | 既定のサブドメインの停止（不正な内容）、`<Brand>-Worker` での通報の受け付け（abuse-and-trust-safety と合わせて） |

## 17. 未解決の問い

- 利用者の IP が、GA → NLB（デュアルスタック、IP を保つ）→ インスタンスのターゲットで、IPv6 を含めて保たれるか。
- GA がエンドポイントの不健全を検知してから新しい接続を迂回させるまでの実際の時間。
- 既定のドメインの PSL への掲載にかかる期間と、Let's Encrypt の上限の引き上げが通るか。
- 11 節の遅延の実測。とくに国内の地方と、ソウル・台北。
- HTTP/3 を、NLB と GA の UDP でいつ、どう持つか。
- RSA の証明書を併せて持つ必要があるか（古い端末の割合）。
- S3 の 100 万アカウントで、既定のドメインの DNS を Route 53 のレコードで持ち続けるか、名前を合成する自前の権威 DNS にするか。
- ホームのノードへの転送を、同じ AZ に限るか（AZ の間の費用と、温かさの釣り合い）。
- 東京と大阪を同時に退かせたとき、国内の要求を海外で処理してよいか（intent の L3）。
- 外への送信元の IP の一覧を公開するか（利用者のオリジンの許可の一覧のため。公開すると悪用の相手にも知られる）。

### 決定

2026-09-27 の既定案。

- 利用者の IP の保持は E4 の最初に確かめる。IPv6 で保たれなければ、S1 は IPv4 だけのアクセラレーターで始め、IPv6 は S2 で新しいアクセラレーターを作って移る（ADR-0017 を改訂する）。
- 迂回の時間は四半期の訓練で計測し、NFR-010 の RTO 5 分に収まることを確かめる。
- PSL と上限の引き上げは E1 で申請する。どちらも間に合わない間は、ZeroSSL で既定のサブドメインの発行を補う。
- 遅延の表は E4 の実測で置き換え、利用者向けに公開する。
- HTTP/3 は S2 の前に PoC で決める。S1 は持たない。
- S1 は ECDSA だけ。TLS の握手の失敗の率を見て、S2 の前に RSA を足すかを決める。
- S1・S2 は Route 53 のレコード。S3 の前に自前の権威 DNS を検討する（infrastructure の領域）。
- ホームのノードはリージョン全体のランデブーで始める。AZ の間の転送の費用が K8 を崩すなら、同じ AZ を先にする。
- 国内の 2 リージョンを同時に退かせる操作は、2 人の承認を要る形にする。海外へ迂回しない約束は、法務の確認（L3）の後に決める。
- 送信元の IP の一覧は S1 で公開しない。利用者の要望を見て S2 で決める。

## 18. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：ホスト名の乗っ取り（dangling CNAME、確認の抜け）。ホスト名の所有の性質ベーステストと、定期の再確認の結合テスト。
- リスク：証明書の期限切れ。期限の監視（14 日前・7 日前）と、予備の発行局の四半期の訓練。
- リスク：ルートの順位の誤り（別の関数が動く）。`DT-ROUTE-001` の表駆動と、順位の性質ベーステスト。
- リスク：SSRF（外向きのプロキシ・オリジンへの転送の抜け）。拒否の一覧の結合テストと本番の探り。
- リスク：迂回の遅さと fail open。四半期のリージョンの退かせ方の訓練。
- 本番での検証：各地の合成監視（TTFB、TLS の握手）、証明書の残りの日数の最小値、ホームのノードの断りの率。

**runbooks**

- `region-drain`：`drain` の印の配り方（制御プレーンが止まっているときの中継への直接の書き込みを含む）、同時に 2 リージョンまで、戻し方。
- `accelerator-failover`：`edge.<brand>.<domain>` の予備への切り替えと戻し。apex の利用者への連絡。
- `cert-renewal-failure`：更新の失敗の切り分け（向き先、CAA、発行局の停止、上限）、予備の発行局への切り替え。
- `acme-rate-limit`：上限に当たったときの対応（引き上げの申請、予備の発行局）。
- `hostname-takeover-report`：他のテナントにホスト名を奪われたという申し出の調査と、`suspended` への移し方。
- `egress-resolver-down`：専用の再帰のリゾルバーの障害。
- SLI の追加の依頼（Ops へ）：各地の TTFB（p50・p99）、TLS の握手の失敗の率（理由ごと）、証明書の残りの日数の最小値、ACME の発行の失敗の率、ホームのノードへの転送の率と断りの率、`421`・`508` の数、外向きの拒否の数（セキュリティの担当だけ）。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `account_subdomains`（制御プレーン） | `account_id`、`subdomain`、`status`（`active`・`released`）、`released_at` | RLS。`subdomain` は全体で一意。解放から 90 日は再利用しない |
| `domains`（制御プレーン） | `account_id`、`id`、`name`（Punycode）、`status`（`pending_verification`・`verified`・`failed`・`suspended`・`deleting`）、`txt_token_hash`、`verified_at`、`last_checked_at`、`txt_missing_since` | RLS。`verified` の `name` は全体で一意 |
| `hostnames`（制御プレーン） | `account_id`、`id`、`hostname`、`domain_id`、`kind`（`custom`・`wildcard`）、`status`（6.2 節）、`status_reason`、`cname_target`、`default_script_id`、`origin_url`、`http_policy`、`dns01_delegated`、`created_at` | RLS。`active`・`issuing`・`suspended` の `hostname` は全体で一意 |
| `routes`（制御プレーン） | `account_id`、`id`、`hostname_id`、`pattern`、`scheme`、`path`、`path_wildcard`、`host_wildcard`、`script_id`（NULL は打ち消し）、`created_at` | RLS。1 ホスト名 1,000 まで |
| `certificates`（制御プレーン） | `id`、`account_id`、`subject`（`*.<account>…` またはホスト名）、`issuer`（`letsencrypt`・`zerossl`）、`key_type`、`not_before`、`not_after`、`ari_window_start`、`ari_window_end`、`chain_pem`、`wrapped_keys`（リージョン → 包み）、`status`（`active`・`renewing`・`expired`・`revoked`） | RLS（`account_id`）。鍵の平文を持たない |
| `acme_orders`（制御プレーン） | `id`、`certificate_id`、`ca`、`order_url`、`challenge_type`、`status`、`failure_count`、`last_error`、`created_at` | 認可の失敗の上限の管理 |
| `acme_challenges`（設定の写しの器） | `hostname`、`token`、`key_authorization`、`expires_at` | 発行の間だけ。配信は優先の印 |
| `region_keys`（`purpose = edge-tls`） | [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 16 節の表 | RDK。KMS で包んだ形だけを持ち、`region_key/` の器で配る |
| `region_flags`（設定の写しの器） | `region`、`drain`、`set_by`、`set_at`、`reason` | 同時に 2 リージョンまで |
| `egress_policy`（設定の写しの器） | `version`、`deny_cidrs`、`own_anycast_ips`、`blocked_ports` | 正本は開発リポジトリのファイル。セキュリティの担当が承認 |
| ノードの LMDB の器 | `host/`、`routes/`、`routes_wild/`、`certs_by_host/`、`acme/`、`region_key/`、`region_flags/`、`egress_policy/`、`region_members/`（リージョンの中だけ） | 形は [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 6.3 節 |
