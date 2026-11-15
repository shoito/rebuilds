# Runbook: 署名の方針の切り替えと取り下げ

- Owner: セキュリティ、Ops（当番）、財務
- 対応するアラート: 定期作業（方針の束・承認者の一覧・本システムのウォレットの許可の一覧の変更）。束の確かめの失敗（受け手が有効にしなかった。page）、切り替えの後の試験の出金の失敗（page）
- 最終確認日: 2026-11-15

前提の設計は [ADR-0035](../decisions/0035-signing-policy-bundle-and-decision-table.md)（束と決定表）、[ADR-0036](../decisions/0036-approver-keys-and-approval-payload.md)（承認者の一覧）、[ADR-0037](../decisions/0037-transfer-routes-and-warm-target.md)（本システムのウォレットの許可の一覧）、[ADR-0075](../decisions/0075-signed-config-bundles-for-policies-and-rules.md)（署名した設定の束）。流れの図は [delivery.md](../architecture/delivery.md) の 4.9 節、束のステートマシンは [custody-and-keys.md](../architecture/custody-and-keys.md) の 6.3 節にある。

`wallet-orchestrator` と `policy-verifier` の 2 か所の方針のバージョンが違えば、正しい出金も止まる。**新旧を両方受ける猶予の時間を置かない。** 切り替えの間は、ホットの自動の署名を止める。

## 症状

- `config/signing-policy/` の PR がマージされ、CI が新しいバージョンの束を作った（定期の変更）。
- 承認者の追加・離職、本システムのウォレットのアドレスの追加・外し（儀式で作った鍵など）がある。
- 侵害の疑いで、有効な束や `pending` の束を取り下げる。

## 影響

- 切り替えの数分の間、ホットの自動の署名が止まり、100 万円までの出金も承認の段に回る（NFR-008 の計測は承認の待ちを除く）。
- 「緩める」変更（額の段の上限を上げる、`auto` の行を増やす、`deny` の行を外す）は、境界に入れてから 24 時間 `pending` で、有効になるのはその後である。

## 確認

1. 束の種類（policy・approvers・house_allowlist）、新しいバージョン、前のバージョンのハッシュ、内容のハッシュ。CI が判定した「緩める・厳しくする」の区分と `pending` の時間。
2. 決定表 DT-POL の全行の CI の結果が緑で、`wallet-orchestrator` と `policy-verifier` の同じパッケージのバージョンで判定が一致したこと。
3. 運用の画面の差分を、承認者 2 人（セキュリティ、財務）がそれぞれ見て、ハッシュに署名したこと。作成者（PR の作者とマージした人）の署名は数えない。AI エージェントは署名者にならない。
4. 手続き中の依頼の数（`policy`・`approving`・`signing` の出金と移し替え）。凍結の時間帯（コールドの儀式の当日、[README.md](README.md) の 3.1 節）でないこと。

## 対処

### 切り替え（平日 10〜15 時）

1. 全資産の `ops.hot_auto_signing_enabled.<asset>` を切る。
2. 前のバージョンで判定した手続き中の依頼が、署名か差し戻しで片付くのを待つ（目安 10 分。承認の期限 30 分を超えて残る依頼は、承認を集め直す側に戻す）。
3. 運用の画面から `policy-verifier` に束を届ける。境界が、署名・承認者の一覧・前のバージョンのハッシュの連続を確かめて有効にする（緩める変更は `pending` に入る）。境界が有効にしなかったら、ここで止め、エスカレーションへ。
4. 境界で有効になったのを確かめてから、`wallet-orchestrator` で同じバージョンを有効にする。
5. 試験の出金（見張りの口座から見張りのウォレットへ、最小の額）を通し、署名の記録の束の ID と行の番号が新しいバージョンであることを確かめる。
6. 作成者と別の 2 人の承認で `ops.hot_auto_signing_enabled.<asset>` を開ける。
7. 緩める変更は、24 時間の後に `pending` から `active` に変わったことを、もう一度確かめる。前の束は、次が有効になって 1 時間で `retired` になる。

### 取り下げ

1. 侵害の疑いがあれば、先に [hot-wallet-compromise.md](hot-wallet-compromise.md) の「止める」を行う。
2. `pending` の束は取り下げの操作で `withdrawn` にする（セキュリティと財務の 2 人）。`active` の束を取り下げるときは、前の正しいバージョンの内容で新しいバージョンを作り、上の切り替えで入れる（前のバージョンへ戻すのではなく、次のバージョンとして入れる）。
3. 承認者や許可の一覧のアドレスを外す変更は、すぐに有効になる（待ちなし）。

## エスカレーション

- 境界が束を有効にしない（署名・連続・役割の不足）：セキュリティの責任者。`prod` の側の束の改ざんの疑いなら SEV1 の候補として [hot-wallet-compromise.md](hot-wallet-compromise.md)。
- 試験の出金で 2 か所の判定が食い違った：自動の停止（[ADR-0066](../decisions/0066-automatic-withdrawal-tripwires.md)）が働く。開け方は [tripwire-reopen.md](tripwire-reopen.md)。
- 手続き中の依頼が 30 分を超えて片付かない：Ops の責任者と財務。開ける時刻を決め直す。

## 事後

- 束のバージョン、承認者、切り替えの開始と終わりの時刻、止めた時間を記録する（毎週の束と境界の記録の照らし合わせで使う。[README.md](README.md) の 5 節）。
- 止めた時間が長ければ、手続き中の依頼を片付ける手順を見直す。調べた結果を `changes/` の新しい `intent.md` として起票する。
