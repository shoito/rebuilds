# Runbook: 悪い版の配信を止める・取り下げる

- Owner: Ops
- 対応するアラート: 配信の自動の停止（rollout-guard）、新しい版のクラッシュの急増、更新の失敗率
- 最終確認日: 2026-09-26

方針は [update-and-release.md](../architecture/update-and-release.md) の 4.3・11・12 節と [ADR-0029](../decisions/0029-updater-protocol-and-staged-rollout.md)、指標は [observability.md](../architecture/observability.md) の 3・5 節にある。

## 症状

次のときに使う。

- rollout-guard が、ある版の段階を凍結した
- 新しい版で、クラッシュ率・起動直後のクラッシュ・更新の失敗率が悪化した
- 利用者・社内・企業の管理者から、新しい版での重大な不具合の報告が来た（データの消失、起動しない、主要サイトが表示できない）

## 影響

- 新しい版に更新した端末で、クラッシュや機能の不具合が起きる。影響する端末の数は、段階の割合 × 更新済みの割合。
- クラウドのサービスの SLO は消費しない。NFR-005 と、リリースの判定の基準（[quality.md](../quality.md)）を損なう。

## 確認

1. リリースのダッシュボード（[observability.md](../architecture/observability.md) の 3.3 節）で、対象の版を開く。
   - 段階の割合と、新しい版で動いている端末の数
   - 悪化した指標と、前の版との比。標本が足りているか
   - 新しい版で上位に入ったクラッシュのシグネチャ
2. 悪化が、特定の OS・アーキテクチャ・GPU・企業のポリシーの有無に偏っていないかを見る。偏っていれば、その組み合わせだけを止められる。
3. 原因の候補を絞る。
   - その版で新しく有効にしたフィールドトライアル（seed の変更の履歴）
   - その版の変更の一覧（前の版からの差分）
   - 差分の適用の失敗なら、エラーの種類（ディスクの容量、ウイルス対策ソフト、署名の検証）
4. 重さを決める（[service-incident-response.md](service-incident-response.md) の重さの表）。データの消失、起動しない、セキュリティの機能が効かない（サンドボックス、Safe Browsing）は SEV1。

## 対処

上から順に、被害を止める手段の軽いものを選ぶ。

1. **配信を凍結する**（rollout-guard が止めていなければ）。配信の管理の画面か CLI で、その版の `rollouts.state` を `frozen` にする。新しい端末には配らなくなる。すでに更新した端末はそのまま。記録（`rollout_events`）に理由を書く。
2. **機能を止める。** 原因が特定の機能なら、フィールドトライアルの seed で無効にする（[update-and-release.md](../architecture/update-and-release.md) の 12 節）。機能を止める seed の変更は、全チャンネルに同時に出してよい。起動中の端末にも 30 分程度で効く。効いたかを、クラッシュ率の推移で確かめる。
3. **組み合わせだけを止める。** 特定の OS・アーキテクチャに偏るなら、その組み合わせの配信だけを凍結し、他は進めてよいかを release owner が判断する。
4. **修正の版を出す（roll forward）。** 原因の修正を `main` に入れ、リリースのブランチへ cherry-pick し、新しいパッチの版を出す（[update-and-release.md](../architecture/update-and-release.md) の 2 節）。新しい版は通常の段階から始める。重大なら、[emergency-security-release.md](emergency-security-release.md) の短縮した段階を使ってよい。
5. **版を取り下げる（pull）。** 修正の版がすぐに出せず、更新済みの端末の被害が続くときだけ、Dev（テックリード）と相談して行う。
   - 取り下げた版を、どの端末にも返さないようにする（`rollouts.state = halted`）。
   - 更新済みの端末を前の版に戻すのは、プロファイルの形式が 1 つ前の版で読めること（[data-model.md](../architecture/data-model.md) の 3 節）を Dev が確認したときだけにする。戻すときは、前の版をより大きな版の番号で出し直す（版の番号は前にしか進めない）。
6. **再開する。** 修正の版で指標が戻ったことを確かめてから、凍結した版を `halted` にして閉じるか、組み合わせを限って再開する。rollout-guard は自動では再開しない。

## エスカレーション

| 状況 | 連絡先 |
| --- | --- |
| SEV1（データの消失、起動しない、セキュリティの機能の不全） | release owner、Dev（テックリード）、PM。[service-incident-response.md](service-incident-response.md) に従う |
| 取り下げ（pull）を考える | Dev（テックリード）の承認 |
| 企業の管理者への告知が要る | PM |
| 更新の失敗が、OS やウイルス対策ソフトの変更によるものらしい | Dev。必要なら提供元に連絡する |

## 事後

- 振り返りを行い、調査結果を Intent の Issue として起票する（Maintain 段）。
- 自動の停止が遅れた・効かなかったなら、閾値と標本の条件を見直す（[update-and-release.md](../architecture/update-and-release.md) の 4.3 節）。
- CI や Beta で見つけられたなら、テストを足す提案を QA に出す。
- この手順で足りなかったことを、ここに反映する。
