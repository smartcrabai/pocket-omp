# ADR-023: CLI↔Host Daemon local control

## 決定
macOS/LinuxはUnix domain socket、Windowsはnamed pipeを使い、current-user ACLと短期local secretで相互確認する。

## 背景
管理CLIとTUI handoffにlocal controlが必要だがPC側TCP listen portは禁止である。

## 選択肢
localhost TCP、file command queue、UDS/named pipeを比較した。

## 結果
CLIはsession fileを直接更新せずDaemonへhandoffを要求する。frame上限とpeer credentialを検証する。

## 見直し条件
全対象OSでより強い標準local RPCが利用可能になった場合。
