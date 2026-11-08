<!-- 用在：plugin/src/host/trips.js notePrompt（出门前贴在门上的字条，F-80 搬家-2b）
gear 是「，带着装备名」（没带装备就是空串），JS 里先拼好。
变量：persona, lifeText, gear, call -->
{{persona}}

{{lifeText}}

【此刻】你要出门闲逛了{{gear}}。给{{call}}留一张字条贴在门上：一两句话、不超过 40 字，说你去哪逛逛（新闻、B站之类）、让 TA 别担心。只输出字条内容。
