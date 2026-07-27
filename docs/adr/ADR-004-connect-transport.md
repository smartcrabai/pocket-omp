# ADR-004: Server-streaming下りとUnary batch上り

## 決定
下りはConnect `Subscribe` server-streaming、上りは冪等な`Publish` unary batchとする。

## 背景
Mobile background時のrequest body stream維持を前提にできない。

## 選択肢
Bidi streaming、polling、server-streaming + unaryを比較した。

## 結果
ACKとcursorを明示し、HTTP/1.1でも成立させる。上りは64 envelope / 2 MiBを上限とする。

## 見直し条件
Mobile platformとingressがbidi transportを一貫して保証できる場合。
