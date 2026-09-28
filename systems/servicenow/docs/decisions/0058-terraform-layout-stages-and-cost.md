---
status: accepted
date: 2026-09-28
---

# ADR-0058: Terraform はセルを 1 つのモジュールとして持ち、セルの一覧のファイルから作る。セルを足す・段階を上げる基準を決め、費用をセル・アカウント・タグで配分する

詳細は [infrastructure.md](../architecture/infrastructure.md) の 7・9・10 節。

## Context

[ADR-0055](0055-accounts-cells-and-edge-router.md) はセルごとにアカウントを分けた。共有のセルは負荷に応じて増え（S2 で多数、S3 で東京・大阪の両方）、専用のセルは顧客ごとに出る（[ADR-0056](0056-dedicated-cells-and-tenant-moves.md)）。セルの数だけ、同じ構成を正しく作り、差がないことを確かめる必要がある。[architecture/README.md](../architecture/README.md) は、段階を上げる判断の基準を infrastructure の領域で決めるとした。

他の題材は、ルートモジュールを変更の頻度と影響の範囲で分けている（Auth0 の infrastructure.md の 7.2 節）。

## Options

### セルの IaC

1. **セルの 1 つのモジュールと、セルの一覧のファイル（`cells.yaml`）から、セルごとのルートモジュールの実体を作る**
2. セルごとに手で書いたルートモジュール
3. 制御の面が API でセルを作る（Terraform の外）

## Decision

1 を採用する。

- `cell/{cell_id}/{region}` はセルのモジュール 1 つの実体で、変数はセルの種類（共有・専用）と大きさ。`cells.yaml` を正本にし、制御の面の台帳のセルの一覧と CI で突き合わせる。
- ほかのルートモジュール：`org/`、`security/`、`global/edge`、`global/dns`、`control/{region}`、`mail-ingress/{region}`。
- 状態を持つリソースの削除・置き換えは CI で拒否する。KMS・IAM・WAF・ルーターの関数は `security:sensitive`。
- 新しい共有のセルを足す目安：writer の CPU のピークの p95 60%、優先度 0 のタイマーの遅れの p99 が 9 時の山で 30 秒、セルのテナントの数 200（E12 で決める）、1 テナントが書き込みの 30%。
- S1 → S2 を始める目安：最大のクラスでも writer の CPU が 60% を超える見込み、レポートの reader B の基準、大口の契約の RTO 15 分、KeyValueStore・配信のオリジンの数の上限の 70%。
- 費用はアカウント（セル）とタグ（`cell`、`service`、`env`）で毎月見る。テナントの費用は、セルの費用を要求の重みとレコードの数で按分する。

2 を採らない理由：セルが増えるたびに、手のコピーの差が生まれ、大阪の待機の構成との差の検査も難しくなる。

3 を採らない理由：VPC・DB・鍵のような状態を持つ基盤を、アプリの API で作ると、plan のポリシー検査（削除の拒否、暗号化、経路）を通らない。テナントの作成（DB の行）は制御の面の API で、セルの作成（基盤）は Terraform で行う。

## Consequences

- 良くなること：
  - 全セルが同じ構成で、差がないことを plan で確かめられる。
  - セルを足すのが、一覧の 1 行と apply で済む。
- 引き受けるコスト：
  - セルのモジュールの変更は、全セルの plan と apply を段階的に行う（カナリアのセルから。[delivery.md](../architecture/delivery.md) の 6 節）。
  - `cells.yaml` と台帳の二重の管理。CI の突き合わせで食い違いを止める。

## Confirmation

- CI：`cells.yaml` と台帳のセルの一覧が一致する。
- 日次：各セル（東京・大阪）の plan に差分がない。
- 月次：費用のレポートのセル別・サービス別の内訳。
