---
status: accepted
date: 2026-09-27
---

# ADR-0055: Media Node と TURN はその場で更新せず、新しい AMI の台を足して古い台を drain する。カナリアの台の会議の品質を比べてから、日ごとの波で入れ替える

## Context

Media Node の変更（mediasoup のバージョン、RED などの worker の変更、Node Agent、OS、カーネル、ENA のドライバ）は、すべて Media Node の台の上のプロセスを止める。Node Agent は worker の親のプロセスなので、Node Agent を入れ替えると worker も止まる（[media-server-sfu.md](../architecture/media-server-sfu.md) の 12.2 節）。

- 会議は最大で数時間続く。計画した入れ替えは、会議が終わるのを待つ（最大 4 時間）か、make-before-break で移す（同 10 節、[ADR-0013](0013-media-node-failover-and-reattach.md)）。
- メディアの回帰（音声の途切れ、層の切り替えの誤り）は、単体の試験では見えにくい。本番の回線の多様さの中で初めて見えるものがある。
- Media Node のセキュリティグループの規則を変えると、追跡していないフローはすぐに切れる（[ADR-0016](0016-media-edge-addressing-and-security-groups.md)）。

## Options

1. **新しい AMI の Auto Scaling グループ（緑）を足し、Assignment Service が新しい会議を緑に寄せ、古い台（青）を drain する。カナリアの台で品質を比べ、日ごとの波で進める**
2. Auto Scaling グループのインスタンスの更新（instance refresh）
3. その場で Node Agent と mediasoup を入れ替える

## Decision

1 を採用する。手順は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) の「Media Node」。

- **形**：Media Node の変更は、必ず新しい AMI（EC2 Image Builder で作る）として出す。AZ ごとに新しい Auto Scaling グループ（起動テンプレートのバージョン）を作る。古いグループは、入れ替えが終わるまで残す。
- **カナリア**：まず AZ ごとに 1 台の新しい Node を足す。Assignment Service は、新しい会議の 5% をカナリアに置く（Node の属性 `generation` で重みを付ける）。平日の昼のピークを 1 回含む 24 時間、カナリアの会議と、同じ時間の古い台の会議の SLI（[ADR-0052](0052-media-slis-and-mos-estimation.md) の良い音声の分、フリーズのない分、意図しない脱落、worker の異常終了、転送の遅れ）を比べる。
  - 合格：どの SLI も、古い台との差が許す範囲（良い音声の分で −0.5 ポイント以内など。値は quality.md で決める）で、worker の異常終了が 0。
- **波**：合格したら、1 日 1 回、Node の台数の 10% → 25% → 50% → 100% の順に新しい台を足し、同じ数の古い台を `draining` にする。各波の後に、同じ比較を 4 時間行う。
- **古い台の片付け**：`draining` の台は、会議が自然に終わるのを 4 時間まで待つ。残った会議は、夜間（利用の少ない時間）に make-before-break で新しい台へ移し、終了させる。
- **戻す**：新しい台を全部 `draining` にし、古いグループの台数を戻す。進行中の会議は、急ぎでなければ自然に終わるのを待つ。回帰が音声の途切れのように重いときは、新しい台の会議を make-before-break で古い台へ移す。
- **急ぎ（mediasoup・coturn・カーネルの重大な脆弱性）**：カナリアを 1 時間にし、波を 15 分ごとの 20% にする。残った会議はすぐに make-before-break で移す。インシデントの指揮者の判断で行う。
- **TURN**：同じ形で、新しい台を足し、参加の応答の ICE のサーバーの一覧から古い台を外す（新しい割り当てを作らせない）。古い台は割り当てが 0 になるか 4 時間で終了させる。残った参加者は、ICE restart で別の TURN へ移る（[network-traversal.md](../architecture/network-traversal.md) の 10 節）。
- **セキュリティグループと網の設定**：規則を変えるときは、変えた規則を持つ新しい台で上と同じ手順にする。動いている台の規則を変えない。
- **世代の混在**：同じ会議の中で、古い台と新しい台がカスケード（S2）でつながりうる。PipeTransport の間の互換（mediasoup のバージョンの差）は、1 つ前のバージョンまで保証する。保証できない変更は、カスケードを世代ごとに分けるフラグを先に出す。
- 2 を採らない理由：instance refresh は、台を置き換えるときに古い台を終了させる。会議が終わるのを待つ制御と、品質の比較の合否の判定を持たない。
- 3 を採らない理由：worker が止まり、全参加者の付け替えが起きる。台の中身が AMI と食い違う。

## Consequences

- 良くなること：
  - 利用者は、入れ替えの間にほとんど途切れを感じない（自然に終わるのを待つ会議が大半の見込み）。
  - 本番の多様な回線で、新しいバージョンの品質を小さな範囲で確かめてから広げられる。
- 引き受けるコスト：
  - 全体の入れ替えに、最短で 5 日かかる。
  - 入れ替えの間は、古い台と新しい台の両方を持つので、台数と EIP が一時的に増える（BYOIP の /24 に余裕を持つ。[ADR-0049](0049-media-node-fleet.md)）。
  - 品質の比較には、Node の世代ごとに SLI を分ける集計が要る（`generation` を AMP の低い種類のラベルにする）。

## Confirmation

- 障害の注入の試験（staging）：カナリアに、わざと音声を落とす変更を入れた AMI を出し、比較で不合格になって波が止まる。
- 訓練（四半期、staging）：make-before-break での移動で、音声の途切れが 500ms 以下（[media-server-sfu.md](../architecture/media-server-sfu.md) の 12.2 節）。
- Terraform の検査：Media Node の Auto Scaling グループで、instance refresh を有効にしていない。
