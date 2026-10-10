# Runbook: インシデントへの対応（全般）

- Owner: Ops
- 対応するアラート: 個別の手順のないアラートの全部。SEV の判断、連絡、振り返り
- 最終確認日: 2026-10-10

SLO とアラートの一覧は [README.md](README.md) の 1・4 節、計測は [observability.md](../architecture/observability.md)、セキュリティの事象の最初の動作は [security.md](../architecture/security.md) の 12 節にある。

## 症状

- 呼び出し（page）かチケットが来たが、[README.md](README.md) の 4 節に作った手順がない。
- 複数のアラートが同時に出て、どの手順から入るか分からない。

## 影響

アラートによる。受信の停止は、送り手の再試行（多くは 4〜5 日）の間は失わないが、遅れる。受け付けたメールの欠け・分離の疑いは、利用者も送り手も気づけないので最も重い。

## 確認

1. **正しさ**：見張りのメールの欠け、スプールと配送の突き合わせ、blob の突き合わせ、応答の監査に 0 でない値があるか（[quality.md](../quality.md) の 4.1 節）。あれば SEV1 の候補で、可用性より先に扱う。
2. **範囲**：受信（`mx-edge`、東京か大阪か）、選別、保存（シャード）、同期（JMAP・IMAP・プッシュ）、送信（プール、相手のドメイン）、リージョンのどこか。Grafana の全体のダッシュボードで、受信の遅れ、配送の待ち行列の古さ（`inbound-delivery`・`inbound-delivery-low`）、シャードの書き込みの遅れ、送信の到達を見る。
3. **直近の変更**：デプロイ、AppConfig のフラグ、選別のモデル・規則の段の進め、スキーマの波、Terraform（IP、S3 の方針）。
4. **外からの見張り**：`mail-canary` のアカウントの見張りのメールの結果。観測の部品が止まっていても、`mail-canary` のデッドマンスイッチを見る（[observability.md](../architecture/observability.md) の 10 節）。
5. 調べるのは ID・数・理由のコードだけ。利用者のメールの中身を開かない（[ADR-0008](../decisions/0008-spam-pipeline-boundary-and-secrecy.md)、[ADR-0061](../decisions/0061-operator-access-cross-tenant-paths-and-audit.md)）。

### SEV の目安

| SEV | 例 |
| --- | --- |
| SEV1 | 250 の後のメールの欠け、blob の目録と S3 の不一致、他のアカウント・組織のメールの露出の疑い、全体の受信の停止（大阪の副 MX も受けない） |
| SEV2 | 送信の IP のブロックリストへの掲載、外部の大手の事業者への到達の低下、配送の待ち行列の DLQ の増加、1 つのシャードの停止、後方散乱、ログの中身の検出、大規模な乗っ取り |
| SEV3 | 1 つの機能の劣化（検索の遅れ、プッシュの遅れ、1 つの相手のドメインの絞り） |

## 対処

1. **IC を決める**（SEV1・SEV2）。IC は判断と連絡、別の人が作業する。記録の場を開く。
2. **被害を止める**（原因の調査より先）：
   - 欠け・blob の不一致：GC と詰め直しを止める（`ops.blob_gc_enabled`、`ops.blob_repack_enabled`、鍵の破棄は `ops.blob_shred_paused`）。スプールは 7 日残るので、配り直しはスプールから行う（[mail-delivery-backlog.md](mail-delivery-backlog.md)）。
   - デプロイの直後：まずフラグで戻し、次に 1 つ前のイメージへ（[deploy-and-rollback.md](deploy-and-rollback.md)）。
   - 選別の誤判定の急増：`ops.filter_model_pinned` で前のバージョンに固定する。
   - 東京の受信の不調：`ops.inbound_accept_enabled` で東京の MX を止め、大阪の副 MX に寄せる。
   - 送信の評判：[ip-blocklisted.md](ip-blocklisted.md)。乗っ取り：[account-takeover.md](account-takeover.md)。迷惑メールの波：[spam-wave.md](spam-wave.md)。
   - 分離の疑い：該当の経路のフラグを止め、デプロイを戻す（`access-leak-response.md` は計画。それまでこの手順で、[security.md](../architecture/security.md) の 12 節に従う）。
3. **個別の手順へ**：原因の領域が分かったら、[README.md](README.md) の 4 節の手順に移る。手順が「計画」なら、この手順で続け、足りなかったことを記録する。
4. **利用者への知らせ**：状況のページで、影響の機能と時間を知らせる。個人のデータ・アドレス・件名を書かない。文言は法務の L7 の後のひな形を使う。
5. **回復の確かめ**：SLI が SLO に戻り、突き合わせ（スプールと配送、blob）をやり直して 0 を確かめる。

## エスカレーション

- SEV1：Ops の責任者、Dev のテックリード、PM。分離・漏えいの疑いはセキュリティの担当と法務（漏えいの報告の要否は**法務の確認待ち**：L3）。
- AWS の障害：AWS のサポートへ。外部の事業者・ブロックリストとの連絡は、Ops と到達性の担当だけが行う。
- 1 時間で被害を止められない：Ops の責任者が、リージョンの切り替え（[disaster-recovery.md](disaster-recovery.md)）を含めて判断する。
- 昇格（break-glass）は Ops の 2 人の承認と 1 時間だけ。昇格でもメールボックスの表と blob の読みの権限は出ない（[ADR-0061](../decisions/0061-operator-access-cross-tenant-paths-and-audit.md)）。

## 事後

- SEV1・SEV2 は 5 営業日の中で振り返りを書く（時刻の並び、検知までの時間、止めるまでの時間、失った範囲、根の原因、直すこと）。中身・アドレスを書かない。
- 調査結果を `changes/` の新しい `intent.md` として起票する（Maintain 段）。
- この手順と、[README.md](README.md) の 4 節の計画の手順で足りなかったことを反映する。
