---
status: accepted
date: 2026-09-27
---

# ADR-0034: macOS の署名は、Linux の署名専用の実行環境で rcodesign を使い、鍵を CloudHSM に置く

## Context

[ADR-0033](0033-service-infrastructure-and-dr.md) と [update-and-release.md](../architecture/update-and-release.md) の 5.2 節は、macOS の Developer ID の鍵を「署名専用の EC2 Mac の上の、ハードウェアの鍵（スマートカード）」に置く前提だった。EC2 Mac は AWS のデータセンターの Dedicated Host で動き、利用者が USB の機器を挿すことはできない。この前提は成り立たない。

条件は次のとおり。

- 鍵はハードウェアの中で作り、外に出さない。Windows の Authenticode の鍵と同じ扱いにする（[update-and-release.md](../architecture/update-and-release.md) の 5.2 節）。
- 署名は release-signing アカウントの CI だけが行い、人が機器を扱わない（ADR-0033）。
- 公証（notarization）とステープルまで自動で行う。
- 大阪での署名の訓練（[runbooks/README.md](../runbooks/README.md) の 5 節）で、同じ手順が動く。

確かめたこと（2026-09-27）：

- CloudHSM の Client SDK 5（PKCS#11 のライブラリなど）が対応する OS は Linux と Windows Server だけで、macOS はない（[Client SDK 5 の対応プラットフォーム](https://docs.aws.amazon.com/cloudhsm/latest/userguide/client-supported-platforms.html)）。macOS の `codesign` から CloudHSM の鍵を直接は使えない。
- rcodesign（apple-codesign）は、Linux で Mach-O・`.app`・`.dmg`・`.pkg` に署名できる。Hardened Runtime は `--code-signature-flags runtime`、セキュアなタイムスタンプは既定で付く（[README](https://github.com/indygreg/apple-platform-rs/blob/main/apple-codesign/README.md)、[Signing with rcodesign](https://gregoryszorc.com/docs/apple-codesign/main/apple_codesign_rcodesign_signing.html)）。
- rcodesign は PKCS#11 の鍵で署名でき、文書に AWS CloudHSM の例がある（`--pkcs11-library /opt/cloudhsm/lib/libcloudhsm_pkcs11.so`）。ただし PKCS#11 は main に入った未リリースの機能で、最新の版 0.29.0（2024-11-29）には含まれない（[CHANGELOG](https://github.com/indygreg/apple-platform-rs/blob/main/apple-codesign/CHANGELOG.md) の Unreleased）。既定で無効の `pkcs11` の Cargo の機能で、glibc の版のバイナリが要る。鍵の生成と取り込みは HSM の道具で行う（[PKCS#11 (HSM) Support](https://gregoryszorc.com/docs/apple-codesign/main/apple_codesign_pkcs11.html)、[Getting Started](https://gregoryszorc.com/docs/apple-codesign/main/apple_codesign_getting_started.html)）。
- CloudHSM の PKCS#11 は `CKM_RSA_PKCS`・`CKM_ECDSA` などの署名の方式を持ち、rcodesign の使う方式に合う（[CloudHSM の PKCS#11 の方式](https://docs.aws.amazon.com/cloudhsm/latest/userguide/pkcs11-mechanisms.html)）。
- Apple は Developer ID の鍵をハードウェアに置くことを求めていない。証明書は Account Holder が CSR から作る（[Create Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)）。ハードウェアに置くのは、この題材の方針である。
- rcodesign は、App Store Connect の API キー（Issuer ID、Key ID、`.p8` の秘密鍵）で公証を出し、結果を待ってステープルできる（`notary-submit --wait --staple`、`staple`）（[Notarizing and Stapling with rcodesign](https://gregoryszorc.com/docs/apple-codesign/main/apple_codesign_rcodesign_notarizing.html)）。公証には Team の API キーが要り、個人の API キーは使えない（[Creating API keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)）。公証は Developer の役割でできる（[Roles](https://developer.apple.com/help/account/access/roles/)）。Apple の `notarytool` も同じ API キーを受け付ける（[TN3147](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool)）。
- rcodesign の遠隔の署名（remote signing）は、文書で alpha とされ、監査を受けていない（[Remote Code Signing](https://gregoryszorc.com/docs/apple-codesign/main/apple_codesign_remote_signing.html)）。
- AWS KMS の非対称鍵を、rcodesign や `codesign` から直接使う方法は、公式の文書にない。KMS を PKCS#11 で見せる橋は第三者のものだけである。
- EC2 Mac は AWS のデータセンターの Dedicated Host で、利用者の機器をつなぐ手段は文書にない（[EC2 Mac](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html)）。

## Options

1. **Linux の署名専用の実行環境で rcodesign を使い、Developer ID の鍵を CloudHSM に置く（PKCS#11）。公証とステープルも rcodesign で行う**
2. **自社で持つ Mac（データセンターかコロケーション）に、USB の HSM か YubiKey（PIV）を挿し、Apple の `codesign` で署名する**
3. **KMS の非対称鍵で署名する**（rcodesign に KMS の署名器を足すか、PKCS#11 と KMS の橋を使う）
4. **遠隔の署名**：鍵を持つ機械を人が起動し、CI が rcodesign の remote signing で署名を頼む

## Decision

1 を採用する。

- **鍵**：Developer ID Application（と、`.pkg` のための Developer ID Installer）の RSA 2048 の鍵を、release-signing の CloudHSM の中で作り、外に出さない。Authenticode の鍵と同じクラスタで、別の CU（crypto user）に分ける。CSR は CloudHSM の鍵から作り（rcodesign の `generate-certificate-signing-request` の PKCS#11 の引数か、CloudHSM の OpenSSL の連携で）、Account Holder が Apple の Developer のサイトで証明書に替える。
- **署名**：release-signing の署名専用の CI の実行環境（Linux、CloudHSM のクライアントを入れた EC2）で、rcodesign が署名する。rcodesign は、PKCS#11 を含む main のコミットに固定し、`pkcs11` の機能を有効にしてソースからビルドする。PKCS#11 を含む版がリリースされたら、その版に移る。Hardened Runtime（`--code-signature-flags runtime`）、entitlements、セキュアなタイムスタンプを付ける。PKCS#11 の PIN（CU の資格情報）は Secrets Manager に置き、署名の工程のロールだけが読める。
- **公証**：App Store Connect の Team の API キー（Developer の役割）を release-signing の Secrets Manager に置く。rcodesign の `notary-submit --wait --staple` で公証し、チケットをステープルする。API キーは公証だけに使い、1 年ごとに作り直す。
- **検証**：署名の後、ci アカウントの EC2 Mac（ビルド・テスト用のもの）で、`codesign --verify --deep --strict`、`spctl --assess`、`xcrun stapler validate` を流し、合わなければリリースの工程を止める。この Mac は鍵に触れない。
- DMG の作成（`hdiutil`）は ci の EC2 Mac で行い、rcodesign は DMG そのものへの署名だけに使う（rcodesign は DMG の中身を再帰的に署名しない。[Known Issues](https://gregoryszorc.com/docs/apple-codesign/main/apple_codesign_quirks.html)）。中の `.app` は DMG に入れる前に署名する。
- **署名専用の EC2 Mac を持たない。** [infrastructure.md](../architecture/infrastructure.md) の 6 節の「EC2 Mac（release-signing）常時 2 ホスト」はなくす。
- **E9 の `macos-signing-poc` で確かめること**：rcodesign と CloudHSM で署名した `.app` が、Apple の公証と Gatekeeper の検査を通る。CloudHSM の鍵から Apple に受け付けられる CSR を作れる。大阪に復元した CloudHSM で同じ手順が動く。1 つでも満たせなければ、2 に切り替え、この ADR を改める ADR を書く。決まるまで macOS の Stable は出さない（ADR-0033 の注記）。
- 2 を採らない理由：人が物理の機器と機械を管理する。自社の拠点の設備と、大阪での訓練にあたる予備の拠点が要る。ただし Apple の `codesign` をそのまま使えるので、1 が PoC で合わないときの代わりにする。
- 3 を採らない理由：KMS の鍵を使う Apple のコード署名の道具が、公式にはない。自作の署名器は、署名の形式の誤りのリスクを自分たちで持つ。
- 4 を採らない理由：alpha で監査を受けていない。署名のたびに人の操作が要り、緊急の修正（NFR-006）の時間の予算に合わない。

## Consequences

- 良くなること：
  - 物理の機器がなく、Authenticode・GPG と同じ CloudHSM・同じバックアップ・同じ大阪の訓練で扱える。
  - 署名の工程から EC2 Mac の Dedicated Host（最低 24 時間の確保）が消え、費用と台数が減る。
- 引き受けるコスト：
  - Apple の公式の道具ではない rcodesign の、未リリースの機能に依存する。上流の保守が止まったら、PKCS#11 の部分を自分たちで保守するか、2 に移る。Apple の署名の形式の変更に、rcodesign の上流が追いつくまで待つことがある。版を固定し、検証の段（Apple の `codesign`・`spctl`）で必ず確かめる。
  - rcodesign を `pkcs11` の機能付きでソースからビルドし、部品の目録（ADR-0030）で管理する。
  - CloudHSM の CU の資格情報が、署名の実行環境の Secrets Manager に置かれる。署名の工程のロール以外が読めないことを IAM Access Analyzer で確かめる（ADR-0033 の Confirmation）。

## Confirmation

- リリースの工程で、署名した macOS の成果物ごとに、`codesign --verify --deep --strict`、`spctl --assess --type execute`、`xcrun stapler validate` の結果を記録し、失敗したら配信を止める。
- 半年ごとの大阪での署名の訓練（[runbooks/README.md](../runbooks/README.md) の 5 節）に、macOS の署名と公証を含める。
- Developer ID の証明書の期限の 60 日前の更新（[runbooks/README.md](../runbooks/README.md) の 3 節）を、CloudHSM の中の新しい鍵と CSR で行う手順を `signing-key-rotation.md` に書く。
