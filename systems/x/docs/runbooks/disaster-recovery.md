# Runbook: 災害復旧（AZ の障害、大阪への切り替え、東京へ戻す、訓練）

- Owner: Ops
- 対応するアラート: AZ の障害（複数のサービスで 1 つの AZ のターゲットが不健全）、大阪からの合成監視の連続失敗、`AuroraGlobalDBRPOLag` の 10 秒の超過、大阪の待機の確かめの失敗、訓練（staging 四半期、本番の switchover 年 1 回）
- 最終確認日: 2026-10-04

構成は [infrastructure.md](../architecture/infrastructure.md) の 7 節、方針は [ADR-0056](../decisions/0056-disaster-recovery-osaka.md) にある。目標は NFR-005（AZ：RPO 0・RTO 5 分、リージョン：RPO 1 分・RTO 1 時間）。合格基準は [quality.md](../quality.md) の 2.4 節。

**最重要の規則：大阪では生成器の番号 512〜1023 だけを使う。** 大阪の Post・DM・Accounts・Media のタスクが 0〜511 を借りていたら、書き込みを開かない。範囲で分けることが、失った範囲の `tid` との重なりを防ぐ要である（[ADR-0002](../decisions/0002-post-ids-and-ordering.md)）。

## 症状

| 場面 | 見え方 |
| --- | --- |
| A. AZ の障害 | 1 つの AZ のタスク・Aurora のインスタンス・Valkey のノードが不健全。Gateway の接続が 3 分の 1 切れる |
| B. リージョンの障害 | 東京の App API・Public API・Gateway が応答しない。大阪からの合成監視は大阪の ALB へ成功し、東京へは失敗 |
| C. 複製の遅延 | `AuroraGlobalDBRPOLag` が 10 秒を超え続ける（東京は正常） |
| D. 訓練 | 計画 |

## 影響

- A：数十秒、投稿・フォロー・DM の書き込みが失敗する。クライアントは同じ `client_request_id`・`client_msg_id` で再送する。確定を失わない。`vk-timeline` のレプリカの昇格の間、読み出しは作り直しに回る。
- B：切り替えまで（目標 1 時間以内）、全部の読み書きが止まる。切り替えの後は次のとおり。
  - 複製の遅延ぶん（RPO 1 分以内）の確定を失う。「確定」を返した投稿が消えうる。
  - 送ったが東京の Kinesis で消費されなかった出来事は、送った outbox の行（1 時間残す）から送り直す。消費者は冪等なので重複はよい。
  - 閲覧の出来事と SQS の仕事は失う。fan-out の仕事は送り直した出来事から作り直される。
  - Valkey の写しは空から作り直す。最初の読み出しが遅く、ホームが短い（`partial`）利用者がいる。
  - 検索は最大 4 時間止まる（スナップショットからの戻し）。タイムラインと投稿には影響しない。
  - 送ったプッシュ・メールは取り消せない。

## 確認

1. AWS Health Dashboard と Grafana の AZ ごとの内訳で、1 つの AZ か、リージョン全体かを見分ける。
2. Aurora のクラスタのイベントで、フェイルオーバーの有無と今の writer の AZ を確かめる。
3. リージョンの障害を疑うときは、大阪の合成監視と、別の回線からの到達性の両方で確かめる。
4. **`AuroraGlobalDBRPOLag` の直近の値と、東京が応答しなくなった時刻を記録する。** 失った範囲の目安になる。
5. 大阪の待機の確かめ（[infrastructure.md](../architecture/infrastructure.md) の 7.7 節）が直近で正常か。

## 対処

### A. AZ の障害

基本は自動で回復する。

1. インシデントを宣言する（SEV2 から。[incident-response.md](incident-response.md)）。
2. Aurora が別の AZ へ自動でフェイルオーバーしたことを確かめる。5 分たっても writer がなければ、手でフェイルオーバーする。
3. `tid` の生成器の貸し出しが延ばせずに、投稿が `503 id_unavailable` になっていないかを見る（[posts-and-ids.md](../architecture/posts-and-ids.md) の 8.3 節）。writer が戻れば自動で回復する。
4. Valkey のレプリカの昇格を確かめる。`timeline.rebuild_rate` が上限に張り付くなら、`timeline-rebuild-storm.md` に従う。
5. Gateway の再接続が残る 2 AZ に散って戻るか（0〜30 秒の乱数の待ち）を見る。
6. AZ が回復したら、台数を平常に戻す。

### B. リージョンの障害（東京 → 大阪）

**切り替えの判断は、インシデントの指揮者（IC）と Ops の責任者が行う**（[roadmap.md](../roadmap.md) の「エージェントに任せないこと」）。AWS の見込みで 30 分以内に回復しそうなら、待つことも選ぶ。

1. SEV1 を宣言し、ステータスページで告知する。
2. **東京の書き込みを止める**（届けば `ops.writes_enabled = false`）。届かなくても次へ進む。
3. 失った範囲を記録する（「確認」の 4）。
4. 「DR：大阪を有効化」のワークフローを大阪で起動する。ワークフローは次を順に行う。止まったら、止まった段から手で続ける。
   1. 大阪の Aurora を昇格する（`failover --allow-data-loss`）。
   2. 大阪のサービスを広げる。Post・DM・Accounts・Media のタスクが **512〜1023 の番号だけ** を借りたことを `tid_generator_leases` で確かめる。
   3. **フォロワーの多い作者の `ar:` を先に作る。** フォロワー 1,000 人以上の作者と `fanout:pull_any` の作者の `ar:` を、Aurora の `(author_id, id DESC)` から 7 日ぶん作る。東京の Kinesis は読めないので、流れの読み直しは使わない（[ADR-0016](../decisions/0016-timeline-rebuild-single-flight.md) の注記）。作らずに入口を開くと、フォロワーの多い作者の投稿がホームから消える。
   4. 大阪の Relay が、切り替えの時刻の 15 分前から後に送った outbox の行を送り直す。
   5. 作り直しの上限 `ops.timeline.rebuild_rate` を先に下げる（殺到を Aurora の reader で受けるため。reader を 6 台に広げる）。
   6. 入口を大阪へ向ける（CloudFront のオリジン、Route 53）。
   7. 書き込みを開く（`ops.writes_enabled = true`）。
   8. 検索の索引を、最新のスナップショットから戻し、戻した時刻から後の出来事を読み直す。
5. 戻ったことを確かめる。
   - 大阪の合成監視（fan-out の遅延、削除の反映、見える範囲）が通る。
   - 読み出しの p99 が作り直しの目標（2 秒）に戻る。`partial` の割合が下がる。
   - 見える範囲の抜き取りの監査の `hide_unexplained` が 0。
   - カウンターの照合の差が 1 日で 0 に戻る（`counter-drift.md`）。
6. 告知を更新し、失った範囲（時刻）を記録する。

### C. 複製の遅延

1. 東京の writer の負荷（大きな書き込み、バックフィル）を確かめ、原因があれば止める。
2. 遅延が続く間は、リージョンの障害での RPO 1 分を守れないことを IC に伝える。

### 東京へ戻す

1. 東京の回復の後、Aurora が東京を二次として加え直したことを確かめる。
2. 別の計画作業として、switchover（RPO 0）で東京へ戻す。事前に東京のタスクを広げ、`ar:` を B の 4 の 3 と同じ方法で作ってから入口を戻す。
3. 東京のタスクが 0〜511 の番号を借り直したことを確かめる。大阪で振った ID はそのまま残る。

## エスカレーション

- 切り替えの判断：IC と Ops の責任者。
- 失った範囲に法令の案件・措置が含まれうるとき：T&S と法務（措置のやり直し、期限の計算）。
- 1 時間で大阪の受け付けが始まらないとき：AWS のサポート（Business 以上）と経営への報告。

## 事後

- 調査結果を `changes/` の新しい `intent.md` として起票する（Maintain 段）。
- 失った範囲の確定の件数を、監査ログと outbox の記録から数えて残す。
- この手順で足りなかったことを、ここと [infrastructure.md](../architecture/infrastructure.md) の 7 節に反映する。
