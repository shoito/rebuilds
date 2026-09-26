---
status: accepted
date: 2026-09-27
---

# ADR-0024: 攻撃の防御の判定をハッシュの前の 1 つの段にまとめ、数は Valkey、ブロックは DB に持つ。識別子の HMAC と既知の端末の Cookie で数える

## Context

クレデンシャルスタッフィングとパスワードの総当たりは、IdP への最も多い攻撃である。本家 Auth0 は、ブルートフォースの防御（1 つの IP から 1 つの識別子への失敗が既定 10 回で止める。30 日・解除のリンク・パスワードの変更・管理者で解除）と、不審な IP の抑制（IP ごとのトークンのバケツ。既定でログインは 1 日 100 回）を持ち、応答を外すと監視のモードになる（[Brute-Force Protection](https://auth0.com/docs/secure/attack-protection/brute-force-protection)、[Suspicious IP Throttling](https://auth0.com/docs/secure/attack-protection/suspicious-ip-throttling)、[Support の記事](https://support.auth0.com/center/s/article/Default-values-for-Suspicious-IP-Throttling)、2026-09-27 に確認）。

本システムに固有の事情：

- Argon2id の計算は重く、攻撃そのものが CPU の DoS になる（[ADR-0004](0004-credential-storage.md)）。
- 日本の携帯の回線の CGNAT と企業の NAT で、多くの正規の利用者が 1 つの IP を共有する。K5 は誤ブロック 0.1% 以下を求める（[intent.md](../intent.md)）。
- Valkey は失われうる（[ADR-0005](0005-authentication-path-availability.md)）。
- アカウントの有無を明かさない（[ADR-0015](0015-database-connection-password-and-enumeration.md)）。
- NIST SP 800-63B-4 は、連続の失敗を 100 回以下に制限し、締め出しを減らす手段としてボットの検知のチャレンジやリスクに応じた判断を挙げる（3.2.2 節）。OWASP は、既知の端末を署名付きの Cookie で見分け、未知の端末だけをまとめて締め出す方式を示している（[Device Cookies](https://owasp.org/www-community/Slow_Down_Online_Guessing_Attacks_with_Device_Cookies)）。

## Options

1. **判定をハッシュの前の 1 つの段（許可リスト → IP のバケツ → ボット → 識別子 × IP）にまとめる。数は Valkey の Lua で原子的に数え、ブロックに達したら DB に行を書く。識別子はテナントの鍵の HMAC で数え、既知の端末の Cookie を持つ要求は識別子 × 端末で数える**
2. 本家と同じく、識別子 × IP と IP のバケツだけ。数もブロックも Valkey だけ
3. エッジ（WAF）のレート制限だけで守る

## Decision

1 を採用する。

- 段の順序はテナントの許可リスト、不審な IP のバケツ、ボットの検知、ブルートフォース、資格情報の照合。
- 数はユーザーの有無によらず数える。ブロックの画面は有無で変えない。
- 既定値は本家に合わせる（10 回・30 日、ログイン 100／1 日 100、サインアップ 50／1 日 72,000）。再設定の要求とユーザー名の接続のサインアップのバケツを足す。
- テナントのバケツに加えて、テナントをまたぐプラットフォームのバケツ（IP ごとのログインの失敗）を持つ。
- アカウントのロック（全 IP）は既定で無効。
- 防御ごとに `mode: off | monitor | enforce` を持つ。
- Valkey が落ちたら、タスクのメモリーの数で続ける。DB のブロックは効き続ける。
- 2 は、CGNAT の正規の利用者を攻撃者と一緒に止め、Valkey を失うとブロックが消える。
- 3 は、識別子ごとの数を持てず、分散した低速の攻撃を止められない。WAF は後ろ盾として使う（[infrastructure.md](../architecture/infrastructure.md) の 4.3 節）。

## Consequences

- 良くなること：
  - 攻撃の要求は Argon2id に届く前に落ちる。
  - 既知の端末の利用者は、同じ IP の攻撃で締め出されない。
  - 監視のモードで、閾値の影響を見てから有効にできる。
- 引き受けるコスト：
  - 既知の端末の Cookie を消した利用者・新しい端末の利用者は、共有の IP で攻撃があると止まりうる。
  - Valkey の障害中は、タスクの数だけ上限が緩む。
  - プラットフォームのバケツは、テナントをまたいで IP の数を使う。法務の L1 で整理が要る。

## Confirmation

- 性質ベーステスト：識別子 × IP が上限に達した後、その組で Argon2id が呼ばれない。トークンのバケツは任意の 24 時間で「容量＋補う数」を超えて通さない。`monitor` は止めない。ユーザーの有無で応答が同じ。
- 決定表のテスト：[attack-protection.md](../architecture/attack-protection.md) の 13.1 節。
- 模擬の試験（E8）：K5 の基準。

## References

- 設計の詳細：[attack-protection.md](../architecture/attack-protection.md) の 3・4・8・10 節
