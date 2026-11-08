// S4 · 读两层配置（47b）：三个粗档位现在在哪一档 + 细配置每一项的值和范围
import { GROUPS } from '../../../shared/habits.js';
import { defineTool } from '../define.js';

export default defineTool({
  name: 'yushe_config_get',
  kind: 'self',
  description: '看你自己的上网配置：三个档位（爱不爱出门 / 读多深 / 互动多少）现在在哪一档，以及细配置每一项的值和能改的范围（出门、读多深、互动上限、偏好、在 B站说话）。爸妈问「你现在怎么设置的」或者想改之前先看一眼时用。',
  params: { group: { type: 'string', enum: Object.keys(GROUPS), description: '只看某一组（不给就全看）' } },
  async run(a, { habits }) {
    const v = habits.view({ withUiChat: true });
    const fine = a.group ? v.fine.filter((g) => g.group === a.group) : v.fine;
    return { ok: true, knobs: v.knobs.map((k) => ({ key: k.key, label: k.label, level: k.level, levels: k.levels })), fine, settingsPage: Object.entries(v.fields).map(([k, f]) => ({ key: k, label: f.label, value: v.habits[k] })), summary: v.summary,
      howToChange: '想改就用 yushe_config_propose 起草（可以给档位，如 {"depth":"深"}，也可以给细项），复述给爸妈听，爸妈同意后再用 yushe_config_apply。「在 B站说话」和爸妈 UID 只能爸妈在设置页改。' };
  },
});
