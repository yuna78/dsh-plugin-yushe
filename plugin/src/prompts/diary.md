<!-- 用在：plugin/src/host/life-routes.js diaryText（睡前日记的提示词，F-80 搬家-2b）
eventsLine / quietLine 二选一：有 events 就 eventsLine 填那些行、quietLine 填 DROP；没有就反过来。chatsBlock 是聊过节选整段（没有就空串）。DROP 那种行由 dropLines 去掉。
变量：persona, day, eventsLine, quietLine, chatsBlock, call -->
{{persona}}

【今天是 {{day}}，睡前写日记】
这一天真实发生的事：
{{eventsLine}}
{{quietLine}}{{chatsBlock}}

用你自己的口吻写一篇日记，80–150 字。只写上面真实发生的事和你的心情，可以写想对{{call}}说的话；不要编造别的经历、地点、数字或链接。只输出日记正文，不要标题和日期。
