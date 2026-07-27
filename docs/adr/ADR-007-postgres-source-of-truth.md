# ADR-007: PostgreSQLを配送の正本とする

## 決定
暗号文、sequence、cursorはPostgreSQLへ保存し、Redisはwake-up、durable invalidation、rate limitだけに使う。

## 背景
Redis notification lossをmessage lossへ波及させてはならない。

## 選択肢
Redis Streams正本、Kafka正本、PostgreSQL正本を比較した。

## 結果
Redis停止時はDB pollingへdegradeする。transactional outboxで通知を補完する。

## 見直し条件
PostgreSQLのsequence hotspotが実測上解消不能になった場合。
