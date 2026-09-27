---
status: accepted
date: 2026-09-27
---

# ADR-0046: Gateway と Document Server は ECS Fargate（ARM64）で動かし、Document Server はタスクの保護と自前のドレインでファイルを渡してから止める。WebSocket は CloudFront と ALB で受ける

## Context

Gateway は WebSocket を何時間も持ち、Document Server はファイルをメモリに持つ（[multiplayer.md](../architecture/multiplayer.md) の 3 節）。どちらも、止めるときの作法が普通の HTTP のサービスと違う。

- **Document Server を止めると、持っていたファイルの持ち主が変わる。** 回復は、持ち主のタスクの生存の期限（10 秒）と猶予（2 秒）の後の割り当て直しと、読み込みを待つ（NFR-007 の 15 秒。[ADR-0047](0047-router-task-liveness-and-file-assignment.md)）。デプロイのたびに全ファイルがこの回復を通ると、再接続とチェックポイントの読み込みが集中する。本家も、デプロイで全ファイルを閉じることがチェックポイントの急増を招いたと書く（[Making multiplayer more reliable](https://www.figma.com/blog/making-multiplayer-more-reliable/)、2022-10-20、2026-09-27 に確認）。
- **ECS は、止めるタスクに SIGTERM を送り、`stopTimeout`（最大 120 秒）の後に強制終了する。** Fargate でも EC2 でも上限は 120 秒（[Fargate のタスク定義](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)、[EC2 のタスク定義](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters_ec2.html)、2026-09-27 に確認）。数千のファイルを 120 秒で渡し切れるとは限らない。
- **ECS のタスクの保護**（scale-in protection）を立てたタスクは、オートスケールの縮小でもデプロイでも止められない。保護は最大 48 時間で、ローリングの更新では新しいタスクが先に起動し、古いタスクは保護が外れるまで残る（[Task scale-in protection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection.html)、2026-09-27 に確認）。
- **Fargate は、基盤の更新でタスクを退役させる。** 拒めない。サービスのタスクは、ECS が新しいタスクを先に起動してから古いタスクを止める。通知は AWS Health と EventBridge に届き、待つ期間（7 日か 14 日）か EC2 のイベントの時間帯（2025-12-18 から）で時期を決められる。基盤のホストに問題があれば、通知なしに入れ替える（[Task retirement and maintenance for AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-maintenance.html)、2026-09-27 に確認）。タスクの保護が防ぐのは、サービスのオートスケールの縮小とデプロイで止められることだけと書かれている（[Task scale-in protection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection.html)、2026-09-27 に確認）。退役は保護の対象に挙がっていないので、**退役は保護を待たない前提で設計する**。
- Fargate のタスクは最大 32 vCPU・244 GB、16 vCPU では 120 GB まで（Fargate のタスク定義の資料）。
- ALB は WebSocket を扱う。接続は確立したターゲットに固定され、ターゲットの選び方は「未処理の要求が最も少ない」。アイドルの期限は既定 60 秒、1〜4,000 秒で変えられる。登録解除の遅延は既定 300 秒（[ALB の属性](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)、[ターゲットグループの属性](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html)、2026-09-27 に確認）。NLB の TCP のアイドルは既定 350 秒で、TLS のリスナーでは変えられない（[NLB の TCP のアイドル](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/update-idle-timeout.html)、2026-09-27 に確認）。CloudFront は WebSocket を中継できる（[Use WebSockets with CloudFront distributions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)、2026-09-27 に確認）。
- 本家は ECS から EKS へ移った。理由は StatefulSets がないこと、Helm のチャートを使えないこと、CNCF の道具を使えないこと。マルチプレイヤーのサービスも EKS に移した（[How we migrated onto K8s in less than 12 months](https://www.figma.com/blog/migrating-onto-kubernetes/)、2024-08-08、2026-09-27 に確認）。

## Options

1. **ECS Fargate（ARM64）。Document Server はタスクの保護と自前のドレイン**
2. **ECS on EC2（メモリ最適化のインスタンス、容量プロバイダー）**
3. **ECS を使わず、EC2 の Auto Scaling グループで直接動かす**
4. **EKS**

入口：

- a. **CloudFront（WAF）→ ALB → Gateway**
- b. **NLB（TCP）→ Gateway（TLS は Gateway で終える）**

## Decision

1 と a を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 3・4 節。

- **Gateway**：Fargate、4 vCPU・8 GB。3 AZ に均等に置く。接続の数（1 タスク 1 万まで）と CPU でスケールする。
- **Document Server**：Fargate、2 つの群れに分ける。
  - `ds-standard`：8 vCPU・60 GB。ふつうのファイル。
  - `ds-large`：16 vCPU・120 GB。メモリの見積もりが 1.5 GiB を超えるファイル（圧縮の前のチェックポイントでおよそ 500 MB 超。見積もりの式と閾値の正本は [ADR-0051](0051-document-server-memory-admission.md)。[file-storage-and-history.md](../architecture/file-storage-and-history.md) の 6.4 節）。
- **タスクの保護**：Document Server は、ファイルを 1 つでも持つ間、自分のタスクに保護を立てる（ECS のエージェントのエンドポイント。期限 60 分で、10 分ごとに延ばす）。持つファイルが 0 になったら外す。
- **ドレイン**：デプロイ・縮小・退役の通知を受けたら、ドレインの制御（Router の一部。[ADR-0047](0047-router-task-liveness-and-file-assignment.md)）が、古いタスクを「新規を受けない」にし、持つファイルを少しずつ新しいタスクへ渡す（手放しの記録 `handoff`）。渡し終えたタスクは保護を外し、ECS が止める。
  - 1 つのファイルの渡しは、受け付けを止める → ジャーナルを書き切る → `handoff` を記録 → 新しい持ち主が回復する（チェックポイント＋ジャーナル 60 秒ぶん）→ クライアントが再接続、の順。チェックポイントを書くのを待たない（本家が、ジャーナルでデプロイ時の閉じる時間を短くしたのと同じ考え方）。
  - 1 タスクあたり毎秒 20 ファイルずつ渡す。大きなファイルから先に渡す。
- **Fargate の退役**：AWS Health の退役の通知を EventBridge で受け、待つ期間（14 日）の間に、平日の昼にドレインで入れ替える。退役がタスクの保護を待たなかったときも、タスクの生存の期限切れと割り当て直し（ADR-0047）、回復（NFR-007）で守られる。
- **Gateway の入れ替え**：Slack の ADR-0022 の Gateway の形（登録解除の遅延 180 秒、その間に接続を少しずつ切る）を引き継ぐ。切るときは `Kick(server_shutdown, retry_after_ms)` を送り、`retry_after_ms` を 0〜60 秒に散らす。
- **入口**：`mp.<brand>.<domain>` の CloudFront（WAF）→ ALB（アイドル 300 秒）→ Gateway。クライアントは 20 秒ごとに `Ping` を送る。Gateway も、20 秒のあいだ何も送っていない接続に `Pong`（時刻）を送る。CloudFront の資料には WebSocket に固有のアイドルの期限がない。オリジンの応答の期限（既定 30 秒。オリジンから次のパケットが届くまでも待つ時間）はあるので、Gateway からの送信を 20 秒より空けない。応答の完了の期限（response completion timeout）は、この経路に設定しない（[Origin settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html)、2026-09-27 に確認）。応答の期限が WebSocket のフレームにも効くか、接続の長さに上限があるかは **未検証**（E3 の `gateway-edge-websocket` の PoC で、8 時間切れないことを確かめる）。
- **Gateway と Document Server の間**：VPC の中の直接の TCP。Document Server は、生存の記録（ADR-0047）に自分の IP とポートを書く。セキュリティグループで、Gateway と Router のタスクからだけ受ける。
- 2 を採らない理由（S1）：メモリ最適化のインスタンスの方が、GB あたりの費用とメモリの比率（8:1）で勝るが、S1 の台数（数十タスク）では差が小さい（[capacity.md](../architecture/capacity.md) の 7 節）。インスタンスの管理（AMI の更新、容量の予約、ドレイン）を持つ費用の方が大きい。S2 で再評価する（再評価の条件は infrastructure.md の 9 節）。
- 3 を採らない理由：デプロイ・ヘルスチェック・ログの仕組みを自前で持つことになる。
- 4 を採らない理由：他の題材の基盤（ECS）と揃える（[ADR-0001](0001-platform-and-stack.md)）。本家が EKS へ移った理由（StatefulSets、Helm）は、この設計では効かない。Document Server の状態は Router とジャーナルが持ち、タスクの固定の名前を要しない。
- b を採らない理由：TLS のリスナーのアイドルが 350 秒で固定になる。WAF を前に置けない。

## Consequences

- 良くなること：
  - デプロイのたびの回復が、タスクの生存の期限（10 秒）を待たずに済む。ファイルごとの中断は、渡しの 1〜2 秒になる見込み（**未検証**。E3 の `ds-drain-controller` と、E12 の `load-test-suite` の L6 で計測する）。
  - インスタンスの管理を持たない。
- 引き受けるコスト：
  - ドレインの制御を自前で持つ。止まると、デプロイが保護の期限まで進まない。
  - タスクの保護で、デプロイの完了が遅れる（数千のファイルで数分）。
  - Fargate の退役とホストの障害は拒めない。回復の仕組み（NFR-007）がいつも使われる前提になる。

## Confirmation

- 結合テスト：ファイルを持つ Document Server のタスクを、デプロイで入れ替えても、確定した変更が失われず、各ファイルの中断が p95 2 秒以内。
- 障害注入：タスクの保護を無視して強制終了しても、NFR-007 の 15 秒以内に回復する。
- 計測：デプロイ中の再接続の率と、Router の割り当ての率（[observability.md](../architecture/observability.md)）。
