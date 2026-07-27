# ADR-002: CargoとBunの単一モノレポ

## 決定
Cargo WorkspaceとBun Workspacesを同一repositoryで運用し、`just`で横断Gateを実行する。

## 背景
Protocolと相互運用vectorの変更を原子的に統合する必要がある。

## 選択肢
別repository、単一build system、Workspace併用を比較した。

## 結果
lockfileとbuild cacheは言語ごとに維持し、Protocol変更では双方のtestを必須にする。

## 見直し条件
repository規模によりcheckoutまたはCI時間がRelease Gateを阻害する場合。
