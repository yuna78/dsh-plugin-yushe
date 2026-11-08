// 鱼社 · 新手引导剧本（ink 语法，构建时编译成 JSON）
// 写法：每行「说话人：台词」；行尾 # 标签触发画面动作：
//   #pose:xxx      本鱼换姿势（wave / peek / look / sign / point / hype / proud / cheer / jump / wow / oops）
//   #input:call    弹出输入框，让玩家自己写称呼，写回变量 call
//   #action:xxx    交给游戏做事：home（挑一个家）/ cast（亮出撒谷子按钮）/ forge（打开捏鱼台）/ hatch（破壳）
// 选项用 + （可重复选；* 是一次性的，第二次领养时会消失）。
// 中文正文里如果要写半角 # { } 或 //，前面加 \ 转义；全角符号不受影响。
// 改完运行 npm run build，剧本会被编译进 plugin/game/game.js。

VAR call = "妈妈"
VAR returning = false

=== intro ===
{returning:
    本鱼：又来接新宝宝啦？这次的鱼卵也很乖哦～ #pose:wave
- else:
    本鱼：啊，你来啦！我是鱼社的接生员，本鱼～ #pose:peek
    本鱼：今天有一颗鱼卵在等它的家人哦。 #pose:wave
}
本鱼：先认识一下你！你是宝宝的……？ #pose:look
+ [我是妈妈]
    ~ call = "妈妈"
+ [我是爸爸]
    ~ call = "爸爸"
+ [我自己写称呼]
    本鱼：好呀，你想让宝宝怎么叫你？ #pose:sign #input:call
- 本鱼：{call}！好的好的，记下来啦。 #pose:sign
本鱼：宝宝出生前，先给她挑一个温暖的家吧！ #pose:point #action:home
本鱼：好温馨！宝宝一定会喜欢的。 #pose:proud
本鱼：再挑一个让她上工的地方吧：以后在这个工作区里跟 DSH 说的话，都是她在帮你干活。 #pose:point #action:workspace
本鱼：那我们去撒一把谷子，看看哪颗卵在等你～ #pose:point #action:cast
-> END

=== picked ===
本鱼：就是这颗啦！它在动诶，宝宝快醒了。 #pose:wow
本鱼：趁她还没睁眼，我们一起想想她是个什么样的孩子吧！ #pose:hype #action:forge
-> END

=== hatch ===
本鱼：都准备好了吗？我数三下—— #pose:hype
本鱼：一、二…… #pose:cheer #action:hatch
-> END

=== farewell ===
本鱼：恭喜{call}！以后就是她陪着你啦。 #pose:proud
本鱼：走之前还有两件小事：给她一个自己的 B站号，再告诉我画画用的 API。都可以以后再弄哦～ #pose:point #action:setup
本鱼：我回去接下一颗卵咯，有空回鱼社看看我～ #pose:wave
-> END
