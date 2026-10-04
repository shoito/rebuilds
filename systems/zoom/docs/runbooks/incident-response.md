# Runbook: インシデント対応

- Owner: Ops
- 対応するアラート: すべての呼び出し（page）のアラート（[observability.md](../architecture/observability.md) の 6 節）。個別の場面は「ビデオ会議に固有の場面」の節
- 最終確認日: 2026-09-27

個別の手順（[deploy-and-rollback.md](deploy-and-rollback.md)、[disaster-recovery.md](disaster-recovery.md)）の上に立つ、共通の進め方と、ビデオ会議に固有の場面（Media Node の障害の波、TURN の過負荷、メディアの IP への DDoS、シグナリングの再接続の嵐、内容・秘密の出力）。進め方の骨格は他の題材（Auth0 などの incident-response.md）と同じ。

## 症状

次のどれかのときに、インシデントを宣言する。迷ったら宣言し、後で重さを下げる。

- 呼び出しのアラートが鳴った
- 組織や社内から、会議に入れない・音声が途切れる・会議が落ちる・知らない人が入った・録画が見えない、という報告が来た
- 内容・秘密の出力の走査で検出した、監査ログの連鎖の検証が失敗した、メディアの受信の急増を検知した

## 影響

### 重さ（severity）

| 重さ | 基準 | 例 | 最初の応答 | 告知 |
| --- | --- | --- | --- | --- |
| SEV1 | 全体で新しい参加ができない。進行中の会議の多く（10% 以上）の音声が止まった・落ちた。他の組織の会議・録画が見えた。E2EE の約束が破れた（鍵がサーバーに出た）。会議の内容の漏えいが確定した | リージョンの障害、Media Node の障害の波が止まらない、大規模な DDoS | 5 分以内 | 30 分以内に組織へ。以後 30 分ごと |
| SEV2 | 一部の参加・会議が影響を受ける（1 つの AZ、一部の網、TURN の経路、一部のブラウザ）。SLO の速いバーンレート。1 件でも内容・秘密の出力。DDoS で防御のモードを入れた | AZ の障害、TURN の過負荷、再接続の嵐、Valkey の切り替え | 15 分以内 | 1 時間以内に組織へ（影響があれば） |
| SEV3 | 劣化しているが、回避できる | 字幕の遅れ、録画の合成の遅れ、1 台の Media Node の ENA の超過 | 営業時間内 | 必要なら |
| SEV4 | 利用者への影響がない | 1 つの Worker の失敗の増加 | 営業時間内 | なし |

**会議の内容・他の組織のデータ・E2EE の約束に関わるものは、範囲が 1 件でも SEV2 以上にする。**

- 平日の朝（8〜10 時）と、大きな会議（全社の集会、決算の説明）の時間は、同じ事象でも影響が大きい。重さを 1 段上げて考える。

## 確認

1. どのアラート・報告から始まったかを記録する。
2. 影響の範囲を見る：全体か、特定の AZ・Node・Node の世代・TURN の台・ブラウザ・経路（`ice_path`）・組織か。参加（新しい会議）か、進行中の会議のメディアか、制御（主催者の操作）か。
3. 直近の変更を見る：デプロイ（制御の側、Media Node の AMI の波、TURN、Web のバージョンの割合）、フラグ、Terraform（セキュリティグループ、Shield）、ブラウザの新しいバージョンの配布。
4. セキュリティへの影響を見る：内容・秘密の走査、GuardDuty、メディアの受信の急増、TURN の拒否の急増、報告（`abuse_reports`）の急増。

**調べるときに、会議の内容を取り出さない。** 録画を開かない（組織の許可があるときを除く）。Media Node のパケットの取得はヘッダーまで（`tcpdump -s 96`）、7 日で消す（[ADR-0047](../decisions/0047-keys-and-operator-access-to-media.md)）。`media-prod` のシェルは、指揮者の承認を記録してから使う。

## 対処

### 役割

| 役割 | 担う人 | 責任 |
| --- | --- | --- |
| 指揮者（IC） | 最初に応答したオンコール。SEV1 では Ops の責任者に引き継いでよい | 重さ、方針、大きな判断（Node の一斉の drain、リージョンの切り替え、参加の受付の制限、Shield の保護の追加） |
| 作業者 | オンコールの Ops、呼ばれた Dev（メディア、シグナリング） | 調査と復旧 |
| セキュリティの担当 | セキュリティの当番 | DDoS、内容の漏えい、他の組織のデータ、E2EE に関わる判断、証拠の保全、法務への連絡 |
| 連絡係 | IC が指名する（PM が望ましい） | 組織、社内、AWS（SRT を含む）への連絡 |
| 記録係 | IC が指名する | 時刻付きの記録 |

SEV1 では、指揮者は手を動かさない。

### 進め方

1. **宣言する。** インシデント用の場を、本システムと別の道具に作る（本システムの会議が止まっていても使える場所）。
2. **被害を止めることを、原因の特定より優先する。** 順番：
   - 直近の変更のフラグを切る（ops のフラグは進行中の会議にも 10 秒以内に届く。[delivery.md](../architecture/delivery.md) の 6 節）
   - 直近のデプロイを戻す（[deploy-and-rollback.md](deploy-and-rollback.md)。Media Node は新しい世代を `draining` に）
   - 問題の Node・TURN の台を `draining` にし、会議を別の Node へ移す
   - 参加の受付を絞る（`ops.join_admission`）
   - 容量を増やす（Media Node、TURN、Gateway）
3. **証拠を消さない。** 監査ログ、Node の状態（止める前に `inventory` とメトリクスを保全する）、ENA の数、Firehose の品質の記録は、調査の材料である。**秘密の値（パスコード、参加の鍵、トークン）と会議の内容を、チケット・チャット・この記録に写さない。** 場所と件数と識別子だけを書く。
4. 30 分ごとに状況を更新する（SEV1・SEV2）。

## ビデオ会議に固有の場面

### Media Node の障害の波

**症状**：`dead` の Node が 10 分に 2 台以上。`media.reattach` を受けた参加者が 5 分に 2,000 人を超える。付け替えの時間の SLO（5 秒）の悪化。

1. **共通の原因を探す。** 落ちた Node に共通するものを見る：
   - Node の世代（`media.node_generation`）：新しい AMI の波の途中なら、まず波を止め、新しい世代を全部 `draining` にする（[deploy-and-rollback.md](deploy-and-rollback.md) の「Media Node を戻す」）。
   - AZ：1 つの AZ に偏るなら、AZ の障害として [disaster-recovery.md](disaster-recovery.md) の A に移る。
   - `worker.died` の急増：mediasoup の worker の不具合。同じ会議の形（大人数、画面共有、特定のブラウザ）に偏るかを見る。偏るなら、関係するフラグ（`media.red`、`media.svc`、`media.av1`）を切る。
   - ENA の `*_allowance_exceeded`：網の上限に当たって心拍が落ちている。攻撃なら下の「メディアの IP への DDoS」。負荷なら空きの不足（下の 4）。
   - 付け替えの先で連鎖していないか：予備の Node が溢れて、次々に落ちる。
2. **連鎖を止める。** 付け替えの先が溢れているときは、Media Assignment Service で、点が 0.85 を超える Node を新しい会議の候補から外す（点の上限を一時的に 0.6 に下げる）。予備の Node は会議ごとに無作為に選ばれるが、生きている Node が少ないと偏る。
3. **新しい参加を守る。** 生きている Node の空きが足りなければ、`ops.join_admission` で新しい参加の受付を絞り、進行中の会議の付け替えを先にする。
4. **容量を足す。** Auto Scaling の最小を上げる。ウォームプールを使い切ったら、予備の種類（c7gn.16xlarge）に切り替える（`ec2-capacity-shortage.md`、infrastructure の領域の提案）。
5. **戻ったことを確かめる。** 付け替えの時間の分布、`dead` の Node の数、良い音声の分。落ちた Node は、ログとメトリクスを保全してから終了させる。
6. 事後：worker の異常終了の再現（`trace` のイベント。ペイロードなし）、上流への報告（`mediasoup-worker-died.md`、sfu の領域の提案）。

### TURN の過負荷

**症状**：TURN の台の CPU 70%、中継の帯域が 1 台 2 Gbps、割り当ての数が平常の 3 倍のどれかが 5 分続く。TURN を通る参加者（`ice_path` が `turn_*`）の良い音声の分の悪化、参加の失敗の増加。

1. **正当な増加か、悪用かを分ける。**
   - 正当：特定の組織（大企業の社内の網）の大きな会議、平日の朝の立ち上がり。割り当ての数は参加者の数に比例する。
   - 悪用：割り当ての数に比べて、参加者（`participant_id`）が少ない。拒否した `CreatePermission` の急増。1 つの `participant_id` の資格情報が、多くの送信元の IP から使われる。→ 下の「悪用」。
2. **台を足す。** TURN の Auto Scaling の最小を上げる。新しい台を参加の応答の ICE のサーバーの一覧に入れる（次の参加から使われる）。
3. **重みを変える。** 過負荷の台を一覧から外す（新しい割り当てを作らせない）。既存の割り当ては残る。
4. **AZ の偏り**：クライアントには、Media Node と同じ AZ の 1 台と、別の AZ の 1 台を渡している（[ADR-0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md)）。1 つの AZ の Media Node に会議が偏ると、その AZ の TURN も偏る。Media Assignment Service の AZ の重みを見る。
5. **戻らないとき**：TLS 443 の経路だけが重いなら、TLS の処理の CPU が原因の可能性がある。台の種類を上げる（E7 の値を見直す）。

**悪用**：

1. 悪用の疑いの `participant_id` と、その会議を特定する（`turn:{node_id}:load` と coturn のログ。IP は 30 日で消える）。
2. 資格情報は 12 時間は取り消せない（HMAC の形。[ADR-0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md)）。中継の先は Media Node だけなので、会議の外への被害はない。台の帯域の消費が問題なら、coturn の `--max-bps` と `--user-quota` を下げた設定を新しい台で出す（動いている台の設定を変えない）。
3. 広く悪用されている（秘密の漏えいの疑い）なら、TURN の静的な秘密を入れ替える（`turn-secret-rotation.md`、network の領域の提案）。入れ替えの間は、今と次の 2 つを受ける。
4. セキュリティの担当に知らせ、プラットフォームの監査に記録する。

### メディアの IP への DDoS

**症状**：Media Node・TURN の受信の pps が平常の 5 倍。ICE を通らない送信元からの受信が全受信の 30% を超える。`pps_allowance_exceeded`・`bw_in_allowance_exceeded` の増加。攻撃を受けた Node の会議の音声の途切れ。

方針は [ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md)、[security.md](../architecture/security.md) の 8.3 節。**SEV2 から始める。** セキュリティの担当を呼ぶ。

1. **範囲を見る。** 1 台か、/24 の範囲の全体か。IPv4 か IPv6 か。UDP か、TCP（ICE-TCP、TLS 443）か。どの AZ か。
2. **防御のモードを入れる。** 攻撃を受けた Node で `under_attack` にする（Media Assignment Service の運用の API、または Node の状態の変更）。ICE を通った送信元だけを通し、STUN の Binding は毎秒の上限つきで通す。新しい会議はその Node に置かれなくなる。防御のモードの Node は IPv6 の候補を出さなくなる（Shield Advanced が IPv6 を守れないため。IPv6 でつながっていた参加者は ICE restart で IPv4 へ移る。[ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md) の注記）。
3. **Shield Advanced の保護を加える。** 攻撃を受けた範囲の EIP を保護に加える（`global/edge` ではなく、運用の手順のスクリプトで。追加はプラットフォームの監査に残す）。AWS サポート（Business 以上）でケースを開き、SRT に連絡する。**IPv6 は Shield Advanced で守れない。**
4. **会議を逃がす。** 防御のモードでも `pps_allowance_exceeded` が増える Node は、`draining` にし、会議を別の Node へ make-before-break で移す（Actor に `media.reattach{reason: planned, make_before_break: true}` を出させる）。移し先が同じ /24 の中で攻撃が範囲の全体なら、移しても効かない。その場合は 5 へ。
5. **範囲の全体への攻撃**：
   - 大阪の Media Node（別の /24）へ新しい会議を寄せる（S1 では大阪の台数が少ない。受けられる数を超えるなら `ops.join_admission` で新しい参加を絞る）。
   - IPv6 だけが攻撃されているなら、`media.ipv6_candidates` を切る（次の ICE から IPv4 だけ）。
   - 攻撃が TURN の TLS 443 に向くなら、TURN の台を足し、`*.turn.<brand>.<domain>` の名前の DNS を新しい台へ向ける。
6. **攻撃を受けた EIP を隔離する。** 会議がなくなった Node から EIP を外し、`quarantined_until`（既定 7 日）のタグを付ける。EIP のプールの空きを見る（`eip-pool-exhausted.md`、infrastructure の領域の提案）。
7. **止んだら戻す。** 24 時間、攻撃の兆候がなければ、防御のモードを外し、Shield Advanced の保護を外す（転送の料金がかかり続けるため。[ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md)）。
8. 事後：攻撃の規模、防御のモードで捨てた数、移した会議の数、途切れの長さを記録する。会議の移動による途切れを組織へ告知する。

### シグナリングの再接続の嵐

**症状**：Gateway の新しい接続が 1 分に平常の 5 倍。`resume` の失敗が 5% を超える。Actor Host のイベントループの遅れ、Valkey の CPU の上昇。参加者の画面に「再接続中」。

1. **きっかけを探す。**
   - Gateway の入れ替え（デプロイ）：デプロイを止める。止めるタスクの接続を少しずつ閉じる手順が効いているかを見る（[delivery.md](../architecture/delivery.md) の 4.2 節）。
   - CloudFront・ALB の変更、証明書の更新、WAF の規則の誤り（正当な `Upgrade` の要求を落としていないか）。
   - 網の瞬断（AWS の側、大きな ISP の側）：`ice_path` や組織の偏りを見る。
   - Actor Host・Valkey の障害：`epoch` が全会議で上がっていれば、Valkey の切り替え（`valkey-failover-meetings.md`、signaling の領域の提案）。
2. **メディアは止まっていないことを確かめる。** WebSocket が切れても、流れているメディアは続く（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）。良い音声の分が保たれているなら、急ぐのは制御の回復である。
3. **再接続を散らす。**
   - `ops.join_admission` で、新しい参加の受付を毎秒の上限で絞り、既存の参加者の `resume` を先にする。
   - クライアントの再接続の待ちの上限を、`client-config` で引き上げる（例：最大 10 秒 → 30 秒）。次の再接続から効く。
   - Gateway のタスクを足す（接続の数の上限に余裕を作る）。
4. **スナップショットの集中**：差分が古すぎてスナップショットの送り直しが多いときは、Actor Host の CPU が上がる。Actor Host のタスクを足す。
5. **戻ったことを確かめる**：新しい接続の率、`resume` の成功率、制御の回復の SLI。上げた再接続の待ちを戻す。

### 内容・秘密の出力

**症状**：ログ・トレースの走査で、パスコード・参加の鍵・トークンの形、チャットの本文の形の文字列を検出した。

1. **SEV2。** セキュリティの担当を呼ぶ。
2. 出力しているコードの経路を特定し、フラグで止めるか、デプロイを戻す。
3. 出力したログのグループ・期間を特定し、該当のログを消す（CloudWatch Logs の該当のストリーム、log-archive の該当のオブジェクト。Object Lock のものは、セキュリティの担当と法務の判断で扱う）。消した範囲と件数をプラットフォームの監査に残す。
4. 秘密（パスコード、参加の鍵、トークン）が出たなら、該当の会議の参加の鍵とパスコードを作り直す手順を、主催者へ案内する。トークンは期限（120 秒）で失効している。
5. 会議の内容（チャットの本文など）が出たなら、通信の秘密の侵害のおそれとして、法務へ知らせる（[security.md](../architecture/security.md) の 12 節）。

## エスカレーション

- SEV1、または 30 分で戻る見込みが立たない SEV2 → Ops の責任者と Dev のテックリードを呼ぶ。
- Media Node の障害の波が mediasoup の不具合に見える → メディアの Dev の当番。上流（mediasoup）への報告の準備。
- DDoS → セキュリティの担当。AWS サポート（SRT）。
- 他の組織のデータ・会議の内容の漏えい、E2EE の約束の破れ → セキュリティの担当と法務。個人情報保護委員会への報告と、電気通信事業法の上の扱いは法務が判断する（[security.md](../architecture/security.md) の 12 節）。
- AWS 側の障害 → AWS サポートにケースを開く。

## 事後

- ポストモーテムを 5 営業日以内に書く（責めない形）。時刻の記録、影響（落ちた参加者の数、途切れの長さの分布、SLO の消費）、原因、効いた対処と効かなかった対処。
- 調査結果を Intent の Issue として起票する（Maintain 段）。
- この runbook と、関係する領域の runbook で足りなかったことを反映する。
- 同じ間違いを 2 回したら、該当する AGENTS.md に規則として追記する（ルートの [AGENTS.md](../../../../AGENTS.md)）。
