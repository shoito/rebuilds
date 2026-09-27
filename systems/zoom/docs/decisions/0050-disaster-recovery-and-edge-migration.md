---
status: accepted
date: 2026-09-27
---

# ADR-0050: リージョンの障害では進行中の会議を守らず、大阪で新しい会議を受ける。Media Node をコロケーションへ移す判断は、転送の量の閾値で S1 の間に始める

## Context

[architecture/README.md](../architecture/README.md) の 2 節は、S1 の災害復旧を「大阪は制御の側だけ。メディアは大阪で新しく会議を始め直す」とした。AZ の障害は、Media Node の付け替え（[ADR-0013](0013-media-node-failover-and-reattach.md)）と、制御の側の Multi-AZ で扱う。リージョンの障害の目標は、まだ決まっていない。

- Meeting Actor の状態は Valkey とメモリにあり、大阪へ複製しない（[ADR-0007](0007-meeting-actor-lease-and-epoch.md)）。
- 録画の生の区切りは東京の S3 にあり、大阪へ複製しない（[recording-and-transcription.md](../architecture/recording-and-transcription.md) の 6.1 節）。
- 大阪には c7gn・c8gn がない（[ADR-0048](0048-accounts-network-and-media-regions.md)）。障害の時に大阪で EC2 を大量に起動できる保証はない。

費用について、[capacity.md](../architecture/capacity.md) の 6 節で S1 を見積もった。

- AWS のインターネットへの転送（東京、150 TB/月を超える分）は 0.084 USD/GB（[データ転送の料金のデータ（東京）](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/ap-northeast-1/index.json)、2026-09-27 に確認）。S1 のピーク（期待の平均の 45 Gbps）で、月に約 31 万 USD になる（容量の前提の 75 Gbps では約 52 万 USD）。
- 東京の IP transit の 100 GigE の加重中央値は 0.28 USD/Mbps/月（[TeleGeography の IP Transit Pricing Trends in Asia](https://resources.telegeography.com/ip-transit-pricing-trends-asia)、2026-09-27 に確認）。
- 損益の分かれ目は、ピークの送出で約 10 Gbps（同時の参加者で約 6,500 人）の見込み（**未検証**。コロケーションの固定費の仮定による。E12 の `edge-evaluation` で見積もりを取って確かめる）。S1 の目標（3 万人）は、この 3 倍以上である。

[ADR-0001](0001-platform-and-stack.md) は「S2 から Media Node だけをコロケーションへ移す」とし、[architecture/README.md](../architecture/README.md) の 2 節は「S3 で判断する」としている。

## Options

リージョンの障害：

1. **進行中の会議は守らない。大阪の制御の側を昇格し、新しい会議と、参加者の入り直しを大阪で受ける。RTO 1 時間、RPO 1 分（Aurora）**
2. 大阪にも常に Media Node を十分に置き、進行中の会議を大阪の Node へ付け替える
3. 大阪への切り替えを持たない

コロケーション：

- a. **ピークの送出の閾値（4 週続けて 10 Gbps）を超えたら、Edge の構築を始める。S1 の間に始まる前提で、BYOIP と AMI・構成の管理を先に用意する**
- b. ADR-0001 のとおり、S2 から
- c. S3 で判断する

## Decision

1 と a を採用する。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

- **AZ の障害**：
  - Media Node：同じ AZ の Node の会議は、別の AZ の予備の Node へ付け替える（ADR-0013）。そのため、Node の台数は 1 つの AZ を失っても残りの 2 つでピークを受けられるように持つ（[capacity.md](../architecture/capacity.md) の 5 節）。
  - TURN：クライアントは別の AZ の TURN を候補に持っている（[ADR-0015](0015-turn-coturn-and-ephemeral-credentials.md)）。
  - 制御の側：ECS、Aurora、Valkey の Multi-AZ。
- **リージョンの障害（東京）**：
  - 判断は人が行う（インシデントの指揮者、Ops の責任者の承認）。自動で切り替えない。東京の部分的な障害を、データを失う切り替えと取り違えないため（Auth0 の [ADR-0060](../../../auth0/docs/decisions/0060-disaster-recovery-and-stages.md) と同じ判断）。
  - 目標：新しい会議の開始と参加を、切り替えの判断から 1 時間以内に大阪で受ける（RTO 1 時間）。Aurora の RPO は 1 分。**既定案**で、Ops と PM の承認を要する。
  - 進行中の会議：東京の Media Node が生きていれば、メディアはそのまま流れる（ADR-0005）。制御が戻らない間、主催者の操作は効かない。クライアントは、シグナリングが 60 秒戻らなければ、会議の URL から入り直す画面を出す。入り直しは大阪の新しい開催になる。
  - 失うもの：進行中の会議の状態（待合室、チャット）、進行中の録画の未合成の区切り。利用者に告知する。
  - 大阪で受けている間は、ライブ字幕と文字起こしを止める。Amazon Transcribe は大阪に受け口がない（[endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/transcribe.html)、2026-09-27 に確認）。別のリージョンへ音声を送る代わりの経路は、intent.md の L6 の結論まで作らない。
  - 大阪の Media Node：平時は 3 台（c6gn.16xlarge、AZ ごとに 1 台）。切り替えで Auto Scaling グループの最大を上げる。EC2 の在庫の確保（オンデマンドの容量の予約）を、S1 のうちは持たない。切り替えの時の起動の失敗は、S1 の同時の参加者の上限を大阪では下げて受ける（受けられる数は訓練で測る）。
- **Media Node をコロケーションへ移す**：
  - 閾値：Media Node のピークの送出が 4 週続けて 10 Gbps を超えたら、Edge の構築（場所、IP transit、機器、運用の体制）を始める。構築に 2 四半期の見込み（**未検証**。E12 の `edge-evaluation` で事業者の見積もりから確かめる）。
  - > 2026-09-27 の注記：閾値の手前に、Edge の運用の体制（24 時間の当番、自社の AS と BGP の運用、機器の障害の対応）を持つかの判断の点を足す。ピークの送出が 2 週続けて 5 Gbps を超えたら、PM と Ops が体制を採用か委託で持つかを決める。人の確保は構築の 2 四半期より長くかかりうるため、閾値を待たずに決める。持たないと決めたら、閾値を超えても Edge を作らず、AWS との料金の合意か国内のベアメタルのクラウドを `edge-evaluation` で比べて選ぶ（[infrastructure.md](../architecture/infrastructure.md) の 11 節、[architecture/README.md](../architecture/README.md) の 6 節のリスク）。
  - > 2026-09-27 の注記：損益の分かれ目は、[infrastructure.md](../architecture/infrastructure.md) の 12.3 節の見積もりで、ピークの送出の約 8〜10 Gbps（同時の参加者は、下りの平均 1.5 Mbps で約 5,000〜6,500 人、容量の前提の 2.5 Mbps で約 3,200〜4,000 人）である。Context の「約 10 Gbps（約 6,500 人）」はその上の端にあたる。閾値（4 週続けて 10 Gbps）は変えない。[ADR-0001](0001-platform-and-stack.md) を、S1 は AWS で始め、この閾値で Edge を始める形に改めた（Consequences の「ADR-0001 の見直し」への答え）。
  - 移すのは Media Node と TURN だけ。制御の側、Recorder・Transcriber・Composer は AWS に残す。Edge と AWS は Direct Connect でつなぐ（制御の API、Recorder への RTP）。東京の Direct Connect の 100G のポートは 1 時間 22.5 USD（[Direct Connect の料金のデータ（東京）](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDirectConnect/current/ap-northeast-1/index.json)、2026-09-27 に確認）。
  - 準備（S1 の着手時から）：BYOIP の範囲（[ADR-0049](0049-media-node-fleet.md)）、Media Node の構成を AMI と同じ定義からベアメタル向けのイメージも作れる形にする、Media Assignment Service が「場所」（AWS の AZ か Edge か）を Node の属性として扱う。
  - Edge は、AWS の Media Node の代わりではなく、先に使う場所として足す。AWS の Media Node は、Edge の障害と、急な増加の受け皿として残す。
- 2 を採らない理由：大阪に c7gn・c8gn がなく、平時に東京と同じ容量を置く費用が大きい。
- 3 を採らない理由：東京の障害で、会議の予定・参加・録画の参照がすべて止まる。
- b・c を採らない理由：[capacity.md](../architecture/capacity.md) の見積もりでは、S1 の途中で損益の分かれ目を越える。S2 や S3 まで待つと、その間の転送の費用が大きい。

## Consequences

- 良くなること：
  - リージョンの障害の時にも、新しい会議は 1 時間以内に始められる。
  - 転送の費用が大きくなる前に、Edge を用意できる。顧客の規則を変えずに移れる。
- 引き受けるコスト：
  - リージョンの障害で、進行中の会議は途切れ、入り直しが要る。
  - Edge の運用（機器、回線、24 時間の対応）の体制が S1 の間に要る。[ADR-0001](0001-platform-and-stack.md) の「S1 では運用の負担が費用の差に見合わない」という判断と食い違う。ADR-0001 の見直しを Dev（テックリード）に求める。

## Confirmation

- 訓練（四半期、staging）：東京を止めた想定で、大阪の制御の側を昇格し、1 時間以内に大阪で新しい会議に参加できる。
- 訓練（四半期、staging）：1 つの AZ の Media Node を全部止め、全参加者の音声が 5 秒以内に戻る（p95）。
- 毎月の費用の確認：Media Node のピークの送出と、参加者・分あたりの費用（K8）を見て、閾値を超えていないかを Ops が確かめる。
