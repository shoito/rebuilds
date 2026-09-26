# Architecture: Chrome

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイルにある。

| ファイル | 領域 |
| --- | --- |
| [process-model.md](process-model.md) | 複数プロセスの構成、IPC、サイトの隔離、プロセスの割り当て |
| [navigation-and-loading.md](navigation-and-loading.md) | ナビゲーション、履歴、読み込みの流れ、bfcache |
| [rendering.md](rendering.md) | DOM、スタイル、レイアウト、描画、合成、GPU |
| [javascript-and-web-apis.md](javascript-and-web-apis.md) | JavaScript エンジンの組み込み、バインディング、Web API の範囲 |
| [networking.md](networking.md) | HTTP、TLS、DNS、キャッシュ、Cookie、CORS、プライバシー |
| [storage.md](storage.md) | サイトの保存領域、割り当て、Service Worker |
| [sandbox-and-security.md](sandbox-and-security.md) | OS ごとのサンドボックス、脅威モデル、脆弱性への対応 |
| [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) | Safe Browsing、権限、パスワードマネージャ |
| [browser-ui.md](browser-ui.md) | タブ、アドレスバー、設定、プロファイル、アクセシビリティ、国際化 |
| [extensions.md](extensions.md) | Manifest V3、拡張機能のストア、審査 |
| [sync-and-accounts.md](sync-and-accounts.md) | アカウント、同期、エンドツーエンドの暗号化 |
| [update-and-release.md](update-and-release.md) | 自動更新、チャンネル、段階的な配信、クラッシュの収集、テレメトリ |
| [build-and-test.md](build-and-test.md) | ビルド、CI、Web Platform Tests、ファズ |
| [infrastructure.md](infrastructure.md) | クラウドのサービスの AWS の構成、冗長化、災害復旧 |
| [observability.md](observability.md) | クライアントとサービスの指標、SLO |
| [capacity.md](capacity.md) | サービスの負荷のモデル |
| [data-model.md](data-model.md) | クライアントの保存データとサービスのデータの索引 |

## 1. 全体構成

```
┌──────────────── ブラウザ（端末の上） ────────────────┐
│ Browser プロセス（UI、ナビゲーション、プロファイル、権限）│
│   ├─ Renderer プロセス（サイトごと。サンドボックス）      │
│   │     DOM・スタイル・レイアウト・JavaScript（V8）       │
│   ├─ GPU プロセス（合成、描画）                          │
│   ├─ Network サービス（HTTP・TLS・キャッシュ・Cookie）    │
│   ├─ Storage サービス（IndexedDB など）                  │
│   └─ Utility プロセス（音声・動画の復号、画像、PDF）      │
└──────────────────────────────────────────────────────┘
          │ HTTPS
┌──────── クラウドのサービス（AWS） ────────┐
│ 更新の配信、同期、アカウント、Safe Browsing のリスト、│
│ クラッシュの収集、テレメトリ、拡張機能のストア        │
└──────────────────────────────────────────┘
```

原則は 3 つ。

- **信頼できないものは、権限の低いプロセスで動かす。** Web のコンテンツを扱う Renderer は、OS のサンドボックスの中で、サイトごとに分ける（[ADR-0003](../decisions/0003-multi-process-site-isolation.md)）。
- **Browser プロセスは、Renderer を信用しない。** Renderer からの要求（保存領域、Cookie、権限）は、Browser 側で、そのプロセスに割り当てたサイトと照らして検査する。
- **修正を速く届ける。** 4 つのチャンネルと段階的な自動更新で、脆弱性の修正を決められた時間で配る（[ADR-0004](../decisions/0004-release-channels-and-updates.md)）。

## 2. 規模の段階

利用者の数は、主にクラウドのサービスの規模を決める。

| 段階 | 利用者（月間） | 構成 |
| --- | --- | --- |
| S1（MVP） | 10 万 | サービスは東京の 1 リージョン。更新の配信は CDN |
| S2 | 1,000 万 | 同期とクラッシュの収集を分割。Safe Browsing のリストの配信を CDN に寄せる |
| S3 | 1 億 | 複数のリージョン。更新の配信を世界の CDN に広げる |

## 3. 非機能要件

| ID | 項目 | 目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 起動の時間（ウォームの起動、最初の画面まで） | p75 1 秒以内 | 基準の端末で |
| NFR-002 | ページの表示 | 主要サイトの Core Web Vitals（LCP・INP・CLS）が、同じ端末の本家 Chrome の 1.2 倍以内 | |
| NFR-003 | JavaScript・描画の性能 | Speedometer 3 のスコアが、同じ端末の本家 Chrome の 80% 以上 | |
| NFR-004 | メモリ | タブ 20 枚の標準の作業で、本家 Chrome の 1.2 倍以内 | |
| NFR-005 | 安定性 | Stable のクラッシュ率（Browser プロセス）が 1,000 セッションあたり 0.5 件未満 | |
| NFR-006 | 修正の配信 | 重大な脆弱性の修正を、公開から 48 時間以内に Stable の 90% の利用者へ届ける | |
| NFR-007 | 互換性 | Web Platform Tests の合格率を、対象とした領域で 90% 以上。主要サイト 1,000 件で致命的な表示の崩れ 0 件 | |
| NFR-008 | 同期 | 別の端末への反映 p95 10 秒以内 | |
| NFR-009 | Safe Browsing | 新しい危険なサイトのリストへの反映から、端末での判定まで 30 分以内 | |
| NFR-010 | サービスの可用性 | 更新の配信・Safe Browsing は月間 99.95%、同期は 99.9% | |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| ブラウザ・エンジン | Rust | メモリ安全性。攻撃にさらされるコードで、脆弱性の主な原因を言語で減らす（[ADR-0001](../decisions/0001-languages-and-platform.md)） |
| JavaScript | V8（Rust のバインディングで組み込む） | [ADR-0002](../decisions/0002-engine-build-vs-reuse.md) |
| クラウドのサービス | TypeScript（Hono）、AWS | 他の題材と同じ |
| ビルド | Cargo を基本に、C++ の部品は GN/Ninja か CMake を呼ぶ | [build-and-test.md](build-and-test.md) で決める |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-languages-and-platform.md) | ブラウザは Rust、サービスは TypeScript と AWS |
| [0002](../decisions/0002-engine-build-vs-reuse.md) | 構造は自作し、成熟した部品を使う |
| [0003](../decisions/0003-multi-process-site-isolation.md) | 複数プロセスとサイトの隔離を、最初から前提にする |
| [0004](../decisions/0004-release-channels-and-updates.md) | 4 つのチャンネルと、4 週ごとのリリース、段階的な自動更新 |
| [0005](../decisions/0005-privacy-first-services.md) | サービスは、送るデータを最小にし、同期は暗号化する |

## 6. リスクと未解決事項

- **互換性の長い尾**：Web の互換性は、少数のサイトの特殊な振る舞いで崩れる。Web Platform Tests と主要サイトの自動検査で追う（[build-and-test.md](build-and-test.md)）。
- **部品の更新**：V8 などの部品の脆弱性の修正に、自分たちの配信が追いつく必要がある（[update-and-release.md](update-and-release.md)）。
- **性能**：自作の部分（レイアウト、ナビゲーション）が、長年最適化された本家に並ぶには時間がかかる。
