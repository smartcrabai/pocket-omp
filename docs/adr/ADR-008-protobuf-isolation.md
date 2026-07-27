# ADR-008: 生成Protobuf型のAdapter隔離

## 決定
Protobuf生成型はProtocol/Adapter層だけで参照し、Domain/Application型へ必ず変換する。

## 背景
Wire互換性とDomain不変条件は異なる変更理由を持つ。

## 選択肢
生成型を全層で共有、手書きwire型、Adapter mappingを比較した。

## 結果
mapping codeは増えるがwire変更がCoreへ漏れない。Rust Relayはsession/runtime descriptorをlinkしない。

## 見直し条件
Protobuf以外の言語間契約へmajor移行するとき。
