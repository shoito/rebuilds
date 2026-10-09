# Runbook: 自己監視の経路の停止

- Owner: Ops
- 対応するアラート: 自己監視の経路の停止（デッドマンスイッチの段 1〜3）、自己の計測の送り手の沈黙（`absent_over_time(svc_up[5m])`）、オンコールのサービスの心拍の途切れ。訓練（四半期ごと、E13 の `self-monitoring-drill`）
- 最終確認日: 2026-10-09

設計は [README.md](README.md) の 5 節、[observability.md](../architecture/observability.md) の 1・4・5 節、[ADR-0062](../decisions/0062-independent-self-monitoring-path.md)。selfmon のアカウントは大阪にあり、本番（東京）のどの部品にも依存しない。

## 症状

| 段 | 鳴り方 | 疑うところ |
| --- | --- | --- |
| 1. `canary` の心拍 | `CanaryHeartbeat` の欠け（取り込み 2 分・通知 3 分） | 本番の取り込み・クエリ・評価・通知のどれか、または `canary` 自身 |
| 2. AMP の Watchdog | オンコールのサービスの心拍の受け口が途切れて呼び出す | AMP のルールの評価、Alertmanager、SNS、selfmon の大阪のリージョン |
| 3. 送り手の沈黙 | `absent_over_time(svc_up[5m])`、AMP の書き込みの数 0 | 本番の ADOT のコレクター、`selfmon-relay`、NAT・Network Firewall、AMP への書き込みの権限 |

## 影響

- 段 1 は本番の障害の可能性が高い。利用者の監視が止まっている恐れがある。
- 段 2・3 は、本番が正常でも「監視を失った」状態。本番の障害に気づけない時間が続く。

## 確認

1. どの段が鳴ったか。段 1 だけなら、まず本番を疑う：selfmon の Grafana で SLI を見る。本番の SLI も止まっていれば段 3 も疑う。
2. `canary` のタスク（selfmon の Fargate）が動いているか。`canary` のキーが失効していないか。
3. 段 2：selfmon の大阪の AMP・Alertmanager・SNS の状態（AWS の Health Dashboard の大阪）。
4. 段 3：本番のコレクターのディスクの溜まり（最大 15 分）、`selfmon-relay` のタスク、Network Firewall の許可リスト、selfmon のロールの引き受けの失敗。

## 対処

### 場面 1：段 1（本番の障害の疑い）

1. [incident-response.md](incident-response.md) で本番の障害として扱う。
2. `canary` 自身の問題なら（タスクの停止、キーの失効）、`canary` を直す。直すまで、本番の最小のアラーム（NLB の 5xx、MSK のオフラインのパーティション、Aurora の可用性）と selfmon の SLI で見る。

### 場面 2：段 2・3（監視を失った）

1. 本番の東京のアカウントの CloudWatch の最小のアラームが生きていることを確かめる。これが当面の監視になる。
2. 当番を 1 人、selfmon が戻るまで本番の最小のアラームと公表のページの問い合わせを見る役にする。
3. 段 3 の原因を直す：`selfmon-relay` を起こし直す、Network Firewall の許可リストを戻す、ロールの権限を戻す。コレクターは 15 分までディスクに溜めているので、15 分以内に戻せば計測の欠けはない。
4. selfmon の大阪のリージョンの障害なら、selfmon の最小の写し（アラームと `canary`）を東京に起こす（Terraform の `selfmon/` を東京のリージョンで当てる）。

### 場面 3：本番を大阪へ切り替えた後

1. 本番と selfmon が同じ大阪になる。selfmon の最小の写し（アラームと `canary`）を東京に起こす（[disaster-recovery.md](disaster-recovery.md) の 7）。
2. 東京が使えない間は、本番の大阪の最小のアラームとオンコールのサービスの心拍で見る。

## エスカレーション

- 段 2・3 が 30 分を超えて戻らない：Ops の責任者。監視を失った時間を記録し、必要なら公表のページで知らせる。
- 本番の障害と同時：[incident-response.md](incident-response.md) の IC が全体を持つ。

## 事後

- 監視を失った時間と、その間に本番で起きたことを記録する。
- 訓練（四半期ごと）で、段 1・2・3 のそれぞれから呼び出しが届くことを確かめる（[quality.md](../quality.md) の 2.2.1 節 K）。
- この手順で足りなかったことを、ここに反映する。
