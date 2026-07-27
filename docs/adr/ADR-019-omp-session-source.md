# ADR-019: OMP標準file-backed SessionManagerを正本とする

## 決定
新規・既存sessionはOMP SDKの`SessionManager.create/open/list`だけで管理し、Pocket独自session schema/dirを作らない。

## 背景
通常OMP TUIとの双方向resumeとsession format互換性が必要である。

## 選択肢
独自DB、JSONL独自操作、公式SessionManagerを比較した。

## 結果
Host SQLiteはownershipやcursor等の製品metadataだけを持ち、会話本文を二重管理しない。

## 見直し条件
OMPが公式永続化APIを置換するmajor release時。
