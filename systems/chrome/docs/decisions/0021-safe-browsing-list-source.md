---
status: accepted
date: 2026-09-26
---

# ADR-0021: Safe Browsing の脅威のリストは自前で作り、第三者のフィードを使う

## Context

Safe Browsing には、危険な URL のリスト（フィッシング、マルウェア、望ましくないソフトウェア）が要る。本家 Chrome は Google 自身のリストを使う。自分たちのブラウザで同じリストを使うには、Google の API の条件を確かめる必要がある（2026 年 9 月時点。出典は References）。

| API | 条件 |
| --- | --- |
| Safe Browsing API（v4・v5） | 非商用に限る（販売・収益を目的としない用途）。商用は Web Risk を使う |
| Web Risk の Update API | 差分の取得（computeDiff）は無料。完全なハッシュの照会（hashes.search）は 1,000 回あたり 50 ドル。返された情報の再配布を禁じる |

ブラウザは商用の製品として配るため、Safe Browsing API は使えない。Web Risk は、利用者の端末からの照会が多いと費用が大きく、自分たちのサービスを経由して端末に配ることが「再配布」にあたる可能性がある。消費者向けのブラウザでの利用を認めるかは、公開の文書からは確かめられない（未検証）。

## Options

> 2026-09-27 の注記：Safe Browsing API は非商用に限られ、商用は Web Risk を使うよう案内されている（[Safe Browsing](https://developers.google.com/safe-browsing)、[Usage limits](https://developers.google.com/safe-browsing/v4/usage-limits)）。Web Risk は、返した情報を再配布してはならないとしている（[Web Risk の概要](https://cloud.google.com/web-risk/docs/overview)）。消費者向けのブラウザでの利用を認めるか禁じるかの条項は、公開の文書に見つからなかった（2026-09-27 に確認）。上の「未検証」は、公開の文書では確かめられないまま残る。使うなら Google との個別の契約が前提になる（S2 の運用の後の判断。[architecture/README.md](../architecture/README.md) の「持ち越し」）。

1. **自前の脅威のリストのサービスを作り、商用のフィードと利用者の報告で作る。Google の API は MVP で使わない**
2. **Web Risk を契約し、端末から直接照会させる**
3. **Google と個別の契約を結び、本家と同じリストを使う**

## Decision

1 を採用する。詳細は [safe-browsing-and-permissions.md](../architecture/safe-browsing-and-permissions.md) の 2・3 節。

- 端末とサービスの間のプロトコルは自前で定義する（本家の v4・v5 の考え方：ハッシュの接頭辞、差分の更新、リアルタイムの照会、OHTTP）。リストの出所を後から足しても、端末を変えない。
- リストの出所は、商用の契約を結んだフィード（例：abuse.ch の商用の API）、業界団体の交換の枠組み、利用者の報告、自前の巡回（MVP の後）。
- 2 は、端末が Google に直接つながり、IP アドレスと照会が Google に渡る（ADR-0005 に反する）。費用と再配布の条件も未確認。
- 3 は、検出の質が最も高いが、契約の可否と条件が不明で、MVP の前提にできない。契約を結べたら、出所の 1 つとして足す（別の ADR）。

## Consequences

- 良くなること：
  - 利用の条件と費用を自分たちで管理できる。利用者の照会が第三者に渡らない。
- 引き受けるコスト：
  - 検出の範囲と速さが、本家に劣る可能性が高い。フィードの費用と、誤検知の対応（異議の受付、保護の一覧）の運用を持つ。
  - NFR-009 を、フィードの取り込みの速さに依存して満たす必要がある。

## Confirmation

- テスト用の URL をリストに載せてから、端末で判定されるまでの時間を、本番で常時測る（NFR-009）。
- 主要なフィッシングの公開の集計と比べた検出率を、四半期ごとに記録する。
- 端末から Google の Safe Browsing・Web Risk の端点への通信が無いことを、ネットワークの検査で確かめる。

## References

- Google: [Safe Browsing の利用の制限](https://developers.google.com/safe-browsing/v4/usage-limits)
- Google: [Safe Browsing API（v5）Overview](https://developers.google.com/safe-browsing/reference)
- Google Cloud: [Web Risk Overview](https://docs.cloud.google.com/web-risk/docs/overview)、[Web Risk Pricing](https://cloud.google.com/web-risk/pricing)
- abuse.ch: [URLhaus API](https://urlhaus.abuse.ch/api/)（無料のコミュニティの API は公正な利用の範囲。商用の利用は有料の API）
