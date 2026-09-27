---
status: accepted
date: 2026-09-27
---

# ADR-0035: 最初のモデルは勾配ブースティングで ETA の補正を eta-service の中で動かし、特徴量は 1 つのパイプラインで両方のストアに書き、影の実行を経て区域ごとに展開する

詳細は [ml-platform.md](../architecture/ml-platform.md)。

## Context

S1 の ETA の補正は偏りの表で行い、NFR-003 に届かなければ機械学習の補正を前倒しする（[ADR-0016](0016-valhalla-serving-traffic-and-eta-accuracy.md)）。需要の予測は `block` で行う（[ADR-0002](0002-hex-grid-geospatial-model.md)）。ETA は配車の行列にも入るので、補正の変更は配車の変更でもある（[ADR-0015](0015-offer-protocol-decision-log-and-replay.md)）。Go のサービスは増やさない（[ADR-0001](0001-platform-and-stack.md)）。

事実（2026-09-27 に確認）：

- 本家の Michelangelo は、特徴量をオフライン（Hive）とオンライン（Cassandra）に持ち、変換を DSL で書いて学習と予測で同じ式を使った（[Meet Michelangelo](https://www.uber.com/us/en/blog/michelangelo-machine-learning-platform/)、2017）。
- 本家の ETA は、経路のエンジンの ETA の残差を DeepETA で予測する（[DeepETA](https://www.uber.com/us/en/blog/deepeta-how-uber-predicts-arrival-times/)、2022）。
- 本家は、影の実行（endpoint の影と deployment の影）、段階の展開、自動の戻しを、モデルの展開の安全の柱にしている（[Raising the Bar on ML Model Deployment Safety](https://www.uber.com/us/en/blog/raising-the-bar-on-ml-model-deployment-safety/)、2025-10-30）。

## Options

推論：

1. **LightGBM のモデルを `eta-service`（Go）の中で純粋な Go の評価器で動かす**
2. **別の推論のサービス（Python や Triton）を gRPC で呼ぶ**
3. **最初から深層学習（DeepETA の形）**

特徴量：

- a. **1 つの特徴量は 1 つのパイプラインだけが計算し、オフラインとオンラインに同じ値を書く。配信の記録で次を学習する**
- b. **学習はバッチで、配信は別の実装で計算する**
- c. **マネージドの特徴量のストア（SageMaker Feature Store）に任せる**

## Decision

1 と a を採用する。

- ETA の残差（実際 − 経路の時間 − 乗車地の固定の時間）を LightGBM（Huber）で予測し、±300 秒に切り詰める。`eta-service` の中で評価し、特徴量は Valkey の 1 回の取得にする。欠け・古さ・失敗では S1 の偏りの表に落ち、`eta_source` を付ける。
- 需要の予測は、`block` × 15 分 × 先の 60 分を LightGBM（Tweedie）で 5 分ごとにバッチで出す。使い道は表示と案内だけで、運賃（L9）と配車（別の ADR）には使わない。5 未満のセルは数を出さない。
- 特徴量の定義は `features/` に置き、鍵は格子のセル（`district`〜`street`）・時刻の区切り・HMAC の ID だけを許す。オフラインは S3 の Iceberg、オンラインは Valkey。学習は時点を合わせた結合で行い、2 回目からは配信の記録の特徴量で行う。PSI で食い違いを監視する。
- 学習と登録は SageMaker と Step Functions。同じデータの版・設定・種から同じモデルを作る。本番に出す承認は人が行う。
- 展開は、オフラインの評価 → 影の実行 7 日 → 配車の再生とシミュレーション（二重の割り当て 0 件、成立率 −0.5 ポイント以内、迎車の時間 +3% 以内）→ 区域の 10%・50%・100%。悪化で自動で戻す。モデルの版を ETA の応答と配車の判断の記録に残す。
- 2 を採らない理由：配車の熱い経路にネットワークの往復と、新しいサービスの障害の原因が増える。勾配ブースティングは Go の中で十分に速い見込み（**未検証**。E13 の `eta-model-serving` で計る）。
- 3 を採らない理由：学習と配信の基盤の重さに見合う精度の差を、S2 の規模で確かめていない。勾配ブースティングで足りなくなったら見直す。
- b を採らない理由：2 つの実装の差が、学習と配信の食い違いになる。
- c を採らない理由：オンラインの読み取りの遅れと費用が **未検証**（E13 の `ml-platform-foundation` の試算）で、配信の記録で学習する方式と重なる部分が多い。S2 の試算で見直す。

## Consequences

- 良くなること：
  - 配車の熱い経路にサービスを増やさずに補正を入れられ、失敗しても S1 の形に落ちる。
  - 学習と配信の食い違いが入りにくく、入っても監視で気づける。
  - モデルの変更が、配車の変更と同じ基準で確かめられる。
- 引き受けるコスト：
  - 純粋な Go の評価器の対応と一致を確かめ続ける（PROP-ML-004）。
  - Flink・Iceberg・SageMaker の運用が増える。
  - 配信の記録の保存の費用がかかる。
  - 展開に最短で 2〜3 週かかる。

## Confirmation

- 性質ベーステスト：PROP-ML-001〜004（[ml-platform.md](../architecture/ml-platform.md) の 10 節）。
- CI：特徴量の定義の検査（鍵と `pii` の規則）。
- 展開の記録：各段の結果をモデルの登録に残し、段を飛ばした展開を拒否する（AppConfig の検証の関数で、登録の状態を確かめる）。
- 監視：`eta_source` の内訳、PSI、自動の戻しの回数。
