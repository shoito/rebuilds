---
status: accepted
date: 2026-09-26
---

# ADR-0023: パスワードは OS の鍵ストアで守る鍵で暗号化し、同期は E2EE、漏洩の確認は k-匿名性で行う

## Context

パスワードは、ブラウザが扱う最も機微なデータである。ADR-0005 で、同期のパスワードはサービスの運営者にも読めない形で保存すると決めた。端末での保存の方法と、漏洩したパスワードの確認の方法を決める必要がある。

- 本家の Password Checkup は、ハッシュの接頭辞（k-匿名性）と秘匿集合演算で、ユーザー名とパスワードの組を Google に明かさずに照会する。
- Have I Been Pwned の Pwned Passwords の範囲 API は、パスワードの SHA-1 の先頭 5 文字だけを送り、応答に詰め物を加えて件数を隠せる。利用の許諾・帰属の表示は不要で、商用にも使える。
- 本家の Google Password Manager のパスキーは、端末だけが持つ鍵で暗号化して保存する（E2EE）。

## Options

1. **端末は OS の鍵ストアで守るデータ鍵で暗号化し、同期は E2EE、漏洩の確認はパスワードのハッシュの接頭辞（k-匿名性）で行う**
2. **1 に加え、漏洩の確認をユーザー名とパスワードの組の秘匿集合演算で行う（本家と同じ）**
3. **同期はサーバー側の鍵で暗号化し、漏洩の確認はサーバーで行う**

## Decision

1 を採用する。詳細は [safe-browsing-and-permissions.md](../architecture/safe-browsing-and-permissions.md) の 6 節。

- 端末：パスワードの値を、プロファイルごとのデータ鍵で AES-256-GCM で暗号化する。データ鍵は Windows の DPAPI、macOS のキーチェーン、Linux の Secret Service で守る。表示・書き出しの前に OS の再認証を求める。
- 同期：記録ごとに、同期の鍵（[sync-and-accounts.md](../architecture/sync-and-accounts.md)）から導いたパスワード用の鍵で暗号化する。サービスは暗号文だけを持つ。サービスに鍵を預ける回復の手段は作らない。
- 漏洩の確認：パスワードの SHA-1 の先頭 5 文字だけを、OHTTP の中継を通して送る。照会先は Pwned Passwords のデータの自前の写しか、範囲 API。
- 2 は、ユーザー名との組の漏洩のデータの入手と、秘匿集合演算の実装・運用が要る。MVP の後に検討する。
- 3 は、ADR-0005 に反する。

## Consequences

- 良くなること：
  - サービスが侵害されても、パスワードは読まれない。漏洩の確認でも、パスワードもユーザー名もサービスに渡らない。
- 引き受けるコスト：
  - 同期の鍵を失った利用者は、同期したパスワードを取り戻せない（回復用のコードで補う）。
  - パスワードだけの確認は、「そのサイトの、その組が漏れた」を区別できず、よく使われるパスワードも「漏洩」と出る。
  - Linux で鍵ストアが無い環境では、端末での保護が弱い。

## Confirmation

- 同期のサービスの DB に平文のパスワードが無いことを、定期の検査で確かめる（ADR-0005）。
- 漏洩の確認の通信に、5 文字を超えるハッシュ・ユーザー名・URL が含まれないことを、テストで確かめる。
- 鍵の合わないフレームに、パスワードの値が渡らないことを、侵害された Renderer を模したテストで確かめる。

## References

- Have I Been Pwned: [API v3（Pwned Passwords）](https://haveibeenpwned.com/API/v3)
- Google Online Security Blog: [Protect your accounts from data breaches with Password Checkup（2019-02）](https://security.googleblog.com/2019/02/protect-your-accounts-from-data.html)
- Google: [More users can now save passkeys in Google Password Manager（2024-09）](https://blog.google/innovation-and-ai/technology/safety-security/google-password-manager-passkeys-update-september-2024/)
