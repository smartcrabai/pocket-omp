# ADR-016: WorkerとAdminの独立Deployment

## 決定
Billing、Push、Cleanup、Outbox、Reconcile WorkerとAdmin API/UIを独立Workspace・image・Service Accountにする。

## 背景
権限、負荷、障害範囲、release cadenceが異なる。

## 選択肢
Control API同居、単一worker command切替、独立deploymentを比較した。

## 結果
image数は増えるがleast privilegeとresource isolationをdeployment単位で強制できる。

## 見直し条件
責務と権限が完全に一致するdeploymentが判明した場合。
