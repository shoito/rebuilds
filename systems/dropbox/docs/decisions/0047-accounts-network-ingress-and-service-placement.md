---
status: accepted
date: 2026-10-09
---

# ADR-0047: アカウントとネットワークは他の題材の形に、クライアントの署名と配布の `release` のアカウントを足す。中身はサーバーを通さず、アップロードは S3 の東京のエンドポイントへ直接、ダウンロードは `content.<brand>usercontent.<domain>` の CloudFront から。利用者のファイルを開くタスクは外への経路も S3・DB・KMS の権限も持たない sandbox のサブネットに置き、Webhook は egress のサブネットから出す

## Context

- 他の題材（Google Calendar の ADR-0043 など）は、Organizations のアカウントの分け方、public・private・egress・isolated のサブネット、CloudFront＋WAF の入口、Network Firewall の許可リストを決めている。
- この題材は、中身の量が大きい（S1 で送信のピーク 2 GB/秒、配信のピーク 4 GB/秒。[architecture/README.md](../architecture/README.md) の 2 節）。中身をサーバーに通すと、台数と転送の費用が増える（[ADR-0007](0007-block-storage-layout-on-s3.md)）。
- 利用者のファイルを、第三者の変換の部品で開く（プレビュー、抽出、検査）。部品の脆弱性を突かれる前提で隔離する（[security.md](../architecture/security.md) の 3.4 節）。
- デスクトップとモバイルのクライアントを、署名して配布し、自動で更新する（[delivery.md](../architecture/delivery.md)）。署名の鍵が盗まれると、全端末へ任意のコードを配れる。
- 利用者の中身は本体と別のドメインから返す（[AGENTS.md](../../AGENTS.md)）。

## Options

中身の経路：

1. **アップロードは S3 のリージョンのエンドポイントへ直接、ダウンロードは CloudFront（OAC）から**
2. アップロードも CloudFront（または Transfer Acceleration）を通す
3. 中身を ECS のサービスが中継する

利用者のファイルを開くタスク：

- a. **外への経路も S3・DB・KMS の権限も持たない sandbox のサブネット。入出力はジョブごとの署名つき URL**
- b. private のサブネットで、タスクのロールを絞る
- c. 別の AWS のアカウントに置く

## Decision

1 と a を採用する。

- アカウントは他の題材の形（management、security、log-archive、shared、edge、dev、staging、synthetics、prod）に、`release` を足す。`release` はクライアントの署名の鍵（HSM か書き出せない署名のサービス）、更新の目録と成果物のバケット、`dl.<brand>.<domain>` の CloudFront を持つ。
- サブネットは public・private・egress・isolated に `sandbox` を足す。`sandbox` は NAT・IGW への経路を持たず、S3 のゲートウェイのエンドポイント（方針で `blocks`・`blocklists` の GET と `previews` の PUT だけ）と、ECR・CloudWatch Logs・ジョブの SQS のインターフェースのエンドポイントだけを持つ。タスクのロールはイメージの取得、ログの出力、自分のジョブのキューの受信・削除・見えない時間の変更と、結果のキュー `sandbox-results` への送信だけ（[ADR-0032](0032-sandboxed-preview-pipeline.md)）。

> 2026-10-09 の注記：結果を返す経路がなかったので、統合の工程で `sandbox-results` への送信を足した。結果の本文は ID・状態・理由のコード・大きさ・SHA-256 だけ。
- 入口：`www`（殻と `/s/*` の `link`）、`api`、`auth`、`notify`（WebSocket）を CloudFront＋WAF で受ける。`content.<brand>usercontent.<domain>` は CloudFront の署名つき URL で `blocks`・`previews` を OAC で読み、クッキーを使わない。
- アップロードは、署名つきの PUT で `<brand>-incoming-apne1` の東京のリージョンのエンドポイントへ直接送る。`aws:SecureTransport` を必須にする。
- Webhook の送信は egress のサブネットの専用の NAT から出し、送信の直前に名前を引いて私的なアドレスを拒む。IdP のメタデータ、APNs・FCM は Network Firewall の許可リストを通す。
- WAF の IP ごとの上限は、会社の NAT の後ろの多くの端末を前提に粗くし、細かい上限はアプリでトークンごとに数える。

### 他の案を選ばなかった理由

- **2（アップロードも CloudFront）**：利用者は日本にいて、エッジを通す利得が小さいと見込む。CloudFront の上りの転送の費用と、署名つき URL の形の違い（S3 のチェックサムの指定を通せるか）が増える。`presigned-upload-poc` で速さが足りなければ見直す。
- **3（ECS が中継）**：[ADR-0007](0007-block-storage-layout-on-s3.md) の案 4 と同じ理由。
- **b（private で絞る）**：NAT への経路が残り、乗っ取られたタスクが外へ出せる。他のサービスのエンドポイントに届く。
- **c（別のアカウント）**：隔離は強いが、イメージ・ログ・キュー・鍵の配置がアカウントをまたぎ、運用が重い。ネットワークと S3・DB・KMS の権限を持たないことで、同じ守りを得る。S3 のセル（S3 の段階）で見直す。

## Consequences

- 良くなること：
  - 中身の量に比例してサーバーを増やさなくてよい。
  - 変換の部品が乗っ取られても、外へ出せず、他のジョブの中身にも DB にも届かない。
  - 署名の鍵が本番の作業の権限から離れる。
- 引き受けるコスト：
  - SQS のエンドポイントの方針を、ジョブのキューの受信・削除と結果のキューへの送信だけに絞り続ける検査が要る。
  - アップロードの経路（S3）とダウンロードの経路（CloudFront）で、監視と障害の見分けが 2 つになる。

## Confirmation

- Terraform の plan の検査：sandbox・isolated の経路表に NAT・IGW がない。sandbox のタスクのロールに S3・DB・KMS の権限がなく、SQS は自分のジョブのキューの受信・削除・見えない時間の変更と `sandbox-results` への送信だけ。sandbox の S3 のエンドポイントの方針が決めた範囲より広くない。egress から VPC エンドポイント・isolated への経路がない。
- 夜間の隔離の検査：sandbox のタスクから外への通信が失敗する。
- 結合テスト：`content` の応答にクッキーがない。本体のドメインから利用者の中身が返らない。
