# Runbook: デプロイとロールバック

- Owner: Ops
- 対応するアラート: 制御の側の blue/green の自動の戻し、Media Node のカナリアの不合格、Web の版の悪化、デプロイの後の SLO のバーンレート（[observability.md](../architecture/observability.md) の 6 節）
- 最終確認日: 2026-09-27

流れは [delivery.md](../architecture/delivery.md)、Media Node の入れ替えは [ADR-0055](../decisions/0055-media-node-rolling-replacement.md)、クライアントとフラグは [ADR-0056](../decisions/0056-client-release-trains-and-meeting-scoped-flags.md)、Terraform の配置は [infrastructure.md](../architecture/infrastructure.md) の 9 節にある。

## 症状

次のときに使う。

- 本番（prod・media-prod）へデプロイするとき（制御の側、Media Node の AMI、TURN、Web、Terraform）
- デプロイの後に、参加の成功、良い音声の分、フリーズのない分、付け替えの時間、制御の回復が悪化したとき
- Media Node のカナリアの比較が不合格になったとき

## 影響

- 通常のデプロイ：利用者への影響はない。Media Node の入れ替えで make-before-break で移された参加者は、数百 ms の途切れを受けうる。
- 失敗したデプロイ：
  - 制御の側：参加できない、主催者の操作が効かない。**流れているメディアは止まらない**（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）。
  - Media Node：新しい世代の台の会議で、音声の途切れ・映像の停止・会議の脱落。
  - Web：新しい版で参加した人だけ。会議の中では版は変わらない。
- **メディアの回帰は、5xx にならず、品質の SLI の悪化として現れる。** 見るのは、Node の世代・Web の版ごとの SLI である。

## 確認

### デプロイの前

1. 対象のコミットが staging・media-staging で確かめ済み。メディアに触れる変更なら、回線の劣化の試験の結果が PR にあり、閾値を満たしている。Media Node の AMI なら、media-staging の 24 時間の合成の会議が通っている。
2. デプロイできる時間である（平日 10〜16 時。平日の 8〜10 時と月曜の朝は避ける。金曜の 15 時以降と年末年始は修正だけ）。組織から知らされた大きな会議（全社の集会、決算の説明）の時間帯でない。
3. シグナリングのスキーマを変えるなら、サーバーが新旧の両方を受ける版が先に本番にある。Web を先に出さない。
4. Aurora のマイグレーションが expand だけか。contract を含むなら、1 つ前のリリースで参照をやめていること。
5. SLO のダッシュボードで、エラーバジェットが残っている。進行中のインシデント、DDoS、Media Node の障害の波がない。
6. `security:sensitive`（KMS、セキュリティグループ、WAF、Shield）を含むなら、2 人の承認がそろっている。
7. Media Node の入れ替えなら、BYOIP のプールの空きが、足す台の数より多い。EC2 の vCPU の上限に余裕がある。

### デプロイの後（入れ替えが終わってから 15 分。Media Node は各波の後 4 時間）

| 見るもの | 正常 | 異常 |
| --- | --- | --- |
| 参加の成功（全体・Web の版ごと） | デプロイの前と同じ | 0.5 ポイント以上下がる |
| 参加の速さ p95 | 3 秒以内 | 0.5 秒以上伸びる |
| 良い音声の分（Node の世代ごと） | 古い世代との差が許す範囲（quality.md） | 許す範囲を超える |
| フリーズのない分（同上） | 同上 | 同上 |
| `worker.died`（新しい世代） | 0 | 1 以上 |
| 付け替えの時間、制御の回復 | SLO の中 | SLO を外れる |
| ENA の `*_allowance_exceeded`（新しい世代） | 0 | 増える |
| Gateway の再接続の率 | 平常 | 平常の 3 倍 |
| JavaScript の例外の率（Web の版ごと） | 前の版と同じ | 2 倍 |

## 対処

### 制御の側（API、Gateway、Actor Host、Assignment、Worker）

1. GitHub Actions の prod のデプロイを、Ops が承認する。
2. API・Assignment・Worker は blue/green。自動の戻しの条件（5xx、SLO のバーンレート）で戻る。
3. **Actor Host** はローリング。止めるタスクの会議を 1 つずつ引き渡す（[signaling-and-meetings.md](../architecture/signaling-and-meetings.md) の 10.3 節）。1 回に止めるのは全体の 1/6 まで。引き渡しの 1 会議あたりの時間が 1 秒を超え続けたら止める。
4. **Gateway** はローリング。1 回に止めるのは 1 タスク。止めるタスクは接続を 60 秒かけて少しずつ閉じる。再接続の率が平常の 3 倍を超えたら止める（[incident-response.md](incident-response.md) の「シグナリングの再接続の嵐」）。

**戻す**：

- API・Assignment・Worker：前のタスク定義に戻す（blue/green の切り戻し）。
- Actor Host・Gateway：前のタスク定義で同じローリングを行う。急ぐときも、1 回に止める数の上限を守る（一度に全部を止めると、全会議の制御が止まり、再接続の嵐になる）。
- マイグレーションは戻さない。expand だけなので、古いコードで動く。

### Media Node

[ADR-0055](../decisions/0055-media-node-rolling-replacement.md)。

1. **カナリア**：`media/fleet` で、新しい起動テンプレートの版の Auto Scaling グループ（緑）を AZ ごとに作り、各 1 台を起動する。Node Agent が `active` になったら、Media Assignment Service で緑の世代の重みを 5% にする。
2. **比べる**：平日のピークを 1 回含む 24 時間、上の表の Node の世代ごとの SLI を比べる。
3. **波**：合格したら、1 日 1 回、10% → 25% → 50% → 100% の台を緑に足し、同じ数の青（古い世代）の台を `draining` にする。各波の後 4 時間比べる。
4. **古い台の片付け**：`draining` の台は、会議が自然に終わるのを 4 時間まで待つ。残った会議は夜間（22〜6 時）に make-before-break で移す（運用の API で Node を指定）。会議が 0 になった台を終了させる。EIP はプールへ戻る。
5. 全部の台が緑になったら、青のグループを消す。

**Media Node を戻す**：

1. 緑の世代の重みを 0 にし、緑の台を全部 `draining` にする。
2. 青のグループの台数を戻す（青のグループを消していなければ、最小を上げるだけ）。
3. 回帰が軽い（映像の品質の低下など）なら、緑の台の会議は自然に終わるのを待つ。
4. 回帰が重い（音声の途切れ、`worker.died`、会議の脱落）なら、緑の台の会議を make-before-break で青の台へ移す。移すのは会議の小さいものから（途切れの影響を小さく）。
5. 戻した後、原因の AMI を「使わない」印にする（Image Builder の版に印）。

**急ぎ（重大な脆弱性）**：カナリアを 1 時間にし、波を 15 分ごとの 20% にする。青の台の会議はすぐに make-before-break で移す。指揮者の判断で行い、組織へ「短い途切れが起きうる」と告知する。

### TURN

1. 新しい TURN の台を足す（同じ手順で緑のグループ）。
2. 参加の応答の ICE のサーバーの一覧を、緑の台に切り替える（次の参加から）。`*.turn.<brand>.<domain>` の名前の DNS を緑へ向ける。
3. 青の台は、割り当てが 0 になるか 4 時間で終了させる。残った参加者は ICE restart で緑へ移る。
4. **戻す**：一覧と DNS を青に戻す。緑の台を同じ手順で片付ける。

### Web クライアント

1. 社内の組織だけに出す（`client-config` の対象）。2 時間、例外と参加の成功を見る。
2. 1% → 10% → 50% → 100%。それぞれ 4 時間、版ごとの SLI を比べる。
3. **戻す**：`client-config` の割合を 0 にする。次の参加から前の版になる。
4. **重い不具合（参加できない、音声が出ない）**：最低の版を上げる。Gateway が古い版の `hello` に `upgrade_required` を返し、クライアントは読み込み直す。会議の途中の人も読み込み直すので、影響を連絡係が告知する。

### フラグ

- 止める向きの変更（ops のフラグ）：AppConfig で変える。進行中の会議に 10 秒以内に届く。変えたことをインシデントの記録か変更の記録に残す。
- 有効にする向きの変更（meeting のフラグ）：次の開催から効く。割合で広げ、Web と同じく SLI を比べる。

### Terraform

1. plan のポリシーの検査を通す（[infrastructure.md](../architecture/infrastructure.md) の 9.2 節）。
2. staging・media-staging に apply してから、prod・media-prod に apply する。
3. **Media Node・TURN のセキュリティグループを、動いている台の上で変えない。** 規則を変えるときは、新しい規則を持つ台を上の Media Node の手順で入れ替える（追跡していないフローは規則の変更ですぐ切れる。[ADR-0016](../decisions/0016-media-edge-addressing-and-security-groups.md)）。
4. `media/ip`（BYOIP、IPAM、EIP のプール）の変更は、Ops の責任者の承認を取る。範囲が変わるなら、顧客への 30 日前の告知が済んでいる。
5. **戻す**：前のコミットの plan を apply する。状態を持つ資源の削除・置き換えは CI で拒否されるので、手での操作が要るときは Ops の責任者の承認を取る。

## エスカレーション

- 戻しても SLI が戻らない → [incident-response.md](incident-response.md) に移り、SEV を宣言する。
- Media Node の戻しで、青の台の容量が足りない → Ops の責任者。予備の種類（c7gn.16xlarge）での起動、`ops.join_admission`。
- Actor Host・Gateway のローリングで制御の回復の SLI が外れた → Dev のテックリード（シグナリング）。

## 事後

- 戻したデプロイは、原因と、なぜ staging・media-staging・カナリアで見つからなかったかを記録する。
- Media Node の回帰なら、回線の劣化の試験の条件に、その回帰を捉える条件を足す（quality.md の変更として QA の承認を取る）。
- この手順で足りなかったことを、ここに反映する。
