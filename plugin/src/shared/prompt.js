/**
 * 提示词填变量（F-80 搬家-1）：把 {{名字}} 换成 vars 里的值。纯函数，只做这一件事。
 * 一次扫完：不对换进去的值再替换（值里碰巧有 {{ }} 原样留下）；缺变量直接报错，不悄悄把 {{x}} 发给模型。
 */

/** 把 template 里的 {{名字}} 填成 String(vars[名字])；vars 没有这个名字就抛「提示词缺变量」。 */
export function fill(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (raw, name) => {
    if (!vars || !(name in vars)) throw new Error(`提示词缺变量：${name}`);
    return String(vars[name]);
  });
}
