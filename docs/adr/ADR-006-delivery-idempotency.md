# ADR-006: At-least-once配送とApplication冪等性

## 決定
Network配送はrecipient単位の順序付きat-least-once、command実行はHostの永続`command_id`でexactly-onceにする。

## 背景
切断とretry下でnetwork exactly-onceは保証できない。

## 選択肢
At-most-once、network exactly-onceの擬似保証、at-least-once + endpoint冪等化を比較した。

## 結果
Relayは`sender_device_id + message_id`、Hostは`command_id`、Mobileは`event_id + revision`で重複排除する。

## 見直し条件
配送Protocolのmajor version変更時。
