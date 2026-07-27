# ADR-018: Admin least privilegeとimmutable audit

## 決定
Adminはprivate ingress、staff SSO、step-up、RBAC、期限付きsupport grant、append-only auditを必須とする。

## 背景
Support操作自体が高いsecurity riskであり、session本文へのアクセスは不要である。

## 選択肢
本番DB直接参照、共通Control API、専用Admin境界を比較した。

## 結果
診断は最小metadataへ限定し、本文・鍵・provider credential・完全pathを返さない。

## 見直し条件
Support workflowまたはregulatory requirement変更時。
