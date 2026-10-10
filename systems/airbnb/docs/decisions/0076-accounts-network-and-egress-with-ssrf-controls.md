---
status: accepted
date: 2026-10-10
---

# ADR-0076: 本番は 1 つのアカウントの 1 つの VPC（3 AZ）に置き、サブネットを `lb`・`app`・`ml`・`data`・`vault`・`egress`・`untrusted-egress` に分ける。信頼する宛先への送信は送るサービスだけが名前の許可の一覧と固定の IP で行い、信用しない宛先（iCal、PMS の Webhook）への送信は DB に触れない専用のタスクが、私的なアドレスを拒むファイアウォールと名前の解決の固定の二重の守りで行う

## Context

- 本システムは、決済・為替・銀行・eKYC・翻訳・地図・SMS・メール・プッシュ・外部の ID の提供者に送る。銀行は送り元の IP の登録や閉じた網を求めることがある（**未検証**）。
- 他の掲載先の iCal の URL はホストが入れ、PMS の Webhook の受け口の URL は開発者が入れる。本システムの外の人が決めた宛先へ取りに行く・送ることは SSRF の経路になる。メタデータのアドレス、内部の ALB、DB を叩かれると、資格情報と個人のデータの漏れになる（[security.md](../architecture/security.md) の T8）。
- 取り込む iCal は信用しない入力で、私的なアドレスへの接続を拒む（[AGENTS.md](../../AGENTS.md)）。解析器そのものの脆弱性も入口になる。
- vault のクラスタへの接続は 4 サービスだけに許す（[ADR-0001](0001-platform-and-stack.md)）。
- `ml-inference` は依存の多い Python の部品で、DB と外から離したい（[ADR-0009](0009-trust-and-safety-and-ml-boundary.md)）。
- Mercari の題材は、送るサービスだけの egress と `ml` のサブネットを決めた（[Mercari の ADR-0072](../../../mercari/docs/decisions/0072-accounts-network-and-egress.md)）。外の URL を取りに行く機能は持たなかった。

## Options

信用しない宛先：

1. **専用のサブネットのタスク（DB に触れない）と、ファイアウォールの拒否と、アプリの名前の解決の固定の二重の守り。解析も取得の側で行う**
2. 信頼する宛先と同じ egress で、アプリの URL の検査だけ
3. 外部の取得の代理のサービスを買う

アカウント：

- a. **本番の作業負荷は 1 つのアカウント、データレイクと学習は別のアカウント**
- b. ドメインごとにアカウントを分ける

## Decision

1 と a を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 1・2・5 節。

- **アカウント**：management、security、log-archive、shared、edge、observability、canary、data、prod、staging、dev。SCP で東京・大阪の外を禁止し、監査と鍵の停止を break-glass の外に禁止する。
- **サブネット**：`lb`（内部の ALB）、`app`（タスク）、`ml`（`ml-inference`。出るのは S3 のモデルの読みだけ）、`data`（Aurora core・ledger・content、Valkey、OpenSearch）、`vault`（Aurora vault。`listings`・`compliance-jp`・`identity`・`payouts` のセキュリティグループと `app` のサブネットの NACL だけ）、`egress`、`untrusted-egress`。
- **信頼する宛先**：`payments`、`ledger` の相場の取り込み、`payouts`、`identity`、`listings`・`messaging`（翻訳）、`listings`・`search-api`（地図・住所）、`notifier` だけが `egress` を使う。Network Firewall の SNI の許可の一覧と AZ ごとの固定の IP の NAT。銀行が閉じた網を求めたら shared の Site-to-Site VPN。
- **信用しない宛先**：`ical-fetcher` と `webhook-sender` だけが `untrusted-egress` のサブネットから送る。タスクは DB・Valkey・OpenSearch・内部の ALB に触れず、SQS・`kms-pms-secrets`・ログだけ。Network Firewall で私的・予約済み・メタデータ・VPC の範囲を拒み、ポートを 443（iCal は 80 も）に絞る。アプリは名前を 1 回解決し、全部のアドレスが公開のアドレスかを確かめ、その IP に接続する。転送は iCal が 3 回まで毎回確かめ直し（`https` から `http` への格下げは拒む）、Webhook は辿らない。信頼する宛先と別の固定の IP の NAT。
- **iCal の解析**：`ical-fetcher` の中で行い、泊の区間の集合と予定の鍵のハッシュだけを SQS の `ical-apply` に入れる。`ical-sync` は形を確かめ直してから `stay_claims` に入れる（[calendar-sync.md](../architecture/calendar-sync.md) の 5 節、[ADR-0021](0021-ical-import-pipeline-and-safety.md)）。
- **Webhook の受け口**：`hooks.<brand>.<domain>` の別の配信と WAF。
- **plan のポリシー検査**で、この形を外れる変更を拒む。

### 他の案を選ばなかった理由

- **2（同じ egress、アプリの検査だけ）**：検査の 1 つの誤り（IPv6 の書き方、DNS の再束縛、転送）で中の機械に届く。取得のタスクが DB の資格情報を持つと、被害が大きい。
- **3（外部の代理）**：iCal の URL（ホストの他の掲載先のアドレス）を第三者に渡すことになり、越境の整理（法務の L8）と費用が増える。条件つきの取得と解析の上限を自分で持てない。
- **b（ドメインごとのアカウント）**：core と ledger の outbox と照合がアカウントをまたぐ。S1 の規模に対して運用が重い。

## Consequences

- 良くなること：
  - 外の人が決めた宛先への送信が、DB に触れない 2 種類のタスクに閉じ、SSRF と解析器の脆弱性の被害の範囲が小さい。
  - vault への経路がネットワークでも 4 サービスに閉じる。
  - 外へ送れるサービスの一覧が短く、検査が簡単になる。
- 引き受けるコスト：
  - Network Firewall と NAT が 2 組になり、費用が増える（**未検証**）。
  - iCal の取得から `stay_claims` までに SQS の 1 段が増える（NFR-003 の取得から p95 1 分に収まる見込み。`ical-import-poc` で確かめる）。

## Confirmation

- 性質ベーステスト：任意の URL と名前の解決の答えで、私的・予約済み・メタデータのアドレスに接続しない（PROP-INF-001）。
- staging の結合：送らないサービス・`untrusted-egress` のタスクから、外・DB・内部の ALB への禁じた接続が失敗する。
- plan のポリシー検査の自己の試験。
- E20 の外部のペンテストで SSRF と外への送信の経路を確かめる。
