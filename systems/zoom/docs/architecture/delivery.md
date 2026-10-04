# Delivery: Zoom

変更からマージ、デプロイ、リリースまでの流れ。CI、回線の劣化の試験の基盤（netem のラボ、偽のメディアでブラウザを動かす自動化）、Media Node を会議を落とさずに入れ替える手順（drain と make-before-break）、クライアントのリリースの列車、フラグ。流れの骨格は他の題材と同じ（トランクベース開発、1 回ビルドして昇格、prod は Ops の承認。[リポジトリ共通の ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md)）で、ここにはビデオ会議に固有の部分を書く。

前提となる決定は、メディアに触れる変更に回線の劣化の試験を求める規則（本題材の [AGENTS.md](../../AGENTS.md)）、Media Node の計画した入れ替え（[media-server-sfu.md](media-server-sfu.md) の 10 節、[ADR-0013](../decisions/0013-media-node-failover-and-reattach.md)）、Actor の計画した引き渡し（[signaling-and-meetings.md](signaling-and-meetings.md) の 10.3 節）、シグナリングのバージョンの互換（[ADR-0008](../decisions/0008-signaling-protocol.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0054](../decisions/0054-network-impairment-lab.md) | 回線の劣化の試験は、`media-lab` の EC2 の上で、参加者ごとのネットワークの名前空間と tc netem で作る。各条件を 5 回回して中央値で判定し、`main` の基準との差を PR に載せる。Safari は macOS の dummynet で夜間 |
| [0055](../decisions/0055-media-node-rolling-replacement.md) | Media Node と TURN はその場で更新しない。新しい AMI の台を足し、カナリアの台の会議の SLI を古い台と比べてから、日ごとの波（10 → 25 → 50 → 100%）で古い台を drain する。残った会議は make-before-break で移す |
| [0056](../decisions/0056-client-release-trains-and-meeting-scoped-flags.md) | Web は毎日出せるが、利用者の割合で段階的に広げ、会議の中ではバージョンを変えない。アプリは 2 週ごとの列車。メディアに関わるフラグは開催の開始で Actor が決め、会議の全員と Media Node で揃える。止める向きだけは進行中の会議にもすぐ効かせる |

## 1. 変更からマージまで

- 経路（Story・Epic・Hotfix）と成果物は [docs/process.md](../../../../docs/process.md) に従う。
- 本題材に固有の規則（本題材の [AGENTS.md](../../AGENTS.md)）：
  - メディアに触れる PR は、回線の劣化の試験を通し、遅れ・MOS の推定・フリーズ・受けた解像度と fps・追従の時間を PR に載せる。NFR-001〜003・NFR-009 を下回ったらマージしない。
  - 試験の閾値、回線の条件、試験の時間を変えるときは、QA の承認を先に取る。
  - 未完成の振る舞いは、release フラグの裏に置いてからマージする（6 節）。

## 2. CI

### 2.1 メディアに触れるパス

開発リポジトリの `ci/media-paths.yml` に、次のパスを持つ。どれかに触れた PR は、2.2 節の「メディア」の段が必須になる。

| パス（例） | 中身 |
| --- | --- |
| `packages/media-node/**`、`third_party/mediasoup/**` | Node Agent、mediasoup のフォーク（RED など） |
| `packages/web-client/src/media/**`、`packages/web-client/src/e2ee/**` | mediasoup-client の使い方、符号化の設定、Encoded Transform |
| `packages/media-policy/**` | 層の上限と優先度、音声の `top_n`、帯域の規則（Actor の側） |
| `packages/signaling/src/media/**` | メディアの交渉のメッセージ |
| `infra/media/**`、`images/media-node/**`、`images/turn/**` | セキュリティグループ、AMI の定義、カーネルの設定、coturn の設定 |

### 2.2 PR の CI

| 段 | 中身 | 必須 |
| --- | --- | --- |
| 基本 | lint、型、単体、性質ベーステスト（PROP-SFU-*、PROP-BWE-*、PROP-SIG-* など。PR ごとに 1 万の列）、契約の試験（シグナリングの受けるバージョン（Web は N−1、アプリは N−2）、配布中の Web のバージョンの組） | 全 PR |
| ビルド | コンテナ（制御の側）、mediasoup の worker（arm64 と x86）、Web の資産 | 全 PR |
| セキュリティ | SAST、依存・イメージ・IaC の検査、秘密の走査、Terraform のポリシーの検査（[infrastructure.md](infrastructure.md) の 9.2 節） | 全 PR |
| E2E | Playwright（Chromium）で、参加、音声・映像・共有、再接続、主催者の操作 | 全 PR |
| **メディア** | 3 節のラボで、代表の条件（`loss-20-random`、`bw-step-down`、`rtt-200`、`mixed-3`）を Chrome で。各 5 回、中央値。結果を PR に載せる | メディアに触れる PR |
| メディアのファジング | RTP・RTCP・STUN・RED の剥がしの短いファジング（[security.md](security.md) の 10 節） | `packages/media-node/**`・`third_party/mediasoup/**` |
| E2EE | 暗号文の確認の試験（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)） | `e2ee` に触れる PR |

PR に載せる結果の形（ボットがコメントする）：

```
Media impairment report (Chrome 1xx, 5 runs, median)   base = main@<sha> (7-day median)
| scenario        | audio MOS (ViSQOL) | mos_est | m2e p95 | g2g p95 | freezes>1s/min | adapt time | verdict |
| loss-20-random  | 3.21 (base 3.25)   | 3.30    | 182 ms  | 265 ms  | 0.4            | -          | PASS    |
| bw-step-down    | 4.05               | 4.10    | 150 ms  | 240 ms  | 0.0            | 3.1 s      | PASS    |
```

- 閾値と「基準との差」の許す範囲は [quality.md](../quality.md) の 2.2.1 節にある（QA の承認）。
- ラボの自己診断（netem なしで `mos_est` 4.2 以上）が通らないときは、PR の失敗にせず、基盤の失敗として再実行する（[ADR-0054](../decisions/0054-network-impairment-lab.md)）。

### 2.3 夜間・週次

| 頻度 | 中身 |
| --- | --- |
| 夜間 | 回線の劣化の全部の条件（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 11.1 節、[media-server-sfu.md](media-server-sfu.md) の 12.1 節、[network-traversal.md](network-traversal.md) の 12 節）× Chrome・Edge・Firefox・Safari × 安定版・Beta・Dev。送り手 × 受け手の 4 × 4。性質ベーステストの長い列（100 万）。長いファジング |
| 夜間 | 経路ごとの結合テスト（UDP を落とす、443 だけ、CONNECT のプロキシ、IPv6 だけ） |
| 週次 | 障害の注入（Media Node の停止、worker の `SIGKILL`、Actor Host の停止、Valkey の切り替え、TURN の停止）を `media-staging` で |
| 週次 | iOS・iPadOS の Safari と Android の Chrome の実機 |
| 週次 | 負荷の小さな回し（[capacity.md](capacity.md) の L1 の一部）で、1 台の上限が下がっていないか |

- Beta・Dev のバージョンでの失敗は、ブラウザの回帰の可能性として `browser-release-regression.md`（clients・codecs の領域の提案）の手順で扱う。

## 3. 回線の劣化の試験の基盤

[ADR-0054](../decisions/0054-network-impairment-lab.md)。

### 3.1 構成

```
 media-lab の EC2（x86、1 ジョブ 1 台、一時的なセルフホストのランナー）
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  ns-p1（Chrome、偽のカメラ・マイク）─ veth ─┐                              │
 │  ns-p2（Firefox）───────────────── veth ─┤   ns-wan（ブリッジ）           │
 │  ns-p3（Chrome）────────────────── veth ─┤    各 veth の出口に netem・tbf │
 │                                           │    入りは ifb で同じく        │
 │  ns-sfu（Node Agent＋mediasoup、本番の AMI の中身）── veth ─┤             │
 │  ns-turn（coturn）──────────────── veth ─┘                              │
 │  制御の側（API、Gateway、Actor Host、Valkey、PostgreSQL）はコンテナ       │
 └──────────────────────────────────────────────────────────────────────────┘
```

- 参加者ごとに条件を変えられる（例：`mixed-3` は `ns-p3` の下りだけ 500 kbps）。
- 公開の IP の代わりに、名前空間の IP を Media Node の `announcedAddress` にする。網の規則（`iptables`・`nftables`）で UDP を落とす、443 だけにする、などの経路の条件も作る（[network-traversal.md](network-traversal.md) の 12.1 節）。
- CPU は、ブラウザと Media Node を別のコアに固定する（結果の揺れを減らす）。

### 3.2 条件

- 条件の正本は各領域の試験の表。ラボは、条件を宣言の形（YAML）で持ち、同じ名前で呼ぶ（`loss-20-random`、`loss-20-burst`、`jitter-100`、`bw-step-down`、`bw-half`、`rtt-200`、`uplink-20`、`mixed-3` など）。
- netem の損失の型：ランダム（`loss random`）と、Gilbert-Elliott（`loss gemodel`）（[tc-netem(8)](https://man7.org/linux/man-pages/man8/tc-netem.8.html)、2026-09-27 に確認）。netem は `seed` で損失と破損の乱数の種を固定できる（同じ man page の `SEED`）。ラボの AMI のカーネルと iproute2 で効くことは E1 の `netem-lab-namespaces` で確かめる。効かない場合は 5 回の中央値で揺れを吸収する。
- 帯域の段階の変化（`bw-step-down`）は、試験のスクリプトが時刻に合わせて `tc qdisc change` を送る。

### 3.3 測り方

| 数 | 方法 |
| --- | --- |
| glass-to-glass | 送り手の偽のカメラに、フレームごとの時刻を埋めた合成の映像（Y4M）を入れる。受け手のページで、描画したフレームを `requestVideoFrameCallback` の時に canvas に取り、時刻を読む |
| mouth-to-ear | 送り手の偽のマイクに、印の音（チャープ）を入れる。受け手の音声のトラックを WebAudio の `MediaStreamAudioDestinationNode` で録り、印の時刻を比べる |
| 音声の品質 | 受け手で録った音声と元の音声を ViSQOL v3（speech モード）で比べる。`mos_est` も同時に出す（[observability.md](observability.md) の 4.1 節） |
| フリーズ、解像度、fps、追従の時間 | `getStats`（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 11.2 節） |
| 付け替えの時間 | 障害の注入の時刻から、受け手の音声の最初のパケットまで |

- 送り手と受け手は同じ台なので、時計の同期は要らない。
- 試験の音声・映像は、合成か、利用の条件が明らかな公開のデータセット（例：LibriSpeech、CC BY 4.0）だけ。実在の人の声や顔を使わない。

### 3.4 Safari と実機

- macOS：EC2 の mac のインスタンスか社内の Mac で、`dnctl`・`pfctl`（dummynet）で同じ条件を作り、`safaridriver` で Safari を動かす。夜間。
- iOS・iPadOS、Android：実機を週に 1 回。条件は Wi-Fi のアクセスポイントの側の Linux（netem）で作る。
- Playwright の WebKit は、Safari の代わりにしない（[clients.md](clients.md) の 12 節）。

## 4. デプロイ

### 4.1 環境の昇格

```
制御の側：main → ビルド → dev → staging（E2E、障害の注入の一部）→ prod（Ops の承認）
Media Node・TURN：main → AMI → media-lab（回線の劣化の全部、L1 の負荷）
                 → media-staging（24 時間の合成の会議、障害の注入）→ media-prod（カナリア → 波）
Web：main → ビルド → staging → prod（割合で広げる。5.1 節）
Terraform：plan（ポリシーの検査）→ staging に apply → prod に apply（Ops の承認。security:sensitive は 2 人）
```

- デプロイできる時間：平日 10〜16 時。平日の朝（8〜10 時）の立ち上がりと、月曜の朝は避ける（会議が多い）。Media Node の古い台の強制の移動は、夜間（22〜6 時）。
- 手順は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。

### 4.2 制御の側

| サービス | 方式 | 固有の点 |
| --- | --- | --- |
| API、Assignment、Worker | ECS の blue/green（他の題材と同じ） | — |
| Actor Host | ECS のローリング。止めるタスクの会議を 1 つずつ計画して引き渡す（[signaling-and-meetings.md](signaling-and-meetings.md) の 10.3 節）。`stopTimeout` 120 秒 | 1 回に止めるタスクは全体の 1/6 まで。引き渡しの時間（1 会議あたり）を見て、遅ければ止める |
| Signaling Gateway | ECS のローリング。止めるタスクは、接続を 60 秒かけて少しずつ閉じる（閉じる順を乱数で散らす）。クライアントは待ち（0.5〜10 秒、±20%）の後に `resume` で入り直す | 1 回に止めるタスクは 1 つ（全体の 1/9）。再接続の嵐の兆候（[observability.md](observability.md) の 6 節）で止める |

- シグナリングのスキーマを変えるときは、サーバーを先に出し（新旧の両方を受ける）、Web を後に出す。

### 4.3 Media Node

[ADR-0055](../decisions/0055-media-node-rolling-replacement.md)。

```
新しい AMI ─▶ AZ ごとにカナリア 1 台（新しい会議の 5%）─ 24 時間（平日のピークを含む）で SLI を比べる
   合格 ─▶ 10% の台を足し、同じ数の古い台を draining（1 日目）─ 4 時間比べる
        ─▶ 25%（2 日目）─▶ 50%（3 日目）─▶ 100%（4 日目）
   古い台：会議が自然に終わるのを 4 時間まで待つ → 残りは夜間に make-before-break で移す → 終了
```

- **比べる SLI**：良い音声の分、フリーズのない分、意図しない脱落、付け替えの時間、`worker.died`、転送の遅れ（合成の会議）、ENA の超過。Node の世代（`media.node_generation`）で分けて、同じ時間の古い台と比べる（[observability.md](observability.md) の 5 節）。
- **合格の基準**：[quality.md](../quality.md) の 4.1 節（良い音声の分の差が −0.5 ポイント以内、`worker.died` が 0 など）。
- **make-before-break**：Actor が別の Node に router を作り、`media.reattach{reason: planned, make_before_break: true}` を送る。クライアントは古い transport を残したまま新しい transport を作り、音声の produce・consume ができたら古い consumer を止め、古い transport を閉じる（[media-server-sfu.md](media-server-sfu.md) の 10 節）。途切れの目標は 500ms 以下（**未検証**。E10 の `make-before-break-migration` で測る）。
- **戻す**：新しい台を全部 `draining` にし、古いグループの台数を戻す。重い回帰では、新しい台の会議を make-before-break で古い台へ移す。
- **急ぎ**（重大な脆弱性）：カナリア 1 時間、波は 15 分ごとに 20%、残りはすぐに移す。インシデントの指揮者が判断する。
- Media Node の変更は、Node Agent の TypeScript だけの変更でも、AMI の入れ替えで出す（Node Agent は worker の親なので、再起動で worker も止まる）。

### 4.4 TURN

- 同じ形で、新しい台を足す。参加の応答の ICE のサーバーの一覧から古い台を外し（新しい割り当てを作らせない）、割り当てが 0 になるか 4 時間で終了させる。
- 残った参加者は、古い台が止まると ICE restart で別の TURN へ移る（[network-traversal.md](network-traversal.md) の 10 節）。途切れは数秒（**未検証**。E10 の `turn-rolling-replacement` で測る）。

### 4.5 Terraform

- メディアのセキュリティグループの規則を、動いている台の上で変えない（追跡していないフローがすぐ切れる。[ADR-0016](../decisions/0016-media-edge-addressing-and-security-groups.md)）。規則の変更は、新しい規則を持つ台を 4.3 節の手順で入れ替えて出す。
- BYOIP のプール、IPAM、EIP の確保（`media/ip`）の変更は、Ops の責任者の承認と、顧客への 30 日前の告知（範囲が変わる場合）を要する。

## 5. クライアントのリリース

[ADR-0056](../decisions/0056-client-release-trains-and-meeting-scoped-flags.md)。

### 5.1 Web

| 段 | 割合 | 時間 | 見るもの |
| --- | --- | --- | --- |
| 社内 | 社内の組織だけ | 最短 2 時間 | 参加の成功、JavaScript の例外 |
| 1% | 利用者（`user_id`・端末の鍵のハッシュ） | 4 時間 | バージョンごとの SLI（参加の成功、良い音声の分、フリーズのない分、例外の率） |
| 10% → 50% → 100% | 同上 | それぞれ 4 時間 | 同上 |

- バージョンごとの資産（`/app/<version>/...`）を不変で CloudFront に置く。入口のページは `client-config`（API）が返すバージョンを読む。
- 会議の中ではバージョンを変えない。新しいバージョンは次の参加から。
- **戻す**：割合を 0 にする（次の参加から前のバージョン）。参加できない・音声が出ない重い不具合は、最低のバージョンを上げ、Gateway が古いバージョンの `hello` に `upgrade_required` を返す（会議の途中で読み込み直させるのは、この場合だけ）。
- 同時に動く Web のバージョンは最大 3。契約の試験をその組で回す（2.2 節）。

### 5.2 アプリ（MVP の後）

| 項目 | デスクトップ（Electron） | モバイル（iOS・Android） |
| --- | --- | --- |
| 列車 | 2 週ごと | 2 週ごと |
| 広げ方 | 自前の更新の配信で 1% → 10% → 50% → 100%（1 週） | ストアの段階的な公開。App Store は 7 日で 1% → 2% → 5% → 10% → 20% → 50% → 100%、止められるのは合計 30 日まで（[Release a version update in phases](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/)）。Google Play は割合を選んで手で上げ、止められる（[Release app updates with staged rollouts](https://support.google.com/googleplay/android-developer/answer/6346149)）。いずれも 2026-09-27 に確認 |
| 止める | 配信の停止、前のバージョンへの戻し（`desktop-app-update-rollback.md`、clients の領域の提案） | 段階的な公開の停止。前のバージョンに戻せないので、次のバージョンで直す |
| 最低のバージョン | `client_releases` に持ち、古すぎるバージョンは参加の前に更新を求める | 同じ |

- Electron の Chromium のバージョンは、安定版に 1 か月以内に追いつく（[clients.md](clients.md) の 10 節）。

### 5.3 シグナリングのバージョンの互換

- サーバーは、Web には今と 1 つ前のバージョン（N−1）を、アプリ（MVP の後）には 2 つ前のバージョン（N−2）までを受ける（[ADR-0008](../decisions/0008-signaling-protocol.md) の注記）。バージョンの中では項目を足すだけ。
- 最低のバージョン（`min_client_version`。Web は `client-config`、アプリは `client_releases`）より古いクライアントには、`upgrade_required` で更新を求める（強制の更新）。

## 6. フラグ

[ADR-0056](../decisions/0056-client-release-trains-and-meeting-scoped-flags.md)。配布は AWS AppConfig（Slack の題材の [ADR-0026](../../../slack/docs/decisions/0026-feature-flags.md) の決定を引き継ぐ）。

| 種類 | 評価の単位 | 決める時 | 例 |
| --- | --- | --- | --- |
| release | 組織・利用者 | 要求ごと | 新しい画面、MVP の後の機能 |
| meeting | 開催 | 開催の開始で Actor が評価し、`meeting_instances.effective_flags` と会議の状態に入れる。会議の全員と Media Node が同じ値を使う | `media.red`、`media.svc`、`media.av1`、E2EE の新しい方式 |
| ops | 全体・リージョン・AZ | すぐ。meeting のフラグを止める向きに変えたら、Actor が進行中の会議に配り直す（10 秒以内） | `media.red` の停止、`ops.join_admission`（参加の受付を毎秒の上限で絞る）、`media.ipv6_candidates`、`ops.recording_start`（録画の開始を止める） |
| experiment | 開催 | 開催の開始 | 層の上げ下げの規則の値 |

- Node Agent はフラグを自分で評価しない。値は Actor から会議の状態として受ける（Node が会議の外の状態を読まない。[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）。
- `ops.join_admission` は、再接続の嵐や DR の切り替えの後に、参加の受付を段階的に開くために使う（[runbooks/incident-response.md](../runbooks/incident-response.md)、[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)）。
- フラグを消すまでの期限を作るときに決める（release 90 日、experiment 30 日）。期限を過ぎたフラグを CI が毎週警告する。

## 7. ホットフィックス

- 他の題材と同じ（`main` で直し、同じ流れを短くして出す）。
- Media Node のホットフィックスも AMI の入れ替えで出す。4.3 節の「急ぎ」の手順。メディアの試験（2.2 節の「メディア」の段）は省かない。
- Web のホットフィックスは、5.1 節の段を 1 時間ずつに縮めてよい。

## 8. 指標

| 指標 | 目標（案） |
| --- | --- |
| PR の「メディア」の段の時間（p50） | 25 分以内（**未検証**。E1 の `media-paths-and-required-checks` で実測して見直す） |
| ラボの揺れ（同じコミットで判定が変わる割合） | 5% 以下 |
| Media Node の全体の入れ替えの日数 | 5 日（急ぎは 1 日） |
| 入れ替えで make-before-break で移した参加者の割合 | 20% 以下（大半は自然に終わるのを待つ） |
| Web の変更から 100% までの時間 | 1 日 |
| デプロイによる SLO の消費 | 月のエラーバジェットの 25% 以下 |

## 9. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `media-paths-and-required-checks` | 2.1・2.2 節。パスの一覧と必須の段 |
| E1 | `netem-lab-namespaces` | 3.1〜3.3 節。名前空間、netem・tbf・ifb、条件の宣言、測り方 |
| E1 | `pr-media-report-bot` | 2.2 節の結果のコメントと、`main` の基準 |
| E1 | `web-release-percentage` | 5.1 節。バージョンの資産、`client-config`、割合、バージョンごとの SLI |
| E1 | `meeting-scoped-flags` | 6 節。`effective_flags`、ops のフラグの配り直し |
| E2 | `safari-dummynet-nightly` | 3.4 節 |
| E2 | `gateway-gradual-drain` | 4.2 節の Gateway の少しずつ閉じる手順 |
| E10 | `media-node-canary-and-waves` | 4.3 節。世代の重み、SLI の比較、波の自動化 |
| E10 | `make-before-break-migration` | 4.3 節（sfu の領域の `node-drain-mbb` と一緒に） |
| E10 | `turn-rolling-replacement` | 4.4 節 |

## 10. 未解決の問い

### 決定

2026-09-27 に推奨案で確定した（[README.md](README.md) の 6 節の「決定（2026-09-27、推奨案で確定）」）。

- ラボは `media-lab` の EC2 の名前空間と netem。5 回の中央値（ADR-0054）。
- Media Node はカナリアと日ごとの波（ADR-0055）。
- Web は割合で広げ、会議の中ではバージョンを変えない。meeting のフラグは開催の開始で揃える（ADR-0056）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| netem の `seed` がラボの AMI のカーネルで効くか | E1 の `netem-lab-namespaces` |
| PR の「メディア」の段の時間と費用 | E1 の `media-paths-and-required-checks` で測る。長ければ条件を 2 つずつの組に分けて並べる |
| mac のインスタンスの費用と、社内の Mac との使い分け（mac のインスタンスは Dedicated Host の最低の割り当てが 24 時間） | E2 の `safari-dummynet-nightly` |

## 11. quality.md・runbooks への項目

### quality.md

- 2.2 節の「メディア」の段の条件、閾値、`main` の基準との差の許す範囲。
- 3 節のラボの揺れの確認（同じコミットで 20 回）の結果。
- 4.3 節のカナリアの合格の基準。
- make-before-break の途切れの分布。

### runbooks

- [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)：制御の側、Media Node、TURN、Web、Terraform の手順と戻し方（この文書と一緒に書いた）。
- `netem-lab-broken.md`：ラボの自己診断が失敗し続けるときの確かめ方（台の種類、カーネル、ブラウザのバージョン）。
- `stale-flags.md`：期限を過ぎたフラグの整理。
