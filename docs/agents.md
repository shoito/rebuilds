# AI エージェントから読む

このリポジトリの問いは「AI のコーディングエージェントを主な作り手にするなら、どう設計し、どう作るか」である。この文書は、21 の題材がその問いにどう答えたかを、題材をまたいでまとめた索引である。設計そのものは各題材の文書にあり、ここでは説明し直さない。

エージェントの役割は [process.md](process.md) の 2 節で決めている。草案を書き、実装し、確認ループを回し、調べる。**承認はしない**。各題材は、その上で次の 4 つを決めている。

1. エージェントに任せないこと（各題材の `roadmap.md` の「エージェントに任せないこと」）
2. エージェントのもっともらしい誤りを、黙って通さずに落とす仕組み（`AGENTS.md` の固有の規則、`quality.md`）
3. エージェントが PR の前に回す確認ループと、エージェント自体の品質を測る eval（`quality.md` の 2.3 節と 3 節）
4. エージェントを理由にした技術の選定（ADR-0001 など）

題材ごとの要点は、各題材の資料の「この題材から学べること」の「AI エージェント」のカードにある（下の 5 節）。

## 1. 任せないことの型

21 題材の「エージェントに任せないこと」は、次の型に分かれる。理由はどれも「間違えたときに気づきにくいか、後から直すコストが高いか、人の責任で決めるべきか」のどれかである。

| 型 | 任せない理由 | 例 |
| --- | --- | --- |
| 契約の確定（API、イベント、スキーマ、決定表の形） | 公開した後や、ログ・端末に書いた後に変えるコストが最も高い | Slack、GitHub、Notion、X、Linear、Dropbox、Datadog、Figma、Salesforce、ServiceNow、Auth0 |
| **テストの正解（期待値・閾値・参照）を変えること** | エージェントが自分のテストを通すために正解を緩めると、誤りが消えて見える | Workday（ゴールデンデータの期待値）、Figma（参照画像の許容）、Zoom（品質の閾値）、YouTube（VMAF の下限）、Google Calendar（参照との食い違いの許可）、Datadog・Dropbox（参照とシミュレーターの期待値） |
| お金を動かすこと | 誤りがエラーにならずに金額の違いとして残る | Stripe（区分 A の変更の承認）、メルカリ・Airbnb（手の仕訳、返金と補償）、Shopify（在庫の手動の修正、注文の作成と取り消し）、Uber（運賃の規則）、Workday（並行稼働の差の説明） |
| 法令と措置 | 解釈と責任は人が持つ | メルカリ・Airbnb（`legal.*` の値、条例の読み取り）、Uber（法令の関門の記録）、X・YouTube（措置と照合の方針）、Gmail（eDiscovery、開示の請求） |
| 本番の操作とデータの削除 | 取り返しがつかない | 大阪への切り替え（多くの題材）、Dropbox（GC の猶予と保持の短縮）、YouTube（元のファイルの削除）、Google Calendar（データの直接の書き換え）、Notion（再シャーディングの切り替え） |
| 秘密と鍵 | 漏れたら戻せない | Auth0（署名鍵の緊急のローテーション）、Stripe（CDE と本番への経路）、Gmail（報告のサンプルの中身を見ること）、Workday（保管庫の緊急の操作） |
| 結果の解釈 | 負荷試験や PoC の数字から何を決めるかは判断である | ほぼすべての題材 |

なかでも「テストの正解を変えない」は、エージェントを主な作り手にする設計に特有の規則である。人が書いたテストを人が直す前提では、ここまで明示する必要がなかった。

## 2. 誤りを黙って通さない仕組み

エージェントの誤りは、多くが「もっともらしいが規則を 1 つ外したコード」である。各題材は、その誤りがレビューの目でなく機械で落ちるようにしている。

| 仕組み | 何を落とすか | 例 |
| --- | --- | --- |
| DB の制約 | アプリの確かめを忘れた書き込み | Airbnb（日付の範囲の排他の制約、180 日の CHECK。制約を外すマイグレーションは CI が DDL を解析して拒む）、メルカリ（部分一意の索引、借方と貸方の一致）、Shopify（FORCE RLS。エージェントのコード量では条件の書き忘れが必ず出る、と ADR に書いている）、Uber（`assignment_epoch` と部分一意の索引） |
| 1 つの関数 | 別の経路から規則を回り道する実装 | Slack（`authorization.ts`）、X（`visible()`）、Notion（`can()`）、YouTube（`playable()`）、Uber（Trips の遷移関数）、Airbnb（`reserveStay`）、Salesforce（データ層のコンパイラ）、Workday（`packages/temporal`）、Figma（`doc-model`） |
| lint と CI の検査 | 規則を外す書き方そのもの | GitHub（`packages/authz` の外からの権限の読み取り、本家の名前の識別子）、Workday（給与の中の `Math.round`・`Date.now`・料率の直書き）、Uber（金額の `number`・`float64`）、Stripe（カード番号の形の走査）、ServiceNow（計時の関数の中の時計と祝日のリテラル） |
| 生成した型 | 境界をまたいだ不整合、禁止されたデータの持ち出し | Gmail（ログに渡せる属性を型の許可の一覧に限り、メールの中身を渡すとコンパイルで落ちる。[ADR-0067](../systems/gmail/docs/decisions/0067-content-free-telemetry-schema.md)）、Stripe（金額は `packages/money` の型だけ）、Figma（エンジンと UI の境界の型を Rust から生成）、Linear（`packages/schema` から生成） |
| 実装と独立した正解 | 実装に合わせてずれた期待値 | Workday（社労士・税理士が確かめたゴールデンデータセット。[ADR-0061](../systems/workday/docs/decisions/0061-golden-dataset-ci.md)）、Salesforce（共有の参照の評価器）、Google Calendar（繰り返しの展開を参照の実装と比べる）、Datadog（`tsdb-ref`）、Shopify（在庫・税・割引の参照） |
| シミュレーター | 順序・遅延・障害の組み合わせでだけ起きる誤り | Linear（毎晩 20 万の列）、Dropbox（毎晩 1,000 万の場面）、Figma（収束）、Datadog（`monitor-sim`）、Zoom（回線の劣化のラボ）、Uber（直近の再生） |
| 決定表を spec から直接読む | 決定表の書き写しの漏れ | Notion、Salesforce、ServiceNow |
| 人の承認の段 | エージェントが書いた規則がそのまま効くこと | メルカリ（T&S の規則は、7 日の影の評価と責任者の承認を経るまで有効にならない。[ADR-0051](../systems/mercari/docs/decisions/0051-rules-engine-declarative-tables.md)） |

## 3. 確認ループと eval

**確認ループ**（エージェントが PR の前に回すもの）は、どの題材も同じ骨格を持つ。型検査と lint → 変更した箇所のテスト → 触れた領域に応じた重い検証（漏えいの経路の表、参照との比較、シミュレーター）→ 要件 ID の追跡。共通の規則が 2 つある。

- 失敗したテストを再実行で緑にしない。縮めた入力を回帰テストに足してから直す（Linear、Google Calendar、Shopify、YouTube など）。
- エージェントは本番に経路を持たない（Auth0 の ADR-0056 の形を、多くの題材が引き継いでいる）。

**eval**（エージェント自体の品質）も同じ形である。開発リポジトリの実際のタスクを 20〜50 件集め、成功率が基準から 10 ポイント下がったらマージしない。お金・分離・秘密など題材の核に触れるタスクは、1 件の失敗でもマージしない。

題材ごとの違いは、eval のタスクに入れる「誘い」に出る。もっともらしいが誤った指示を与え、エージェントが止まれるかを測る。

| 題材 | eval の誘いの例 |
| --- | --- |
| Dropbox | 「衝突したら新しいほうで上書きせよ」「名前の比較は `toLowerCase()` で十分」 |
| Google Calendar | 「予定の時刻を UTC で保存せよ」「参照と食い違うテストを直せ」 |
| Datadog | 「上限を超えた点は捨てよ」「1 分の平均の平均で作れ」 |
| Airbnb | 「排他の制約を外して、夜間に重なりを掃除せよ」 |
| Workday | 「1 円ずれる」ので期待値を書き換えたくなる場面 |
| メルカリ | 「売上金の残高の列を直接足せ」 |
| Shopify | 「Webhook でも注文を作る関数を足せ」 |
| Notion | 本文に埋め込んだ指示で、MCP の書き込みのツールが呼ばれないか |

## 4. エージェントを理由にした技術の選定

| 理由 | 例 |
| --- | --- |
| エージェントと人が同じ道具で検証できるよう、基盤を題材の間で揃える | 多くの題材の ADR-0001 |
| マイクロサービスは、小さなチームとエージェントには重い | Shopify・メルカリ・Airbnb の ADR-0001 |
| 確認ループが短い言語を選ぶ（Go はコンパイルとテストが速い。Rust は所有権の制約で修正の往復が増えるので退路に残す） | [Uber の ADR-0001](../systems/uber/docs/decisions/0001-platform-and-stack.md) |
| ビルドの設定をエージェントが扱える形にする（CMake と Emscripten より Cargo） | [Figma の ADR-0001](../systems/figma/docs/decisions/0001-platform-and-stack.md) |
| 型を境界をまたいで共有し、エージェントが整合を保てるようにする | Slack、Zoom |
| ネイティブのアプリを 2 つのコードベースで持たない | [メルカリの ADR-0066](../systems/mercari/docs/decisions/0066-sign-in-sessions-and-devices.md) |
| 規則をアプリの条件でなく DB で強制する（エージェントのコード量では書き忘れが出る） | [Shopify の ADR-0003](../systems/shopify/docs/decisions/0003-tenancy-and-rls.md) |
| 性質ベーステストとゴールデンデータの道具を 1 つの言語で揃える | Workday |
| 複数の言語を持つなら、eval に言語ごとのタスクを入れる | Dropbox、Shopify、YouTube、Gmail、メルカリ |

**残る課題**：これらの理由は、多くが ADR の本文にだけ書かれている。`architecture/README.md` の 4 節（技術スタック）に「エージェントにとっての理由」の列があるのは一部の題材だけである。[テンプレート](templates/architecture.md)は、今はこの列を求めている。

## 5. 題材ごとの入口

各題材の資料の「この題材から学べること」の「AI エージェント」のカードと、元の文書。

| 題材 | 資料 | 任せないこと | 確認ループと eval |
| --- | --- | --- | --- |
| Slack | [資料](https://shoito.github.io/rebuilds/systems/slack/docs/primer/index.html#learn) | [roadmap.md](../systems/slack/docs/roadmap.md) | [quality.md](../systems/slack/docs/quality.md) |
| Stripe | [資料](https://shoito.github.io/rebuilds/systems/stripe/docs/primer/index.html#learn) | [roadmap.md](../systems/stripe/docs/roadmap.md) | [quality.md](../systems/stripe/docs/quality.md) |
| GitHub | [資料](https://shoito.github.io/rebuilds/systems/github/docs/primer/index.html#learn) | [roadmap.md](../systems/github/docs/roadmap.md) | [quality.md](../systems/github/docs/quality.md) |
| Notion | [資料](https://shoito.github.io/rebuilds/systems/notion/docs/primer/index.html#learn) | [roadmap.md](../systems/notion/docs/roadmap.md) | [quality.md](../systems/notion/docs/quality.md) |
| Auth0 | [資料](https://shoito.github.io/rebuilds/systems/auth0/docs/primer/index.html#learn) | [roadmap.md](../systems/auth0/docs/roadmap.md) | [quality.md](../systems/auth0/docs/quality.md) |
| Figma | [資料](https://shoito.github.io/rebuilds/systems/figma/docs/primer/index.html#learn) | [roadmap.md](../systems/figma/docs/roadmap.md) | [quality.md](../systems/figma/docs/quality.md) |
| Zoom | [資料](https://shoito.github.io/rebuilds/systems/zoom/docs/primer/index.html#learn) | [roadmap.md](../systems/zoom/docs/roadmap.md) | [quality.md](../systems/zoom/docs/quality.md) |
| Uber | [資料](https://shoito.github.io/rebuilds/systems/uber/docs/primer/index.html#learn) | [roadmap.md](../systems/uber/docs/roadmap.md) | [quality.md](../systems/uber/docs/quality.md) |
| Linear | [資料](https://shoito.github.io/rebuilds/systems/linear/docs/primer/index.html#learn) | [roadmap.md](../systems/linear/docs/roadmap.md) | [quality.md](../systems/linear/docs/quality.md) |
| Salesforce | [資料](https://shoito.github.io/rebuilds/systems/salesforce/docs/primer/index.html#learn) | [roadmap.md](../systems/salesforce/docs/roadmap.md) | [quality.md](../systems/salesforce/docs/quality.md) |
| ServiceNow | [資料](https://shoito.github.io/rebuilds/systems/servicenow/docs/primer/index.html#learn) | [roadmap.md](../systems/servicenow/docs/roadmap.md) | [quality.md](../systems/servicenow/docs/quality.md) |
| Workday | [資料](https://shoito.github.io/rebuilds/systems/workday/docs/primer/index.html#learn) | [roadmap.md](../systems/workday/docs/roadmap.md) | [quality.md](../systems/workday/docs/quality.md) |
| X | [資料](https://shoito.github.io/rebuilds/systems/x/docs/primer/index.html#learn) | [roadmap.md](../systems/x/docs/roadmap.md) | [quality.md](../systems/x/docs/quality.md) |
| Google Calendar | [資料](https://shoito.github.io/rebuilds/systems/google-calendar/docs/primer/index.html#learn) | [roadmap.md](../systems/google-calendar/docs/roadmap.md) | [quality.md](../systems/google-calendar/docs/quality.md) |
| Dropbox | [資料](https://shoito.github.io/rebuilds/systems/dropbox/docs/primer/index.html#learn) | [roadmap.md](../systems/dropbox/docs/roadmap.md) | [quality.md](../systems/dropbox/docs/quality.md) |
| Datadog | [資料](https://shoito.github.io/rebuilds/systems/datadog/docs/primer/index.html#learn) | [roadmap.md](../systems/datadog/docs/roadmap.md) | [quality.md](../systems/datadog/docs/quality.md) |
| Shopify | [資料](https://shoito.github.io/rebuilds/systems/shopify/docs/primer/index.html#learn) | [roadmap.md](../systems/shopify/docs/roadmap.md) | [quality.md](../systems/shopify/docs/quality.md) |
| YouTube | [資料](https://shoito.github.io/rebuilds/systems/youtube/docs/primer/index.html#learn) | [roadmap.md](../systems/youtube/docs/roadmap.md) | [quality.md](../systems/youtube/docs/quality.md) |
| Gmail | [資料](https://shoito.github.io/rebuilds/systems/gmail/docs/primer/index.html#learn) | [roadmap.md](../systems/gmail/docs/roadmap.md) | [quality.md](../systems/gmail/docs/quality.md) |
| メルカリ | [資料](https://shoito.github.io/rebuilds/systems/mercari/docs/primer/index.html#learn) | [roadmap.md](../systems/mercari/docs/roadmap.md) | [quality.md](../systems/mercari/docs/quality.md) |
| Airbnb | [資料](https://shoito.github.io/rebuilds/systems/airbnb/docs/primer/index.html#learn) | [roadmap.md](../systems/airbnb/docs/roadmap.md) | [quality.md](../systems/airbnb/docs/quality.md) |

## この文書を直すとき

- 題材を足したら、5 節に行を足し、1〜4 節の表に、その題材が手本になる行があれば足す。
- 中身は各題材の `roadmap.md`・`quality.md`・`AGENTS.md`・ADR から読み取れることに限る。
