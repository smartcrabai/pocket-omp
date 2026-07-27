# ADR-022: Host↔Runtime length-prefixed Protobuf IPC

## 決定
stdin/stdout上で`uint32_be length + pocket.omp.runtime.v1.RuntimeFrame`を交換する。

## 背景
SDK raw eventを漏らさず、process isolationとgeneration fencingを両立する必要がある。

## 選択肢
JSON lines、OMP RPC、専用binary Protobufを比較した。

## 結果
stdoutはIPC専用、physical 1 MiB / logical 32 MiB、chunk hash、heartbeat、request correlationを強制する。

## 見直し条件
IPC transportまたはRuntime process model変更時。
