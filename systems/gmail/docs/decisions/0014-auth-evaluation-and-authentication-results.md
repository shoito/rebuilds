---
status: accepted
date: 2026-10-10
---

# ADR-0014: SPF は MAIL FROM で非同期に始め、DKIM・ARC・DMARC は DATA の終わりに評価する。SPF の照会 10 回・void 2 回、DKIM の署名 5 つ、ARC の連鎖 50 を上限にし、DNS の一時の失敗は temperror で拒否にしない。結果は前置きの Authentication-Results に書き、blob の中の偽の結果は選別の点にする

詳細は [sender-authentication.md](../architecture/sender-authentication.md) の 4・5 節。

## Context

- 認証の評価は DATA の終わりの同期の検査（予算 10 秒）の中で行い、DMARC の `p=reject` の失敗だけを SMTP の時点で拒む（[ADR-0002](0002-accept-then-filter.md)）。NFR-003 は 1 MiB まで p99 2 秒を求める。
- SPF・DKIM・DMARC・ARC は DNS を多く引く。攻撃者は DNS の照会を増やす記録（`include` の連鎖、多くの署名、長い ARC の連鎖）で、受け手の資源を使わせられる。
- DNS の一時の失敗で正規のメールを拒むと、NFR-009 に反する（[quality.md](../quality.md) の 2.2.1 節 C）。
- RFC 8601 の 5 節は、受け手が自分の authserv-id を名乗る外からの `Authentication-Results` を消すか名前を変えることを求める。一方、本システムは受け取ったバイトを変えない（[ADR-0003](0003-message-storage-layout-and-dedupe.md)）。

## Options

1. **SPF は MAIL FROM で始め、他は DATA の終わり。上限を決め、`temperror` で拒まない。結果は前置きに書き、blob は変えない**
2. すべてを DATA の終わりに順に評価する
3. 受け付けた後に評価する（SMTP の時点では評価しない）
4. blob の中の偽の `Authentication-Results` を、保存の前に書き換える

## Decision

1 を採用する。

- SPF は MAIL FROM を受けたら非同期に始め、HELO の SPF も並べて評価する。DATA の終わりで結果を待つ。
- DKIM の本文のハッシュは DATA を受けながら `simple`・`relaxed` の 2 つで計算する。検証する署名は 5 つまで（From に揃うものを先に）。
- 上限：SPF の DNS を引く項 10 回・void 2 回・`mx`/`ptr` の名前 10・全体 8 秒、1 つの照会 2 秒と再試行 1 回、ARC の連鎖 50。
- `rsa-sha1` と 1024 ビット未満の RSA は通さない（RFC 8301）。`l=` の署名で本文が長いものは DKIM の `pass` だが DMARC の揃いに使わない。
- DNS の時間切れと SERVFAIL は `temperror`。`temperror` は SMTP の時点の拒否の理由にしない。
- 結果は、受け手ごとの前置きの `Authentication-Results`（authserv-id `mx.<brand>.<domain>`）に書く。`smtp.mailfrom` はドメインだけ。
- blob の中の、本システムの authserv-id を名乗る外からの結果は消さない。Web とアプリは前置きだけを信じ、選別は `forged_authres` の点にする。IMAP で返すときの扱いは持ち越す。

### 他の案を選ばなかった理由

- **2**：SPF の照会の遅れが DATA の終わりの応答に足される。MAIL FROM から DATA の終わりまでの時間で、多くの SPF が終わる。
- **3**：`p=reject` を SMTP の時点で拒めず、受け付けた後に送り返すか捨てるかになる（[ADR-0002](0002-accept-then-filter.md)）。
- **4**：受け取ったバイトをそのまま返す決まり（DKIM の検証、転送、IMAP の `BODY[]`、eDiscovery）が崩れる。

## Consequences

- 良くなること：
  - DNS を使わせる攻撃と DNS の障害で、受信が止まらない、正規のメールを拒まない。
  - 受け取ったバイトを変えない決まりを守れる。
- 引き受けるコスト：
  - IMAP のクライアントは、blob の中の偽の結果を見うる（RFC 8601 の 5 節を満たしきれない）。持ち越しで決める。
  - 予算を超えた評価は「判定なし」になり、受け付けた後の選別が補う。

## Confirmation

- 性質ベーステスト：PROP-AUTH-001、PROP-AUTH-003。
- 試験のベクトルと相互の検証（[quality.md](../quality.md) の 2.2.1 節 C）。
- 監視：DNS の失敗の率、`temperror` の率、評価の p99。
