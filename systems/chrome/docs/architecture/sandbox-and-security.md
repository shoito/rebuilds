# Sandbox and Security: Chrome

脅威モデル、OS ごとのサンドボックス、サイトの隔離を強制する箇所、メモリ安全性の方針、攻撃の緩和、脆弱性への対応、セキュリティの UI。

| 関連 | 決定 |
| --- | --- |
| [ADR-0001](../decisions/0001-languages-and-platform.md) | ブラウザは Rust。`unsafe` は 1 か所ずつレビューする |
| [ADR-0002](../decisions/0002-engine-build-vs-reuse.md) | 構造は自作し、成熟した部品（V8 など）を使う |
| [ADR-0003](../decisions/0003-multi-process-site-isolation.md) | 複数プロセスとサイトの隔離を最初から前提にする |
| [ADR-0004](../decisions/0004-release-channels-and-updates.md) | 4 つのチャンネル、段階的な自動更新 |
| [ADR-0019](../decisions/0019-os-sandbox-baseline.md) | OS ごとのサンドボックスを Rust で自作し、プロセスの種類ごとの基準を決める |
| [ADR-0020](../decisions/0020-memory-safety-and-unsafe-policy.md) | Rule of 2 を Rust に当てはめ、`unsafe` と C/C++ の部品の置き場所を決める |

プロセスの構成と IPC は [process-model.md](process-model.md)、ファズとテストの基盤は [build-and-test.md](build-and-test.md)、更新の署名と配信は [update-and-release.md](update-and-release.md)、Safe Browsing・権限・パスワードは [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) にある。

## 1. 目標と前提

- **Renderer は侵害されるものとして設計する。** 目標は「侵害を防ぐ」ではなく「侵害されても、そのサイトの外に出さない」である（ADR-0003）。
- **最も重い障害は、サンドボックスの外でのコードの実行**（Browser プロセスの侵害）と、**サイトの隔離の破れ**（他のサイトの Cookie・保存領域・パスワードが読める）。どの統制も、まずこの 2 つを防ぐ。
- 重大度の区分と修正の期限は、本家 Chromium の基準に寄せる（7 節）。利用者に届けるまでの時間は NFR-006（Stable への配信の開始から 48 時間で Stable の 90%）で縛る。
- 本家 Chromium のセキュリティの FAQ と同じく、**同じ OS 利用者の権限で動くマルウェアと、端末を物理的に操作できる攻撃者は、防御の対象外**とする。ただし、保存したデータの暗号化（[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) の 6 節）で、盗まれたディスクからの読み出しは難しくする。

## 2. 脅威モデル

### 2.1 攻撃者

| 攻撃者 | できること | 主な守り |
| --- | --- | --- |
| Web の攻撃者 | 利用者に悪意あるページを開かせる。任意の HTML・JS・画像・フォント・動画を送る | Renderer のサンドボックス、サイトの隔離、Safe Browsing、権限の確認 |
| 侵害された Renderer | Renderer の中で任意のコードを実行する（上の攻撃が成功した後）。任意の IPC を送る | Browser 側の検査（3 節）、OS のサンドボックス（4 節）、不正な IPC で Renderer を終了 |
| 悪意ある拡張機能 | 与えられた権限の範囲で、ページの内容を読み書きし、拡張機能の API を呼ぶ | Manifest V3 の権限、ホストの権限の確認、ストアの審査、拡張機能の強制停止（[extensions.md](extensions.md)） |
| ネットワークの攻撃者 | 通信の盗聴・改ざん、DNS の偽装、HTTP への格下げ | TLS 1.3、証明書の検証と CT、HSTS、HTTPS-First、DNS over HTTPS（[networking.md](networking.md)） |
| 局所の攻撃者 | 同じ端末の別の OS 利用者、盗まれたディスク | OS の権限、保存データの暗号化（OS の鍵ストア） |
| 供給網の攻撃者 | 部品・依存関係・ビルド・更新の配信の改ざん | 依存関係の審査（ADR-0020）、再現可能なビルド、更新の署名（[update-and-release.md](update-and-release.md)） |
| サービスの内部者 | クラウドのサービスのデータを読む | 送るデータの最小化と E2EE（ADR-0005） |

### 2.2 攻撃の連鎖と守りの層

実際の攻撃は、Renderer の侵害（例：V8 の型の混乱）と、サンドボックスの脱出（例：Browser プロセスの IPC の処理の欠陥、OS のカーネルの欠陥）を組み合わせる。1 つの層が破れても次の層で止まるよう、層ごとに独立した守りを置く。

```
Web のコンテンツ
  │ ① 解析器・V8 の欠陥 ── 守り：メモリ安全な実装（Rust）、V8 のサンドボックス、ファズ
  ▼
侵害された Renderer（1 サイト分のデータだけ）
  │ ② IPC の悪用 ── 守り：Browser 側の検査（3 節）、IPC の型と境界の検査
  │ ③ OS への直接の攻撃 ── 守り：OS のサンドボックス（4 節）、システムコールの制限
  ▼
Browser プロセス・OS（利用者の全データ）
```

## 3. サイトの隔離を強制する箇所

Renderer は、自分のサイト（スキーム＋登録可能ドメイン）に鍵をかけたプロセス（process lock）で動く。Browser 側は、**Renderer が名乗るオリジンを使わず**、そのプロセスの鍵と、Browser が知っているフレームのオリジンで判断する（ADR-0003）。検査に落ちた IPC は「不正な IPC」として扱い、その Renderer を終了させ、報告を記録する（個人のデータは含めない）。

| 対象 | 強制する箇所 | 検査の内容 |
| --- | --- | --- |
| ナビゲーションの確定（commit） | Browser（ナビゲーション） | 確定するオリジンが、そのプロセスの鍵と合う |
| Cookie | Network サービス | 要求元のプロセスの鍵から決めたサイトの Cookie だけを返す。`document.cookie` も同じ |
| 保存領域（localStorage、IndexedDB、Cache Storage） | Storage サービス | Browser が発行した保存キー（StorageKey）で開く。Renderer が送るオリジンは使わない |
| サブリソースの応答 | Network サービス | クロスサイトの no-cors 応答は、ORB（Opaque Response Blocking）で、HTML・JSON などを Renderer に渡さない |
| postMessage、BroadcastChannel | Browser | 送り手のオリジンを Browser が付ける |
| パスワード・自動入力 | Browser（パスワードマネージャ） | 入力する値を、鍵の合うフレームにだけ渡す |
| 権限（カメラ・位置など） | Browser（権限） | 要求元のオリジンを、Browser が知るフレームから決める |
| 拡張機能の API | Browser（拡張機能） | 呼び出し元が拡張機能のプロセスか、コンテンツスクリプトかで使える API を分ける |
| `file:`、内部ページ（`<brand>://`） | Browser | 専用のプロセスに分け、Web のプロセスから開けない |

- 検査を 1 か所の関数（プロセスの鍵とオリジンの照合）に集め、個別の実装で判定を書かない。
- 侵害された Renderer を模したテストで、上の各行を拒否できることを確かめる（[quality.md](../quality.md) の 2.5 節）。

## 4. OS ごとのサンドボックス

Browser プロセスが仲介者（broker）、他のプロセスが対象（target）になる。対象のプロセスは、起動後の初期化を終えたら、元に戻せない形で権限を落とす。ファイル・ネットワーク・デバイスが必要なときは、IPC で Browser やサービスに頼む（ADR-0019）。

### 4.1 プロセスの種類ごとの基準

| プロセス | 基準 | 主な理由 |
| --- | --- | --- |
| Browser | なし（利用者の権限） | UI、プロファイル、仲介。信頼できない複雑な入力を、ここで `unsafe` なコードで解析しない（5 節） |
| Renderer（Web、拡張機能） | 最も強い | V8 と、HTML・CSS・画像の解析を行う |
| Utility（音声・動画の復号、画像、PDF、アーカイブの展開） | 最も強い（種類ごとに調整） | C/C++ の復号器を動かす |
| Network サービス | 中 | ソケットとファイル（キャッシュ・Cookie）が要る |
| Storage サービス | 中 | プロファイルのディレクトリだけに触れる |
| GPU | 弱 | ドライバの制約で強くできない。代わりに Renderer から送れる命令を限る |

- Stable で、サンドボックスなしの対象プロセスを動かさない。サンドボックスを外す起動の引数は、開発版と CI の中だけで効く。
- 初期のサンドボックスの強さの目標値（各行）は、本家 Chromium の設計に寄せる。GPU と Network サービスをどこまで絞れるかは、実装で確かめる（未検証）。

### 4.2 Windows

本家 Chromium の Windows のサンドボックスの設計に寄せる。

- **制限したトークン**：特権を外し、Renderer は整合性レベル「untrusted」、GPU は「low」で動かす。
- **ジョブ オブジェクト**：子プロセスの生成、クリップボード、ウィンドウのメッセージの一斉送信、画面の設定の変更を禁止する。
- **別のデスクトップ**：Renderer を別のデスクトップに置き、他のウィンドウへのメッセージ（shatter 攻撃）を防ぐ。
- **AppContainer（LPAC を含む）**：Network サービスなど、ファイルやネットワークが要るプロセスは、必要な ACL だけを与えた AppContainer で動かす（適用の範囲は未検証。実装の段で確かめる）。
- **プロセスの緩和策**：win32k のシステムコールの禁止（Renderer）、署名のない DLL の読み込みの禁止（CIG）、Control Flow Guard、ASLR の強制、ヒープの破損の検出。
- 本家は、サンドボックスの中からのファイルなどへのアクセスを、NT の API の横取り（interception）で Browser に仲介する。ここでは**横取りを作らない**。Renderer は最初からファイルを開かない設計にし、必要なものは IPC で受け取る（ADR-0019）。

### 4.3 macOS

- **Seatbelt**（`sandbox(7)`）のプロファイル（SBPL）を、プロセスの種類ごとに持つ。既定は `(deny default)` で、必要なものだけを許す。共通の部品は 1 つのファイルにまとめる（本家の `common.sb` と同じ形）。
- 子プロセスは、特権のある初期化を終えてから、Browser から IPC で受け取ったプロファイルを適用する。
- アプリ全体は Hardened Runtime で署名し、V8 の JIT に要る権限（JIT の entitlement）は Renderer と Utility のうち必要なものにだけ与える（ヘルパーのアプリを分ける）。

### 4.4 Linux

- **第 1 層：名前空間**。ユーザー・PID・ネットワークの名前空間に入れ、他のプロセスとネットワークを見せない。能力（capability）を外し、ダンプできないようにする。
- **第 2 層：seccomp-bpf**。プロセスの種類ごとに、許すシステムコールと引数を絞る。カーネルの攻撃面を減らす。
- 非特権のユーザー名前空間を使えない配布版（AppArmor で制限する配布版など）のために、setuid の補助プログラムか、配布版向けの AppArmor のプロファイルを同梱する。対象の配布版と方法は未検証で、E5 の Story で確かめる。
- ファイルを開く必要のあるプロセスには、Browser 側の仲介（broker）プロセスを付ける。

## 5. メモリ安全性の方針（Rule of 2）

本家 Chromium の「Rule of 2」は、次の 3 つのうち**2 つまでしか同時に持たない**という規則である。

1. 信頼できない入力（複雑な文法、信頼できない出所）
2. 安全でない実装の言語（C、C++、アセンブリ）
3. 高い権限（サンドボックスの外）

Rust で作るこのブラウザでは、2 を「C/C++ の部品」と「`unsafe` を含む Rust」と読み替える（ADR-0020）。

| 処理 | 入力 | 言語 | 権限 | 判定 |
| --- | --- | --- | --- | --- |
| HTML・CSS の解析、DOM | 信頼しない | 安全な Rust | Renderer（低） | 可 |
| JavaScript（V8） | 信頼しない | C++ | Renderer（低） | 可（2 つ） |
| 画像の復号 | 信頼しない | 安全な Rust の復号器を優先 | Renderer（低） | 可 |
| 動画・音声の復号 | 信頼しない | C/C++ の復号器 | Utility（低） | 可（2 つ） |
| IPC の受信（Browser 側） | 信頼しない（侵害された Renderer） | 安全な Rust のみ | Browser（高） | 可。`unsafe` を持ち込めない |
| 拡張機能のマニフェスト、同期のデータ、更新の目録、Safe Browsing のリスト | 信頼しない | 安全な Rust のみ | Browser（高） | 可。C/C++ の解析器を使うなら Utility に移す |
| ZIP などのアーカイブの展開（ダウンロードの検査） | 信頼しない | C の部品を使うなら | Utility（低） | 可 |

- **Browser プロセスで、信頼できない入力を `unsafe` なコードや C/C++ で解析しない。** 必要なら Utility プロセスに出し、結果を単純な型で受け取る。
- `unsafe` は既定で禁止（クレートの単位で `forbid`）。許すクレート（FFI、IPC の共有メモリ、割り当て器など）を目録で管理し、`unsafe` のブロックごとに安全である理由を書き、セキュリティの担当がレビューする（ADR-0001・ADR-0020）。
- 第三者のクレートは、監査の記録（cargo-vet の形式）と、既知の脆弱性の検査（RustSec の勧告）を CI で必須にする。

## 6. 攻撃の緩和

| 緩和策 | 対象 | 方針 |
| --- | --- | --- |
| Control Flow Guard | Windows | Rust は `-C control-flow-guard`、C/C++ の部品は `/guard:cf` で有効にする |
| CET のシャドースタック | Windows | 対応する CPU で有効にする（`/CETCOMPAT`）。V8 の JIT との両立は未検証 |
| clang の CFI | Linux の C++ の部品 | 間接呼び出しの CFI を、部品のビルドで有効にできるか確かめる。Rust との言語をまたぐ CFI は、rustc で安定していないため MVP では使わない |
| V8 のサンドボックス（ヒープの隔離） | Renderer | 有効にする。V8 のヒープの破損が、プロセスの他の領域に及びにくくする |
| MiraclePtr 相当（解放後の使用の緩和） | 自作の部分 | **不要**。所有権と借用の検査で、安全な Rust では解放後の使用が起きない。FFI で C++ のオブジェクトを指す箇所は、ハンドルの型で包み、生のポインタを保持しない |
| 整数のあふれの検査 | 解析器のクレート | リリースのビルドでも有効にする。性能への影響は測って決める（未検証） |
| ASLR、DEP、スタックの保護 | 全体 | OS とツールチェインの既定を有効のまま使う |

## 7. 脆弱性への対応

### 7.1 受付と重大度

- 受付の窓口：公開の報告の窓口（Web のフォームと暗号化したメール）、バグ報奨金（7.3 節）、内部のファズ、部品の上流からの通知。
- 受け付けたら 1 営業日以内に、重大度を付け、担当を決める。
- 重大度は、本家 Chromium の基準に寄せる。

| 重大度 | 定義 | 例 |
| --- | --- | --- |
| Critical | 任意の資源（ファイル、ネットワーク）を読み書きできる | Web のコンテンツから届く、Browser プロセスのメモリの破損。サンドボックスのない実行 |
| High | 他のオリジンとしてコードを実行する、クロスオリジンのデータを読む | Renderer の中のメモリの破損、UXSS、サイトの隔離の破れ。サンドボックスの脱出（侵害された Renderer が前提のため High） |
| Medium | 限られた情報を読み書きできる。単独では害がないが、組み合わせると害がある | 特定の拡張機能が入っているときだけのメモリの破損 |
| Low | 本来は上位だが、緩和の要因が極めて大きい | 1 バイトの境界外の読み出し、特殊な操作が要る Renderer のメモリの破損 |

### 7.2 修正の期限

| 区分 | 修正を Stable で出すまで | 利用者に届けるまで |
| --- | --- | --- |
| 実際に悪用されている（in the wild） | 7 日以内（本家の目標と同じ）。内部の目標は、公表から Stable への配信の開始まで 24 時間 | Stable への配信の開始から 48 時間で Stable の 90%（NFR-006） |
| Critical | 30 日以内に全利用者へ（本家の目標と同じ） | 同上 |
| High | 60 日以内に全利用者へ（本家の目標と同じ） | 同上 |
| Medium | 次のメジャーリリース | 通常の段階的な配信 |
| Low | 計画に入れる | 通常の段階的な配信 |

- **上流の部品（V8 など）の修正**：上流の修正が公開された時点から、差分の解析で悪用が始まりうる（パッチの空白）。上流の Critical・High の修正は、上流の公開から 3 日以内に Stable の修正の版の配信を始め（内部の目標）、そこから NFR-006 で届ける。上流の修正の公開の予定を事前に知る手段（上流の配布者の事前通知の枠組みに入れるか）は、未解決の問い（E10）。
- 修正は、開発ブランチでは中身のわからない件名でコミットし、リリースのブランチへの取り込みと同時に公開する。
- 報告の詳細は、修正を全利用者へ届けた後に公開する。公開までの期間は本家の運用（修正の後、一定の週数で公開）に寄せる。本家の具体的な週数は未検証。
- CVE の採番のために、CNA になるかは未解決の問い。
- 手順は [runbooks/emergency-security-release.md](../runbooks/emergency-security-release.md)（0-day と上流の部品の緊急の修正を含む）。

### 7.3 バグ報奨金

- 本家の Chrome VRP の構造に寄せ、「メモリの破損は基本額に、到達できるプロセスと、示した悪用の度合いで倍率をかける」形にする。サンドボックスの脱出と、Browser プロセスのメモリの破損を最も高くする。
- 対象：ブラウザ（全チャンネル）、クラウドのサービス（同期、Safe Browsing、更新の配信、ストア）。
- 上流の部品（V8 など）の欠陥は、上流の報奨の窓口へ案内する。組み込み方の欠陥（バインディング、FFI の境界）は対象にする。
- 金額と、運営の基盤（自前か報奨の仲介の事業者か）は、未解決の問い。

## 8. ファズ

基盤とジョブの構成は [build-and-test.md](build-and-test.md) にある。ここでは対象と優先順位を決める。

| 優先 | 対象 | 方法 |
| --- | --- | --- |
| 1 | Browser 側の IPC の受け口 | 侵害された Renderer を模し、任意の IPC の列を送る（構造を持つファズ） |
| 1 | FFI の境界（V8 のバインディング、C/C++ の部品） | libFuzzer（cargo-fuzz）。ASan を有効にした部品と組む |
| 2 | HTML・CSS・URL の解析器、画像・フォントの復号 | libFuzzer と、文法に基づく生成 |
| 2 | DOM と JavaScript の組み合わせ | 文法に基づく DOM の生成器、JavaScript のファズ（Fuzzilli の形） |
| 3 | ネットワーク（HTTP/2 のフレーム、QUIC、DNS）、Safe Browsing のリストの更新、同期のデータ、拡張機能のマニフェスト | libFuzzer |

- 解析器・FFI の境界を変えたら、ファズの対象に含まれていることを CI で確かめる（[AGENTS.md](../../AGENTS.md)）。
- ファズで見つかった欠陥は、自動で重大度の案を付けて起票し、7 節の期限で扱う。
- 常時ファズを回す基盤（ClusterFuzz の自前の運用か、OSS-Fuzz に参加するか）は、ソースを公開するかどうかに依存する（未解決の問い）。

## 9. セキュリティの UI

| 要素 | 方針 |
| --- | --- |
| オリジンの表示 | アドレスバーは、登録可能ドメインを強調し、パスやクエリより優先して表示する。狭いときはホストの左側を省く。国際化ドメイン名は、紛らわしい文字の組み合わせを Punycode で表示する（本家の IDN の表示の方針に寄せる） |
| HTTPS の表示 | HTTPS は「安全」と言わず、中立のアイコン（サイトの情報の入口）にする。HTTP は「保護されていない通信」と表示する |
| 警告の画面 | Safe Browsing、証明書の誤り、HTTPS-First の警告は、ページの内容と区別できる全画面の警告にする |
| 死線（line of death） | 権限の確認、パスワードの提案、ダイアログは、ページが描けない領域（アドレスバーに結び付けた吹き出し）に出す。ページの内容でブラウザの UI を偽装できないようにする |
| 全画面 | 全画面に入るときにオリジンと解除の方法を表示し、キー入力のロックは確認の後だけ |
| JavaScript のダイアログ | 出したオリジンを表示する。他のタブから前面に出せない |

UI の部品の設計は [browser-ui.md](browser-ui.md) にある。

## 10. 品質・運用・データへの引き継ぎ

- [quality.md](../quality.md) に入れたもの（2.2.1・2.5・2.6 節）：
  - サンドボックスの脱出のテスト：各 OS で、Renderer・Utility から、ファイルの読み書き、ソケット、子プロセスの生成、禁止したシステムコールを試み、拒否されることを確かめる。
  - 侵害された Renderer のテスト：3 節の表の各行を、任意の IPC で破ろうとして拒否されることを確かめる。
  - ファズ：8 節の対象の網羅と、実行の時間の目標。
  - セキュリティの回帰テスト：修正した脆弱性ごとに、再現の入力をテストに残す。
- [runbooks/](../runbooks/README.md) に入れたもの：0-day（悪用されている脆弱性）への対応と、上流の部品の緊急の修正の取り込みは [emergency-security-release.md](../runbooks/emergency-security-release.md)。
- [data-model.md](data-model.md) の索引に入れたもの（1.4 節）：プロセスの種類ごとのサンドボックスのプロファイル（ビルドに含める設定）、不正な IPC の報告（クラッシュの報告の一部。個人のデータを含めない）、`unsafe` の許可の目録、第三者のクレートの監査の記録。

## 11. 未解決の問いと未検証の事項

- 上流の部品（V8 など）の修正の公開を事前に知る手段。NFR-006 の起点は Stable への配信の開始と決めた（[README.md](README.md) の「決定」）。上流の公開から配信の開始までは、3 日の内部の目標で追う。
- CNA になるか。バグ報奨金の金額と運営。
- ソースを公開するか（OSS-Fuzz への参加、外部の研究者の参加に影響する）。
- 未検証：Windows で Network サービス・GPU を LPAC で動かせる範囲、CET と V8 の JIT の両立、Linux の配布版ごとのユーザー名前空間の制限、整数のあふれの検査の性能への影響、本家が報告を公開するまでの週数。E5 の Story の中で、実機と公式の資料で確かめる。

## References

- Chromium: [Sandbox（Windows の設計）](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/design/sandbox.md)
- Chromium: [Mac Sandbox](https://chromium.googlesource.com/chromium/src/+/HEAD/sandbox/mac/README.md)
- Chromium: [Linux Sandboxing](https://chromium.googlesource.com/chromium/src/+/HEAD/sandbox/linux/README.md)
- Chromium: [The Rule of 2](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/security/rule-of-2.md)
- Chromium: [Severity Guidelines for Security Issues](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/security/severity-guidelines.md)（重大度の定義、Critical 30 日・High 60 日・悪用あり 7 日の目標）
- Chromium: [Security FAQ](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/security/faq.md)（物理的・同じ利用者の攻撃者を対象外とする）
- Google Bug Hunters: [Chrome Vulnerability Reward Program Rules](https://bughunters.google.com/about/rules/chrome-friends/chrome-vulnerability-reward-program-rules)
- Rust: [rustc の codegen の選択肢（control-flow-guard）](https://doc.rust-lang.org/rustc/codegen-options/index.html)
