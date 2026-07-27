# ADR-011: 隔離Bun Agent Runtime内のOMP SDK

## 決定
OMP SDKはactive sessionごとのBun子processで実行し、Host Daemonへloadしない。

## 背景
Extension、MCP、LSP、provider、native dependencyの障害をRelay接続・鍵・ownershipから隔離する。

## 選択肢
Host内process、OMP RPC mode、専用SDK Runtimeを比較した。

## 結果
Host↔Runtimeはversioned Protobuf IPCを使い、SDK型を境界外へ出さない。

## 見直し条件
OMP SDKが同等のfault isolationを公式提供する場合。
