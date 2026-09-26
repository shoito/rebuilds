# Networking: Chrome

HTTP・TLS・DNS・キャッシュ・Cookie・CORS・プライバシーの制限を担う、Network サービスの設計。主な決定は [ADR-0015](../decisions/0015-tls-and-certificate-verification.md)（TLS と証明書の検証、部品）、[ADR-0016](../decisions/0016-third-party-cookies-blocked-by-default.md)（サードパーティ Cookie）、[ADR-0017](../decisions/0017-partitioning-by-top-level-site.md)（トップレベルのサイトによる分割）にある。保存領域（IndexedDB、Cache Storage、Service Worker）は [storage.md](storage.md) にある。

本家の設計に揃えられるところは揃え、[ADR-0005](../decisions/0005-privacy-first-services.md) のプライバシーを優先する方針と食い違うところ（サードパーティ Cookie の既定など）は、差分として明示する。

## 1. 位置づけと範囲

| 担う | 担わない（担う場所） |
| --- | --- |
| HTTP/1.1・HTTP/2・HTTP/3、WebSocket、WebTransport（MVP の後） | `file:`・`data:`・`blob:` の読み込み（Browser プロセス、[navigation-and-loading.md](navigation-and-loading.md)） |
| TLS、証明書の検証、HSTS、HTTPS への自動の切り替え | Service Worker による横取り（[storage.md](storage.md) の 7 節） |
| DNS（OS の解決と DoH）、プロキシ | Safe Browsing の判定（[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md)） |
| HTTP キャッシュ、Cookie の保存と送出 | ダウンロードの保存先の管理（Browser プロセス） |
| CORS、ORB、Private/Local Network Access の検査 | 権限の確認の UI（Browser プロセス） |

本家の Network サービスも、範囲を「ネットワークへの到達が要る最下層」に限り、`file:` や `data:`、Safe Browsing、Service Worker は外に置く（[services/network/README.md](https://chromium.googlesource.com/chromium/src/+/main/services/network/README.md)）。同じ切り方にする。

## 2. プロセスと信頼の境界

```
Browser プロセス ──(信頼する IPC)──▶ NetworkService（プロセスに 1 つ）
   │                                     └─ NetworkContext（プロファイルごと。シークレットは別）
   │  URLLoaderFactory を発行する              ├─ Cookie の保存、HTTP キャッシュ、HSTS
   │  （信頼するパラメータを焼き込む）          ├─ 接続のプール、DNS のキャッシュ
   ▼                                          └─ 証明書の検証
Renderer ──(URLLoaderFactory だけ)──▶ URLLoader（リクエスト 1 件）
```

- **Network サービスは、デスクトップでは独立したプロセスで動かす。** 本家もデスクトップでは専用の Utility プロセスで動かす（同 README）。落ちたら Browser が起動し直し、発行済みの URLLoaderFactory は切れるので、利用する側が張り直す。
- **Network サービスのプロセスも、サンドボックスに入れる。** ネットワークの入出力とプロファイルのネットワーク用ディレクトリ（[storage.md](storage.md) の 2 節の `Network/`）だけを許す。本家がどの OS でどこまで閉じているかは 未検証（2026-09-27 の検証では調べていない。E5 の `sandbox-windows` などで、Chromium の `sandbox/policy` の network の定義を読む）。方針は [sandbox-and-security.md](sandbox-and-security.md) に合わせる。
- **NetworkService と NetworkContext の IPC は、Browser だけが持つ。** Renderer には渡さない（本家と同じ）。
- **Renderer は、Browser が発行した URLLoaderFactory だけを持つ。** Browser はファクトリを作るときに、信頼するパラメータを焼き込む。Renderer がリクエストに書いた値では上書きできない（[ADR-0003](../decisions/0003-multi-process-site-isolation.md)）。

| 焼き込むパラメータ | 使い道 |
| --- | --- |
| `request_initiator_origin_lock` | そのプロセスに割り当てたオリジン。リクエストの `initiator` がこれと合わなければ拒否し、Renderer の侵害の疑いとして Browser に報告する |
| `isolation_info`（トップレベルのサイト、フレームのサイト、クロスサイトのビット） | Cookie・キャッシュ・接続の分割（5 節、[ADR-0017](../decisions/0017-partitioning-by-top-level-site.md)） |
| `client_security_state`（安全な文脈か、アドレスの空間） | Local Network Access（6.4 節） |
| COEP・Document のポリシー | CORP の検査 |
| `is_trusted` | Browser 自身が使うファクトリ（ナビゲーション、更新の確認）だけ真にする |

## 3. リクエストの流れ

```
URLLoader
 1. 検査：スキーム、ポートの禁止リスト、initiator の一致、Mixed Content
 2. HTTPS への切り替え：HSTS、HTTPS-First（6.1 節）
 3. CORS の preflight の要否 → 要れば OPTIONS を先に送る（preflight のキャッシュを引く）
 4. HTTP キャッシュを引く（キー：5.2 節）
 5. Cookie を付ける（7 節の規則で、分割したジャーから）
 6. トランザクション：プロキシの解決 → DNS → 接続のプール → H1/H2/H3
 7. 応答：Set-Cookie の保存、キャッシュへの書き込み、HSTS・Alt-Svc の記録
 8. 検査：CORS、ORB、CORP、Local Network Access、X-Content-Type-Options
 9. Renderer へ流す（ヘッダーは検査後の必要なものだけ。本体は共有メモリのパイプ）
```

- **CORS は Network サービスで強制する。** Renderer が侵害されても、クロスオリジンの応答の本体とヘッダーが Renderer に渡らないようにするため。本家も CORS を Network サービスの中（OOR-CORS）で行う。検査は [Fetch Standard](https://fetch.spec.whatwg.org/) の CORS check・CORS-preflight fetch に従う。
- **ORB（Opaque Response Blocking）を最初から入れる。** `no-cors` のクロスオリジンの応答（`<img>`・`<script>` など）のうち、HTML・JSON・XML と判定したものを、Renderer に渡す前にネットワークのエラーにする。本家は CORB から ORB へ段階的に移り、v0.1 を Chrome 103 で出した（[chromestatus](https://chromestatus.com/feature/4933785622675456)）。判定の規則は [ORB の仕様案](https://github.com/annevk/orb) に従う。
- 応答の本体は、Renderer のプロセスに割り当てたサイトで検査した後に渡す（Spectre の対策。[process-model.md](process-model.md)）。

## 4. プロトコルと接続

### 4.1 部品

[ADR-0015](../decisions/0015-tls-and-certificate-verification.md) で決める。要点だけ示す。

| 層 | 部品 | 自作する部分 |
| --- | --- | --- |
| HTTP/1.1・HTTP/2 | `hyper` 1.x の低レベルの client connection、`h2` | 接続のプール、優先度、キャッシュ、再試行 |
| QUIC・HTTP/3 | `quinn`（QUIC）、`h3` | 0-RTT の可否、QUIC の無効化・失敗時の TCP への戻し |
| TLS | `rustls`（暗号は `aws-lc-rs`） | 証明書の検証、セッションの再開の分割 |
| DNS | `hickory-proto`（メッセージの符号化） | スタブのリゾルバ、DoH の送出（自前の HTTP のスタックで送る）、キャッシュ |

`hyper-util` の汎用の接続プールは使わない。プールのキーに分割のキー（5 節）とプロキシ・特権の情報を入れる必要があり、本家の socket pool と同じ上限（下表）で管理したいため。

### 4.2 接続のプール

| 項目 | 値 | 本家との関係 |
| --- | --- | --- |
| プールのキー | 宛先（スキーム・ホスト・ポート）、プロキシの連鎖、プライバシーのモード（Cookie を送るか）、NetworkAnonymizationKey（5.1 節）、安全な DNS の方針 | 本家の `ClientSocketPool::GroupId` と同じ考え方 |
| HTTP/1.1 の同時接続 | 宛先ごとに 6、プール全体で 256 | 本家の既定と同じ（宛先ごとに 6、WebSocket は 255。256 はプールごとの soft limit。[client_socket_pool_manager.cc](https://source.chromium.org/chromium/chromium/src/+/main:net/socket/client_socket_pool_manager.cc)、2026-09-27 に確認） |
| HTTP/2・HTTP/3 のセッション | 宛先ごとに 1 本を共有する。証明書が別名を覆い、IP が一致すれば、別のホストでも共有する（connection coalescing） | 同じ |
| 待機中の接続の破棄 | 使われない接続は数分で閉じる。ネットワークの変化（Wi-Fi の切り替え）で全接続を捨てる | 同じ |

### 4.3 HTTP/3 と QUIC

- `Alt-Svc` と DNS の HTTPS レコード（SVCB）で HTTP/3 を知る。知った宛先には、QUIC と TCP を競わせ、先につながった方を使う。
- QUIC が失敗した宛先は、しばらく（ネットワークが変わるまで）TCP だけを使う。
- 0-RTT は、冪等なリクエスト（GET・HEAD）だけに使う。
- 準拠する仕様は [RFC 9000](https://www.rfc-editor.org/rfc/rfc9000)（QUIC）、[RFC 9001](https://www.rfc-editor.org/rfc/rfc9001)（QUIC の TLS）、[RFC 9114](https://www.rfc-editor.org/rfc/rfc9114)（HTTP/3）、[RFC 9204](https://www.rfc-editor.org/rfc/rfc9204)（QPACK）。HTTP/2 は [RFC 9113](https://www.rfc-editor.org/rfc/rfc9113)。
- 企業のポリシー `QuicAllowed` 相当で無効にできる（10 節）。

### 4.4 Happy Eyeballs

- DNS は A と AAAA（と HTTPS レコード）を並行して引く。
- IPv6 を先に試し、300 ms で応答がなければ IPv4 を並行して始める（[RFC 8305](https://www.rfc-editor.org/rfc/rfc8305) の考え方）。本家も 300 ms（`kIPv6FallbackTime`。[tcp_connect_job.h](https://source.chromium.org/chromium/chromium/src/+/main:net/socket/tcp_connect_job.h)、2026-09-27 に確認。RTT で変える機能は既定で無効）。

## 5. 分割（Network State Partitioning）

[ADR-0017](../decisions/0017-partitioning-by-top-level-site.md) で決める。本家に揃える。

### 5.1 接続・DNS・TLS の状態

- キーは **NetworkAnonymizationKey（トップレベルのサイト＋フレームがクロスサイトかのビット）**。本家の Network State Partitioning と同じ（[Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/Oj9cS6p40Ws)）。
- 分割するもの：接続（H1・H2・H3・WebSocket）、DNS のキャッシュ、ALPN・HTTP/2 の対応の記録、TLS・QUIC のセッションの再開の情報、Reporting・NEL の設定と送信。
- 分割しないもの：HSTS（セキュリティを弱めるため）。本家と同じく、サードパーティの文脈の応答からの HSTS の設定も受け付ける。本家が捨てるのは、証明書の誤りがある応答、IP アドレスのホスト、localhost だけである（[url_request_http_job.cc](https://source.chromium.org/chromium/chromium/src/+/main:net/url_request/url_request_http_job.cc) の `ProcessStrictTransportSecurityHeader()`、2026-09-27 に確認）。

### 5.2 HTTP キャッシュ

- キーは **NetworkIsolationKey（トップレベルのサイト、フレームのサイト）＋URL**。本家は Chrome 86 で分割した（[Gaining security and privacy by partitioning the cache](https://developer.chrome.com/blog/http-cache-partitioning)）。
- 本家は Chrome 135 で、クロスサイトから始まったトップレベルのナビゲーションの区別をキーに加えた（[top-level navigations](https://groups.google.com/a/chromium.org/g/blink-dev/c/ZpyP6jjCUJE)。[http_cache.cc](https://source.chromium.org/chromium/chromium/src/+/main:net/http/http_cache.cc) の `cn_` の接頭辞、2026-09-27 に確認）。フレームのサイトをクロスサイトのビットに替える案（[is-cross-site bit](https://groups.google.com/a/chromium.org/g/blink-dev/c/cG65eYPYf9w)）は実験だけで、既定にはなっていない（[network_isolation_key.h](https://source.chromium.org/chromium/chromium/src/+/main:net/base/network_isolation_key.h)、2026-09-27 に確認）。この設計は本家に揃え、（トップレベルのサイト、フレームのサイト）＋クロスサイトから始まったナビゲーションの区別＋URL を、最初から使う（後から入れるとキャッシュの形式が変わるため）。

### 5.3 HTTP キャッシュの実装

- ディスク上は、本体を 1 件 1 ファイル（名前はキーのハッシュ）、索引を SQLite に置く。本家の「simple cache」と同じく、ファイル単位にすることで、1 件の破損が全体に広がらないようにする。
- 容量はプロファイルごとに上限を設け（既定：空きディスクの一定割合、上限 1 GiB 程度から始めて計測で決める）、LRU で追い出す。
- 保存領域の割り当て（[storage.md](storage.md) の 4 節）とは別に数える。HTTP キャッシュは、ブラウザがいつでも捨ててよいデータである。
- シークレットは、メモリ上のキャッシュだけを使う（[storage.md](storage.md) の 10 節）。
- `Vary`、`Cache-Control`、条件付きのリクエスト、`stale-while-revalidate` は [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111) に従う。

## 6. TLS と証明書の検証

[ADR-0015](../decisions/0015-tls-and-certificate-verification.md) で決める。

### 6.1 TLS と HTTPS

- TLS 1.3 と 1.2 だけを使う（[RFC 8446](https://www.rfc-editor.org/rfc/rfc8446)）。1.0・1.1 は使わない（本家も Chrome 84 で外した）。
- 鍵の交換は X25519MLKEM768（量子計算機に耐えるハイブリッド）を最優先にする。本家は Chrome 131 で ML-KEM に移った。`rustls` は 0.23.27 から X25519MLKEM768 を既定で使う（[docs.rs/rustls](https://docs.rs/rustls/latest/rustls/)）。
- ECH（Encrypted Client Hello）は、DNS の HTTPS レコードに ECH の設定があれば使う。`rustls` のクライアントの ECH は対応済み。本家と同じく、DoH が有効なときに効果がある。
- HSTS の事前読み込みのリストは、本家の公開リスト（hstspreload.org）を取り込み、部品の更新（component の更新。[update-and-release.md](update-and-release.md)）で配る。
- **HTTPS-First を既定にする。** 本家は Chrome 154（2026 年 10 月）から「常に安全な接続を使用する」を既定にし、HTTPS に対応しない公開のサイトへの初回の訪問で確認を出す（[HTTPS by default](https://blog.google/security/https-by-defau/)）。同じ振る舞いにする。プライベートなアドレス・単一ラベルのホストには確認を出さない。

### 6.2 ルートストア

- **本家の Chrome Root Store の内容と制約（日付による不信任など）に揃えたリストを持ち、部品の更新で配る。** 自前の認証局の審査は行わない。本家のリストは Chromium のソースで公開されている（[Chrome Root Store FAQ](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md)）。本家が不信任を決めたら、同じ版で取り込む。
- OS に利用者・企業が追加したルート（Windows・macOS の証明書ストア、Linux の NSS DB）も信頼する。本家の Chrome Certificate Verifier も、Windows と macOS で OS に追加されたルートを認める（同 FAQ）。これらのルートには CT を求めない。
- 企業のポリシーで、追加のルート・不信任を配れる（10 節）。

### 6.3 検証と CT・失効

- 検証器は自作する（パスの構築、ルートストアの制約、名前の制約、有効期間）。証明書の解析と署名の検証は `rustls-webpki` と `aws-lc-rs` を使う。本家も OS の検証器をやめ、自前の検証器を Windows・macOS で Chrome 108、Linux で Chrome 114 から既定にした（同 FAQ）。
- **CT（Certificate Transparency）を強制する。** 公開のルートにつながる証明書は、本家の CT のポリシー（異なる運営者のログからの SCT）を満たさなければ拒否する。ログの一覧は部品の更新で配る。ログの一覧が古くなったら（70 日＝10 週）、本家と同じく CT の強制を止める（[Chrome CT Policy](https://googlechrome.github.io/CertificateTransparency/ct_policy.html)、[chrome_ct_policy_enforcer.cc](https://source.chromium.org/chromium/chromium/src/+/main:components/certificate_transparency/chrome_ct_policy_enforcer.cc) の `IsLogDataTimely()`、2026-09-27 に確認）。
- **失効は、オンラインで確かめない。** OCSP・CRL を取りに行かない（利用者の閲覧先を CA に知らせないため、遅くなるため）。本家の CRLSet と同じく、優先度の高い失効（CA の侵害、鍵の漏洩）を集めたリストを部品の更新で配る。本家の CRLSet は「失効した CA の証明書と、鍵の漏洩などで失効したサーバーの証明書」を対象にする（同 FAQ）。
  - 取り込み元は、本家の CRLSet の再配布か、CCADB の CRL から自前で作るかを決めていない（未解決事項）。CRLite の型（全件を圧縮したフィルタ）は、証明書の有効期間の短縮（CA/B Forum の SC-081：2029 年に 47 日）が進めば要らなくなるため、MVP では作らない。
- 検証の結果は、証明書・ホスト名・分割のキーごとに短時間キャッシュする。

### 6.4 Private Network Access / Local Network Access

- 公開のサイトから、ローカルのネットワーク（プライベートのアドレス）とループバックへのリクエストを、権限の確認の後にだけ許す。本家は Chrome 142 で Local Network Access の権限の確認を出した（[New permission prompt for Local Network Access](https://developer.chrome.com/blog/local-network-access)）。同じ振る舞いにする。
- アドレスの空間は、DNS の解決後の接続先の IP で判定する（DNS rebinding を防ぐため、接続ごとに検査する）。
- 権限の確認の UI は [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) にある。企業のポリシーで、許可するオリジンを配れる。

## 7. DNS と DoH

- **既定は、OS の DNS の設定を読み、その提供者が DoH に対応していれば DoH に切り替える（同じ提供者のまま自動で切り替える）。** 本家の既定の「自動」モードと同じ（[Chromium Blog](https://blog.chromium.org/2019/09/experimenting-with-same-provider-dns.html)、[DoH](https://www.chromium.org/developers/dns-over-https/)）。対応の一覧は部品の更新で配る。
- 利用者は、DoH の提供者を選ぶ・指定する・無効にすることができる（「セキュア DNS」の設定）。企業のポリシーで固定でき、ペアレンタルコントロールや企業のポリシーを検出したら、自動の切り替えを止める（本家と同じ）。
- DoH の問い合わせは、自前の HTTP のスタック（同じ TLS・証明書の検証）で送る。DoH のサーバーへの接続は、分割しない特別な NetworkAnonymizationKey を使う。
- DoH を使わないときは、自前のスタブのリゾルバで OS の設定のサーバーに UDP/TCP で問い合わせる。自前で読めない設定（VPN のスプリット DNS など）を検出したら、OS の解決（`getaddrinfo` など）に戻す。
- HTTPS レコード（SVCB）を引き、HTTP/3・ECH・HSTS 相当の情報に使う（[RFC 9460](https://www.rfc-editor.org/rfc/rfc9460)）。
- DNS のキャッシュは、分割のキー（5.1 節）ごとに持つ。

## 8. Cookie

### 8.1 既定の方針

[ADR-0016](../decisions/0016-third-party-cookies-blocked-by-default.md) で決める。**本家と異なり、サードパーティ Cookie を既定で送らない・保存しない。**

- 本家は 2025 年 4 月に、サードパーティ Cookie を既定で許したままにし、選択の確認も出さないと決めた（[Next steps for Privacy Sandbox and tracking protections in Chrome](https://privacysandbox.google.com/blog/privacy-sandbox-next-steps)）。本家のシークレットでは、既定で遮断する。
- この設計は、[ADR-0005](../decisions/0005-privacy-first-services.md) と intent の Non-goals（Privacy Sandbox を作らない）に従い、代わりの広告の API を用意せずに、通常のモードでも遮断する。Firefox・Safari の既定（分割・遮断）と同じ側に立つ。

| 文脈 | 既定 |
| --- | --- |
| ファーストパーティ（トップレベルと同じサイト） | 送る・保存する（SameSite の規則に従う） |
| サードパーティ、`Partitioned` 属性あり（CHIPS） | トップレベルのサイトで分割したジャーで送る・保存する |
| サードパーティ、`Partitioned` 属性なし | 送らない・保存しない |
| サードパーティ、Storage Access API で許可済み | 送る（許可はトップレベルのサイトと埋め込まれたサイトの組ごと） |
| サードパーティ、利用者・企業のポリシーで例外 | 送る |

- **CHIPS**：分割のキーはトップレベルのサイト（とクロスサイトの祖先のビット）。`Secure` を必須にする。本家は Chrome 114 から対応し、分割ごとに 180 個・埋め込まれたサイトごとに 10 KB を上限にする（[CHIPS](https://privacysandbox.google.com/3pcd/chips)）。同じ上限にする。
- **Storage Access API**：`document.requestStorageAccess()` で、利用者の操作の後に、埋め込まれたサイトが自分の分割されない Cookie を使える。許可は、操作のない 30 日で切れる（本家・Safari と同じ。Firefox は 30 暦日。[MDN の Storage Access API](https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API)、2026-09-27 に確認）。
- **ログインの互換性**：OAuth のポップアップなど、よく壊れる流れには、本家の 3PCD のヒューリスティクスと同じ一時的な許可を入れる。ポップアップで操作した後は 30 日、リダイレクトの後は 15 分（[Heuristics based exceptions](https://privacysandbox.google.com/cookies/temporary-exceptions/heuristics-based-exceptions)、2026-09-27 に確認）。本家も Firefox も、将来は外す一時的な措置としている。互換性を主要サイトの自動検査で追う（[build-and-test.md](build-and-test.md)）。

### 8.2 SameSite と属性

- `SameSite` の指定がない Cookie は `Lax` として扱う（本家は Chrome 80 から）。`SameSite=None` は `Secure` を必須にする。
- サイトの判定は「スキーム付きのサイト」（schemeful same-site）で行う。
- `__Host-`・`__Secure-` の接頭辞、Cookie の有効期限の上限（400 日）は本家と同じ。
- 公開の接尾辞のリスト（Public Suffix List）は部品の更新で配る。

### 8.3 保存と保護

- Cookie は、プロファイルの `Network/Cookies`（SQLite）に保存し、NetworkContext がメモリに全件を持つ。書き込みはまとめて遅延させる。
- Cookie の値は、OS の鍵（Keychain、DPAPI、Secret Service）で包んだ鍵で暗号化する。Windows では、本家の App-Bound Encryption（Chrome 127）と同じく、ブラウザの実行ファイルに結び付けた鍵を使い、同じ利用者の権限で動く他のプログラムから読みにくくする（本家は Chrome 127 から Windows の Cookie に入れ、ポリシー `ApplicationBoundEncryptionEnabled` で止められる。[Improving the security of Chrome cookies on Windows](https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html)、2026-09-27 に確認。同じ保護を自前で作る方法は 未検証で、E5 で確かめる）。
- Renderer は `document.cookie` を読むとき、Network サービスに問い合わせる。Network サービスは、ファクトリに焼き込んだオリジンと分割のキーの範囲の Cookie だけを返す（ADR-0003）。

## 9. プロキシ

- 既定は OS のプロキシの設定（WPAD・PAC を含む）に従う。PAC のスクリプトは、Utility プロセスのサンドボックスの中で、V8 で評価する（本家も PAC を別プロセスで評価する）。
- 対応する種類：HTTP、HTTPS（プロキシへの TLS）、SOCKS5。QUIC のプロキシ（MASQUE）は MVP の後。
- プロキシの認証は Basic・Digest・NTLM・Negotiate（Kerberos）。NTLM・Negotiate は OS の機能を使う。認証の資格情報は、プロファイルの中にだけ持つ。

## 10. 企業のポリシー（基本）

企業の管理者が、OS の仕組み（Windows のグループポリシー、macOS の構成プロファイル、Linux の JSON のファイル）でポリシーを配る。ポリシーの読み込みと優先順位は [browser-ui.md](browser-ui.md) に置き、ここではネットワークに関わるものだけを挙げる。名前は本家のポリシーと互換にし、移行を容易にする。

| 領域 | ポリシーの例（本家の名前） |
| --- | --- |
| DNS | `DnsOverHttpsMode`、`DnsOverHttpsTemplates` |
| プロキシ | `ProxySettings` |
| QUIC | `QuicAllowed` |
| 証明書 | 追加のルート、`CertificateTransparencyEnforcementDisabledForUrls` |
| Cookie | `BlockThirdPartyCookies`、`CookiesAllowedForUrls`、`CookiesBlockedForUrls` |
| Local Network Access | 許可するオリジンの一覧 |
| HTTPS | `HttpsOnlyMode`、`HttpAllowlist` |

ポリシーの名前と意味の対応は、実装するときに本家の [Chrome Enterprise のポリシーの一覧](https://chromeenterprise.google/policies/) で確かめる。

## 11. ネットワークのプライバシー

| 項目 | 方針 |
| --- | --- |
| Referrer | 既定のポリシーを `strict-origin-when-cross-origin` にする（本家は Chrome 85 から）。緩いポリシー（`no-referrer-when-downgrade` など）を明示されたら、クロスサイトでもそれに従う（本家と同じ。切り詰める案は取りやめた。[Cap page-scoped referrer policies](https://chromestatus.com/feature/5123843565813760)、2026-09-27 に確認）。長さは 4,096 文字まで |
| User-Agent | 本家の User-Agent の削減と同じく、OS の版・端末の型を固定の値にする。ブランドは自前の名前にする |
| Client Hints | 低エントロピーのもの（`Sec-CH-UA`、`Sec-CH-UA-Mobile`、`Sec-CH-UA-Platform`）だけを既定で送る。高エントロピーのもの（詳細な版、端末の型）は `Accept-CH` で要求された場合も、MVP では送らない。互換性の問題が出たら、ファーストパーティに限って送る |
| `Sec-Fetch-*` | 送る（Fetch Metadata。サーバー側の防御に使われる） |
| Global Privacy Control | `Sec-GPC` を設定で送れるようにする（既定は送らない。未解決事項） |
| ネットワークの予測 | DNS の先読み・接続の先読みは、分割のキーを付けて行う。検索の候補による先読みは、同じトップレベルのサイトの中に限る |

## 12. 観測

指標は [observability.md](observability.md) に集める。ネットワークに固有のもの：

- 接続の確立の時間（DNS・TCP/QUIC・TLS の内訳）、HTTP/3 の使用率と TCP への戻しの率
- 証明書の検証の失敗の種類（期限切れ、CT の不足、名前の不一致）の率
- キャッシュのヒット率（分割の前後の比較のため）
- 利用者が同意した場合だけ送る（ADR-0005）。URL・ホスト名は送らない。

## 13. リスクと未解決事項

- **サードパーティ Cookie の遮断による互換性**：SSO・埋め込みの決済・コメント欄で壊れる。Storage Access API、一時的な許可、例外の UI で補う。壊れたサイトの報告の経路を UI に置く。
- **`h3` の成熟度**：`h3` クレートは本番での実績が `hyper`・`quinn` より少ない。E4 で負荷と相互接続の試験を行い、足りなければ `quiche`（Cloudflare）に替える。
- **失効のリストの取り込み元**：本家の CRLSet を再配布してよいか（利用条件）、CCADB から自前で作るか。
- **PAC と WPAD の安全**：WPAD はネットワークの攻撃者にプロキシを差し込まれる経路になる。本家は OS のプロキシの設定に従い、OS で WPAD が有効なときだけ使う（[net/docs/proxy.md](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)、2026-09-27 に確認）。この設計も同じにし、ブラウザが独自に有効にしない（[README.md](README.md) の「決定」）。
