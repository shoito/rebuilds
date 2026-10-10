# Runbook: 迷惑メール・フィッシングの急な波

- Owner: Ops（選別の当番）
- 対応するアラート: 迷惑メールの急な波（申し出の急増、新しいフィッシングの型。page）
- 最終確認日: 2026-10-10

波の想定と大きさは [capacity.md](../architecture/capacity.md) の 1.2・2 節（[ADR-0068](../decisions/0068-capacity-model-and-headroom.md)）、接続の層は [inbound-smtp.md](../architecture/inbound-smtp.md) の 6 節（[ADR-0010](../decisions/0010-inbound-connection-tiers-and-rate-limits.md)）、緊急の規則は [spam-and-abuse-filtering.md](../architecture/spam-and-abuse-filtering.md) の 12.3 節。

## 症状

- 受信の申し出がピーク（6,250 通/秒）を大きく超えた。多くが `unknown`・`suspicious` の層。
- 受信箱に届いたメールへの「迷惑メール」の報告の率が急に上がった（新しいフィッシングの型）。
- `inbound-delivery-low` の古さが伸びている。

## 影響

- 正規のメールの受信の遅れ（NFR-001）が守られるかが要。`inbound-delivery` が先に読まれていれば、遅れるのは低い層の待ち行列だけ（最大 2 時間）。
- 見逃しのフィッシングが受信箱に届く（NFR-008）。

## 確認

1. 申し出と受け付けの数、層ごとの割合、421・554 の数。`mx-edge` の受け付けの使用の率。
2. `inbound-delivery` の古さ（30 秒以下か）と `inbound-delivery-low` の古さ。
3. 報告の率の上がった型（送信元の ASN、URL のドメイン、件名の形ではなく特徴のハッシュ）。中身を開かない。

## 対処

1. **接続で絞る**：`unknown` の層の上限を一時に半分にする（`inbound.limits.*` の `ops` の一時の引き下げ。記録つき）。範囲・ASN ごとの一時の引き下げを足す。
2. **受け付けた後は溜める**：選別の Fargate は自動で伸びる。`inbound-delivery` の古さが 30 秒を超えるなら、`inbound-pipeline` のタスクを手で足す。
3. **緊急の規則**：波に当てる規則を速い道で出す。向きは迷惑メール・フィッシングに寄せるだけ。評価の集まりの正規のメールで当たり 0、影 1 時間で「迷惑メールではない」0、Dev と QA の 2 人の承認、7 日で失効。SMTP の時点の規則（`smtp_time: true`）は影 24 時間。
4. **すでに届いたもの**：配った後の手当て（URL の評判の更新で、開くときの警告。[attachment-and-url-scanning.md](../architecture/attachment-and-url-scanning.md) の 6 節）。
5. 大きなフィッシングの波の対応中は、選別のモデルの段の進めを止め、対応の規則だけを入れる（[README.md](README.md) の 3.1 節）。

## エスカレーション

- 正規のメールの受信の遅れが p95 60 秒を 5 分超えた：Dev のテックリード。SEV2。
- 緊急の規則で誤判定が出た（「迷惑メールではない」の急増）：規則を止め、[README.md](README.md) の 4 節の `filter-false-positive-spike.md`（計画）に従う。
- 脅威の情報を外部と共有するかは**法務の確認待ち**（L10）。

## 事後

- 緊急の規則を、続けるなら通常の出し方（評価の集まり、影、段）に載せる。
- 波の大きさと追いつきの時間を記録し、[capacity.md](../architecture/capacity.md) の想定と比べる。
- 調査結果を `changes/` の新しい `intent.md` として起票する。
