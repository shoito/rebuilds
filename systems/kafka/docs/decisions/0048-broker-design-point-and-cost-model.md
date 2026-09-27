---
status: accepted
date: 2026-09-27
---

# ADR-0048: ブローカーの設計点を「ネットワークと EBS の基準の帯域の 60%」で決め、Standard は r8g.4xlarge、Basic は m8g.4xlarge にし、物理クラスタの CU の容量をスループットとパーティションの小さい方で数える

詳細は [capacity.md](../architecture/capacity.md) の 2〜10 節。

## Context

- ブローカーは 1 ノードに 1 つ、EBS gp3 を 1 本（[ADR-0009](0009-ebs-gp3-single-log-volume.md)）。複製 3、AZ ごとに 1 つ（[ADR-0012](0012-durability-settings-and-elr.md)）。コンシューマーは同じ AZ の複製から読む（[ADR-0013](0013-fetch-from-follower.md)）。閉じたセグメントは S3 へ上がり、ローカルの保持は 6 時間（[ADR-0019](0019-tiered-storage-lifecycle-and-dr-copy.md)）。
- 配置は、物理クラスタの CU の容量 `capacity_cu(pc)` を「ブローカーの台数 × ブローカーあたりの CU」とし、その値をこの領域に任せた（[ADR-0033](0033-logical-cluster-placement.md)）。Standard の 1 CU は書き込み 25 MB/秒・読み取り 75 MB/秒・パーティション 250（[ADR-0037](0037-capacity-unit-definition.md)）。
- ブローカーの複製は 4,000 まで（[ADR-0017](0017-metadata-limits-and-snapshots.md)）。MSK も m7g.4xlarge 以上で 4,000 を勧める（[MSK best practices](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices.html)、2026-09-27 に確認）。MSK は CPU を 60% 未満に保つよう勧める（同上）。
- EC2 の帯域は、送信と受信のそれぞれに掛かる。16 vCPU 以下の型は「最大」の帯域をクレジットで短い時間だけ出し、続けて出せるのは基準の帯域（[Instance network bandwidth](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-network-bandwidth.html)、2026-09-27 に確認）。基準の値：r8g.4xlarge・m8g.4xlarge はネットワーク 7.5 Gbps、EBS 5,000 Mbps（[Memory optimized](https://docs.aws.amazon.com/ec2/latest/instancetypes/mo.html)、[General purpose](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html)、2026-09-27 に確認）。
- 東京のオンデマンドの単価：r8g.4xlarge $1.13696/時、m8g.4xlarge $0.92752/時、gp3 $0.096/GB-月（AWS Price List API、2026-09-27 に確認）。

## Options

設計点：

1. **ネットワークの送信と EBS の、基準の帯域の 60% を上限にする（バーストを数えない）**
2. 80% を上限にする
3. 最大の帯域（バースト）で見る

型：

- A. **Standard は r8g.4xlarge、Basic は m8g.4xlarge**
- B. どちらも r8g.8xlarge（台数を減らす）
- C. どちらも m8g.4xlarge

## Decision

1 と A を採用する。

- 1 台のリーダーが受ける書き込みを W（MB/秒）、読み取りの倍率を F（既定 3）とすると、送信は (3 + F)W、EBS は 3W の書き込み＋ W（S3 への上げ）＋ 0.2FW（キャッシュに当たらない読み取り）。これが基準の帯域の 60% 以下になる W を設計点にする。r8g.4xlarge・m8g.4xlarge は W = 80 MB/秒（EBS で決まる）。
- 60% にするのは、1 つの AZ を失うと残りのブローカーの負荷が約 1.5 倍になり、90% に収まるため。ローリング更新の間の偏りも吸収する。
- ブローカーあたりの CU：Standard はスループットで 3.2 CU（80 ÷ 25）、パーティションで 5.3 CU（4,000 ÷ 3 ÷ 250）。小さい方の 3.2 を使う。Basic はスループットで 16 CU、パーティションで 13.3 CU（4,000 ÷ 3 ÷ 100）。小さい方の 13.3 を使う。`capacity_cu(pc)` はこの和。
- EBS：容量は 3W ×（ローカルの保持＋ `segment.ms`）＋ 圧縮のトピックの分を、使用率 85% で割る（r8g.4xlarge で 8 TiB）。スループットは型の EBS の基準（625 MB/秒）を超えて買わない（600 MiB/秒）。
- ローカルの保持は ADR-0019 の 6 時間のままにする。E9 の負荷試験で、2 時間より古い位置からの読み取りの割合を測り、1% 未満なら 3 時間に縮める案を ADR で出す（EBS の費用が約 4 割下がる）。
- コントローラーは m8g.xlarge（16 GiB）、Envoy は c8g.2xlarge（GA は c8g.xlarge）。
- 2 を選ばない理由：1 つの AZ の喪失で基準の帯域を超え、遅延（NFR-003）が崩れる。
- 3 を選ばない理由：バーストは数分〜1 時間で切れ、最善の努力でしかない。
- B を選ばない理由：S1 はパーティションの数で台数が決まる（10 節）。大きい型では、パーティションの上限に当たったブローカーの帯域が余る。障害の範囲も大きい。
- C を Standard に選ばない理由：メモリー（ページキャッシュ）が半分で、遅れたコンシューマーの読み取りがディスクに落ちやすい。Basic は遅延の目標が緩い（[ADR-0047](0047-slos-synthetic-probes-and-alerts.md)）ので C の型にする。

## Consequences

- 良くなること：
  - 配置（ADR-0033）とクォータ（ADR-0026）が同じ CU の容量で数えられる。
  - 型を替えるときも、同じ式で設計点を出し直せる。
- 引き受けるコスト：
  - NFR-010（1 GB あたり $0.08）は、ブローカーの平均の使用率が設計点の 40% 以上で、NLB の処理のバイトを除いたときにだけ届く。NLB を含めると約 $0.10〜$0.11 になる（[capacity.md](../architecture/capacity.md) の 8 節）。統合の工程で、NFR-010 を「NLB を含めて設計点で $0.11 以下」に改め、$0.08 を S2 の目標にした（PM・Dev の確認待ち）。
  - S1 の目標（パーティション 20 万）では、ブローカーは約 150 台になり、スループットの必要（約 27 台）の 5 倍を超える。パーティションに課金しない価格のままでは、原価が合わない（[capacity.md](../architecture/capacity.md) の 10 節）。統合の工程で、CU に含む数を超えたパーティションをパーティション-時で課金する既定案にした（[ADR-0039](0039-jpy-billing-and-free-tier.md)。PM・Dev の確認待ち）。
  - 値はすべて初期見積もり。E1・E9 の負荷試験で置き換える。

## Confirmation

- 負荷試験（[capacity.md](../architecture/capacity.md) の 11 節）：r8g.4xlarge で W = 80 MB/秒・F = 3 のとき、CPU 60% 未満、produce の p99 50ms 以内、1 つの AZ を止めても p99 100ms 以内。
- 本番：ブローカーごとのネットワークの送信・EBS のスループットの基準の帯域に対する使用率（p95）を週次で見る。60% を超えるブローカーが続けば、再配置か追加。
- 月次：実際の原価（Cost and Usage Report）を、書き込みの GB で割った値を、この ADR の見積もりと比べる。
