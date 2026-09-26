# Intent: Chrome を AI エージェント主体で再構築する

- Author: shoito
- Status: accepted
- Date: 2026-09-26

## Problem

Web ブラウザは、利用者が最も長く使うソフトウェアの 1 つで、同時に、信頼できないコード（Web ページ）を大量に実行する、攻撃に最もさらされるソフトウェアでもある。

本家 Chrome は、次を両立させている。

- 速さ（起動、ページの表示、JavaScript）
- 安全（サンドボックス、サイトの隔離、Safe Browsing、自動更新）
- 簡潔な UI
- アカウントでの同期

主要なブラウザのエンジンは、長い年月をかけた巨大なコードで、新しく作る例は少ない（Servo、Ladybird など）。AI エージェントが主な作り手になるとき、ブラウザをどう分解し、何を自作し、何を既存の部品に頼るかを確かめる。

## Proposed outcome

デスクトップ（Windows・macOS・Linux）の Web ブラウザと、それを支えるクラウドのサービスを作り直す。次の 3 つの価値を満たす。

1. **速い**：起動、ページの表示、操作の応答が、主要なブラウザと比べて遜色ない。
2. **安全**：ページごとに隔離し、侵害されても被害を閉じ込める。危険なサイトから守り、修正を素早く全員に届ける。
3. **どこでも同じ**：ブックマーク・履歴・パスワード・タブを、端末の間で安全に同期する。

### MVP に含める

- デスクトップ 3 OS のブラウザ：タブ、アドレスバー（検索と候補）、ブックマーク、履歴、ダウンロード、設定、プロファイル、シークレットモード
- エンジン：複数プロセスの構成、サイトの隔離、HTML・CSS・JavaScript（V8）の主要な Web プラットフォーム、GPU での合成、フォームの自動入力
- ネットワーク：HTTP/1.1・HTTP/2・HTTP/3、TLS 1.3、DNS over HTTPS、キャッシュ、Cookie とプライバシーの制限
- 保存：Cookie、localStorage、IndexedDB、Cache Storage、Service Worker
- 安全：OS ごとのサンドボックス、権限の確認（カメラ・位置など）、Safe Browsing、パスワードマネージャ
- 拡張機能：Manifest V3 の主要な API と、拡張機能のストア
- クラウドのサービス：アカウント、同期（パスワードはエンドツーエンドで暗号化）、自動更新の配信、クラッシュの収集、Safe Browsing のリスト、拡張機能のストア
- リリース：Canary・Dev・Beta・Stable の 4 つのチャンネル

### 守るべき振る舞い

- 1 つのサイトのプロセスが侵害されても、他のサイトのデータ（Cookie、保存領域、表示の内容）に触れられない。
- 重大な脆弱性の修正は、決められた時間の内に、大半の利用者に届く。
- 同期のデータのうち、パスワードは、サービスの運営者にも読めない形で保存する。
- 利用状況の送信（テレメトリ）は、利用者が選べ、既定の範囲を公開する。

## Affected users and systems

- ブラウザの利用者（個人、企業の管理者）
- Web の開発者（互換性、開発者ツール）
- 拡張機能の開発者
- クラウドのサービスの運用

## Constraints

- エンジンの全部を自作しない。成熟した部品（JavaScript エンジン、グラフィックス、フォント、暗号、画像・動画の復号）を使い、構造（プロセスの構成、隔離、ナビゲーション、ネットワーク、UI）を自作する（[ADR-0002](decisions/0002-engine-build-vs-reuse.md)）。
- クラウドのサービスは、rebuilds の他の題材の決定（AWS、TypeScript、Terraform）を引き継ぐ（[ADR-0001](decisions/0001-languages-and-platform.md)）。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の「規模の段階」）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| Android 版、iOS 版 | MVP の後の Epic。iOS は、日本（スマホ新法、iOS 26.2 以降）と EU で独自のエンジンが使えるので、その経路で検討する |
| ChromeOS | OS そのものは別の製品 |
| 開発者ツールの全機能 | MVP は要素の検査・コンソール・ネットワーク・デバッガの基本に絞る |
| 翻訳、AI の機能（要約など） | 別の製品の機能。MVP の後に検討する |
| 広告に関わる API（Privacy Sandbox など） | 事業の前提が違う |
| Google のサービスとの統合（検索の既定、Google アカウント） | 自前のアカウントと、選べる検索エンジンにする |

## Open questions

- ~~互換性の目標を、どの指標で測るか~~：NFR-007（対象とした領域の Web Platform Tests の合格率 90% 以上、主要サイト 1,000 件で致命的な崩れ 0 件）で測る。対象の領域と数え方は [quality.md](quality.md) の 2.4 節。
- 既定案で決めた事項と、計測・PoC・契約で決める持ち越しは、[architecture/README.md](architecture/README.md) の 6 節にある。

### 法務・事業の確認待ち

設計はどの結論にも対応できる形にしてあるが、結論は出していない。**下の表の「承認を止める spec」は、確認が済むまで PM・QA が承認しない。** 設計と、確認に依らない Story は進めてよい。

| # | 問い | 関係する設計 | 承認を止める spec |
| --- | --- | --- | --- |
| L1 | DRM：Widevine を使うか。使うなら提供元へのライセンスの申請（外部の手続き）と、その条件（サンドボックス・署名・配布の要件） | [rendering.md](architecture/rendering.md) の 15・17 節 | DRM の Story（S1 に含めない。[roadmap.md](roadmap.md) の「後回しにしたもの」） |
| L2 | ソースの公開：公開するか、時期、自作のコードのライセンス。部品（MPL-2.0 の Stylo、BSD の DevTools のフロントエンドなど）のライセンスの表示と、配布物への同梱の方法 | [architecture/README.md](architecture/README.md) の「決定」、[build-and-test.md](architecture/build-and-test.md) の 5 節 | ソースの公開と OSS-Fuzz への参加の Story。配布物のライセンスの表示の Story（E9） |
| L3 | 本家の名前との関係：拡張機能の `chrome.*` の名前空間（ADR-0025）、本家と同じ名前の企業のポリシー（`ExtensionSettings` など）、拡張機能 ID の形式を本家と同じにすることが、商標・誤認の問題にならないか | [ADR-0025](decisions/0025-extension-platform-mv3.md)、[browser-ui.md](architecture/browser-ui.md) の 5 節、[extensions.md](architecture/extensions.md) の 6 節 | E7 の名前空間の Story、E6 の企業のポリシーの Story |
| L4 | 本家の CRLSet・HSTS の事前読み込み・ルートストアの一覧を取り込んで再配布してよいか（利用条件） | [networking.md](architecture/networking.md) の 6 節、[ADR-0015](decisions/0015-tls-and-certificate-verification.md) | E4 の本家の CRLSet を使う Story（既定案の CCADB から作る Story は止めない） |
| L5 | Pwned Passwords のデータを自前の CDN に写して配ってよいか | [safe-browsing-and-permissions.md](architecture/safe-browsing-and-permissions.md) の 6.4 節 | E8 の自前の写しの Story（既定案の範囲 API は止めない） |
| L6 | 利用者のデータの送信：テレメトリ・クラッシュの同意の画面と公開する範囲、Safe Browsing のリアルタイムの照会、検索の候補の送信が、個人情報保護法・電気通信事業法の外部送信規律・GDPR の求めを満たすか | [ADR-0005](decisions/0005-privacy-first-services.md)、[ADR-0032](decisions/0032-crash-and-telemetry-privacy.md)、[browser-ui.md](architecture/browser-ui.md) の 3.3 節 | E9 の同意とテレメトリの Story、E5 のリアルタイムの照会の Story、E6 の検索の候補の Story |
| L7 | 拡張機能のストアの開発者の規約、方針の条項、措置と異議の手続き | [extensions.md](architecture/extensions.md) の 7 節、[ADR-0026](decisions/0026-extension-store-review.md) | E7 のストアの公開の Story |
| L8 | 脆弱性の報告の窓口とバグ報奨金の規約（研究者の保護、支払い） | [sandbox-and-security.md](architecture/sandbox-and-security.md) の 7 節 | E10 のバグ報奨金の Story |
| L9 | 主要サイトの通信を記録して試験に使うこと（著作権、各サイトの利用規約） | [build-and-test.md](architecture/build-and-test.md) の 3 節 | E2 の主要サイトの記録の Story |
| L10 | 検索エンジンの選択の画面（各国の規制）と、検索エンジンと商業の契約を持たない前提 | [browser-ui.md](architecture/browser-ui.md) の 3.2 節 | E6 の検索エンジンの選択の Story |

### 事業の判断（法務以外）

- OHTTP の中継の事業者との契約（E5 の着手前）、商用の脅威のフィードの選定と費用（E5）、Google との契約を Safe Browsing の出所に足すか（S2 の後。ADR-0021）。
- バグ報奨金の金額と運営の基盤（E10）。
