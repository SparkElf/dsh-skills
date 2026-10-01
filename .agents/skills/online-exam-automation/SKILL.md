---
name: online-exam-automation
description: Use when asked to take or complete an online exam in a logged-in browser — 在线考试/答题/结业考试/资格考试, 尤其是限次数的考试（如"仅限10次机会"）。Covers reading the paper, the limited-attempt risk model, how to probe which click mechanism actually works on an unfamiliar exam page, the four structural traps (all-questions-on-one-page, unknown click target, synthetic events ignored, sequence≠display order), and verified fill/verify/submit scripts.
---

# 在线考试自动化

考试和刷课是**两种风险评估**，流程不能照搬。刷课错了可以重播，考试错了就消耗一次机会。

**默认姿态：先把机械动作做对，再把答案交给人确认，绝不盲目提交。**

一条贯穿全程的原则：**先侦察，再动手。** 大多数考试页在"进入"和"开始"之间没有强边界，一旦误触就开始倒计时并占用尝试次数。所以任何写操作之前，先用只读方式把试卷读出来。

## 四个结构性陷阱（实测踩过，务必先确认）

课程页和考试页长得像，行为却不同。拿课程页的经验套考试页，我一次错掉了 45 题。

**① 全部题目可能渲染在同一个长页面里。**
课程页习惯是"一次显示一题、侧边栏切换"；考试页常常把 45 题一次性铺开，每题一个容器：

```
.question-type-item[data-dynamic-key="<questionId>"]
```

此时侧边栏点击只是**滚动定位**，不是切换。判定方法：数一下 `.question-type-item` 的数量；如果等于总题数，就是单页布局。

**② 选项的可点目标常常不是你以为的那个元素。**
选项结构通常是：

```html
<dd>
  <div class="radio"><input type="radio" id="D798radio-1"></div>
  <label for="D798radio-1">
    <div class="pointer"><span class="option-num">B.</span><div>选项文字</div></div>
  </label>
</dd>
```

本次实测：点外层 `div.pointer` **没有任何反应**，点 `label[for]` 才行。但这**不是通用规律**——换个平台可能正好相反。所以不要凭猜，**用 `probe-click.mjs` 实测**（见下一节）。

**③ JS 事件经常无效。**
在 label 上派发 `click()` / `MouseEvent` 可能完全不生效——这类前端框架只认可信输入。是否真的需要真实鼠标事件，同样用 `probe-click.mjs` 判定。

**④ 题号 `sequence` ≠ 答题卡显示序号。**
试卷数据里每题的 `sequence` 是乱序的（本次实测：单选占 3–11、20–35，多选占 1、12–36，判断占 2、37–45），而答题卡按 `单选→多选→判断` 顺序显示为 1..45。**按 `sequence` 去点侧边栏会定位到完全错误的题。** 必须按"题型分组内的出现顺序"换算：

```
display = 前面题型的总题数 + 本题型内序号 + 1
```

这条映射错了会让**每一题的答案都落到别的题上**，而脚本仍然报告成功。所以它单独有回归测试：

```bash
node scripts/test-mapping.mjs
```

## 先测点击方式，再批量作答

这是整个技能里最贵的一课。第一次作答时我沿用了课程页的点击方式，结果 **45 题全部"成功"、实际一题都没记上**——脚本按自己的假设回读状态，把失败读成了成功。

所以流程强制分成两步：

```bash
# 1) 实测哪种点击方式真的能改变选中状态（只动一道题，结束后还原）
node scripts/probe-click.mjs

# 2) 确认后再批量，且先只做一题
node scripts/fill-exam.mjs answers.json --write --probe 1
```

`probe-click.mjs` 会依次尝试六种机制，每次都回读真实的 `checked` 状态，只把**确实改变了选中状态**的那些标为 WORKS：

| 机制 | 说明 |
| --- | --- |
| `js:input.click` | 对 `<input>` 派发合成点击 |
| `js:label.click` | 对 `label[for]` 派发合成点击 |
| `js:pointer-dispatch` | 对 `div.pointer` 派发 mousedown/mouseup/click |
| `mouse:pointer` | **真实鼠标**点 `div.pointer` |
| `mouse:label[for]` | **真实鼠标**点 `label[for]` |
| `mouse:input` | **真实鼠标**点 `<input>` |

输出示例（本次真实结果）：

```
  -    js:input.click       option B  ∅ → ∅
  -    js:label.click       option B  ∅ → ∅
  -    js:pointer-dispatch  option B  ∅ → ∅
  -    mouse:pointer        option B  ∅ → ∅
  WORKS mouse:label[for]    option B  ∅ → B
  -    mouse:input          option B  ∅ → ∅
```

结论一目了然：只有真实鼠标点 `label[for]` 有效。探测完脚本会把该题**还原到探测前的状态**，不留脏数据。

`--probe 1` 做的是同一件事的端到端版本：按正式流程答一题，若回读结果与预期不符就**立即停止**，不碰其余题目。两道关卡都通过后，再跑全量。

如果 `probe-click.mjs` 报 "NO WORKING CLICK METHOD FOUND"，说明这个页面的选项机制不在已知的六种之内——去读 `dd` 的 HTML，往 `METHODS` 里加候选，而不是硬跑批量。

## 工作流

### 0. 接管浏览器

与刷课相同：浏览器需带调试端口，Chrome 136+ 对默认 user-data-dir 拒绝开放端口。见 `scripts/cdp.mjs`。

### 1. 只读侦察（必做）

```bash
node scripts/inspect-exam.mjs <examUrlOrTabFilter>
```

输出：题量与题型分布、**单页/逐题布局判定**、`sequence → 显示序号 → questionId → 题干` 对照表、限时与已答状态。

它**只读不写**。确认结构后再进行下一步。

### 2. 准备答案

答案写成一个 JSON 文件，键用**显示序号**（人类核对时看的就是它）：

```json
{ "1": "B", "2": "A", "26": "ABCD", "36": "A" }
```

判断题用 `A`=正确 / `B`=错误（DOM 里就是 dd[0]=正确、dd[1]=错误）。

答案来源优先级：**官方教材/法规原文 > 课程内容 > 公开题库**。涉及法规条文的题（罚款数额、期限天数、密级划分）务必查原文，公开题库的答案经常互相矛盾或已过期。用 `web_search` 交叉验证，至少两个独立来源一致再采用。

### 3. 先测点击方式

**不要跳过这一步。** 这是唯一能防住"全部报告成功、实际一题没答"的关卡。

```bash
node scripts/probe-click.mjs
```

只动一道题，实测六种点击机制，结束后还原该题。只有真正改变了 `checked` 状态的机制才会被标成 WORKS。详见上文「先测点击方式，再批量作答」。

### 4. 作答（不提交）

```bash
# 默认是 dry run，只校验映射，不点任何东西
node scripts/fill-exam.mjs answers.json

# 先只答一题，确认无误
node scripts/fill-exam.mjs answers.json --write --probe 1

# 全量
node scripts/fill-exam.mjs answers.json --write
```

逐题点击并**每题回读 `checked` 状态校验**；不一致会明确报错而不是静默跳过。脚本结束只报告"已答 N / 未答 M"，**不会提交**。

### 5. 独立复核

```bash
node scripts/verify-exam.mjs answers.json
```

重新从页面读取每题实际选中项，与答案文件逐一比对。这一步是刻意与上一步解耦的：如果两个脚本共用同一份内存状态，第一遍的 bug 会被第二遍原样复制。

### 6. 提交（需要用户明确同意）

**先拿到用户的明确同意再交卷。** 限次数的考试没有撤销。

```bash
node scripts/submit-exam.mjs --yes
```

脚本会先自检"未答题数必须为 0"，否则拒绝提交；然后真实点击「我要交卷」→ 处理二次确认弹窗 → 校验 `submitPaper` 返回 `status:1`。确认按钮的文字可能带空格（"确 定"），脚本按去空格后匹配。

### 7. 复盘


```bash
node scripts/exam-result.mjs
```

拉取成绩与逐题判分（接口返回每题 `isRight`），输出错题及其题干，便于针对性补漏。

## 红线

- **不要盲目提交。** 交卷前必须满足：题题已答 + 独立复核一致 + 用户同意。
- **不要在限次数的考试里试错。** 拿不准的题先查原文；宁可留空一道，也不要用"点一下看看"的方式探索界面。
- **不要一次错一整套。** 先用 `inspect-exam.mjs` 确认布局，再用**一道题**验证点击方式（点完回读 checked），确认有效后才批量执行。我在真实考试里因为跳过这一步，第一轮 45 题全部空转。
- **不要假设两个页面的 DOM 一样。** 同一个平台的不同考试模块也可能不同。
- **时区与计时**：考试有倒计时，脚本要检查剩余时间再决定是否开跑；临近结束优先保证已答内容被提交。

## 常见故障

**点了选项但 `checked` 仍是 false**
点错元素了（见陷阱②），或者用了 JS 派发事件（见陷阱③）。检查是否命中 `label[for]`。

**侧边栏点击后题目没变**
多半是单页布局——点击只滚动。改为直接在题目容器内定位。

**`page.evaluate` 报 "Too many arguments"**
Playwright 的 `evaluate` 只接受一个参数。把多个值打包成对象传入。

**提交后页面自动关闭**
正常流程。用新标签页重新打开专题页查看成绩。

**401 / Access is Denied**
会话 token 过期，刷新页面后重试。

## 边界

这个技能处理的是**机械层面**：读题、点选、校验、提交、取分。答案的正确性取决于题源质量和你提供的资料，脚本不会替你判断对错。

考试本质上是能力评估。默认把全流程做透明：题目、答案、依据、错题复盘都留档，让使用者能自己复核——如果使用者的目标是学习而非交差，给出的错题复盘比分数本身更有用。
