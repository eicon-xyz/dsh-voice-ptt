# dsh-voice-ptt

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的按住听写（push-to-talk）：**在输入框里按住一个键说话，松开即转写**，文字插入当前草稿。

不用记组合键。按住 **F2**，松开，完事。

---

## 怎么用

1. 把光标放进输入框。当输入框获得焦点且草稿为空时，工具栏会出现一行淡提示：`按住 F2 听写`。
2. **按住 F2** —— 开始录音，提示变成 `正在录音，松开 F2 结束`。
3. **松开** —— 音频被转写，文字落在草稿的光标处。

听写过程中：

- 按 `Esc`，或按**任何别的键**（比如你本来想打的那个字母），立即取消并丢弃本次录音。
- 窗口失焦、或切走标签页，会取消录音，而不是录下无关的声音。
- 超过识别服务上限会自动停止录音，并转写已经录到的部分。

## 换键

那行提示**本身就是按钮**。点它展开候选键，点一个即生效并记住（存在 `localStorage`）。

| 键 | 说明 |
| --- | --- |
| **F2**（默认） | 功能键：不产生字符，冲突最少 |
| F4 | 功能键，位置更靠右 |
| Insert | 全尺寸键盘上右手好按；很多笔记本没有这个键 |
| 右 Ctrl | 右手小指按住最顺手 |
| 右 Shift | 右手小指；在 Windows 上连按 5 次可能触发粘滞键 |

修饰键也能正常工作：插件知道按住键**本身就是修饰键**，因此不会把它误判成组合键而放行事件。

提示文字、状态条和上面这些键名都会跟随 DSH 的界面语言（`en` / `zh`）。

想提供别的键，改 `lib/client.js` 顶部的 `KEY_OPTIONS`（一个 `{code, labelKey}` 数组，`code` 按 `KeyboardEvent.code` 的拼写，`labelKey` 指向 `lib/client.js` 顶部 zh / en 词典里的键名）。

## 安装

```sh
dsh plugin --profile web add dsh-voice-ptt
```

包声明了 `dsh.bundle.patch`，所以这条命令会把它追加到 profile 的 bundle 栈并挂载 —— 不需要手工编辑 `cordis.patch.yml`。从 Git 仓库安装时建议锁定 revision：

```sh
dsh plugin --profile web add 'github:eicon-xyz/dsh-voice-ptt#<commit>'
```

需要语音识别服务：安装并启用 `@deepseek-ai/dsh-experimental-voice-input-bundle`，并准备一次识别模型（约 230 MB）。若识别服务未就绪，按住键会在状态条给出可见原因，而不是静默失败。

### 开发模式

```sh
# 直接挂载本地 checkout，而不是安装
ln -sfn "$PWD" "$DSH_HOME/profiles/web/node_modules/dsh-voice-ptt"
# 然后在 profile 自己的 cordis.patch.yml 里加：
#   - insert:
#       - id: dsh-voice-ptt
#         name: 'dsh-voice-ptt'
```

**切换到 bundle 通道前，必须先删掉这段手工挂载行**，否则同一行会被挂载两次。

## 为什么单键要自己接管键盘

官方快捷键服务（`@deepseek-ai/dsh-client-shortcuts`）**只派发 `keydown`** —— 没有 `keyup` 事件可以用来结束"按住"。它还拒绝不带修饰键的绑定（`bindingIssue` 返回 `modifier-required`），并且在 Web 端把组合限制在一份平台白名单内。

所以"按住一个键说话"无法表达成快捷键命令。本插件改为自己接管键盘：文档级 `keydown` 开始，`keyup` 结束。代价是它无法出现在**设置 → 快捷键**里 —— 这也是换键入口做在输入框里的原因。

### 不让单键变成"第二个修饰键"

| 情况 | 行为 |
| --- | --- |
| 焦点不在输入框里 | 不开始录音 |
| 录音期间按了任何别的键 | 取消本次采集；那个键照常工作（按住右 Ctrl 再按 A，`Ctrl+A` 依然生效） |
| 弹窗或菜单打开时 | 让出按键 |
| 带修饰键的按下（`Ctrl+F2`、`Alt+F2` 等） | 完全不拦截 |
| 焦点在终端里 | 不拦截（xterm 自己要用功能键） |

## 实现要点

- **插入草稿**用会话作用域的 `inputActions`（`captureInsertion` + `insertText`）。插件在 `conversation.input.left` 注册一个常驻条目来登记每个会话的动作；同一个条目同时渲染状态条、焦点提示和键位选择器。
- **录音**用 `MediaRecorder`，经 `OfflineAudioContext` 重采样成 16 kHz 单声道 PCM16 WAV —— 与官方语音输入插件发送的格式一致 —— 然后调用 host 的 `speech.transcribe`。
- **host 半侧是有意为空的。** 所有行为都在浏览器半侧，通过 `dsh.client` 触达。

## 文件

| 路径 | 用途 |
| --- | --- |
| `lib/client.js` | 浏览器半侧：按键、录音、转写、状态条、键位选择器 |
| `lib/index.js` | host 半侧（有意为空，只为让 bundle 行可挂载） |
| `cordis.patch.yml` | 安装器合并的 `dsh.bundle.patch` 层 |
| `test/` | 无头 Chrome 端到端测试 |

## 测试

它们驱动真实浏览器、连接一个正在运行的 DSH web profile，并把自带的音频夹具喂给 Chrome 的假麦克风：

```sh
npm install                       # 提供 ws
export PTT_TOKEN=<dsh web URL 里的 token>
node test/e2e.cjs                 # 按住 → 松开 → 文字插入草稿
node test/picker.cjs              # 选择器打开、新键生效并持久化
node test/modifier-key.cjs        # 右 Ctrl 可录音；Ctrl+A 不被抢占
node test/nonempty-draft.cjs      # 草稿非空时仍可用，文字追加在后面
node test/modal-yield.cjs         # 弹窗打开时让键，关闭后恢复
```

`test/make-fixture.cjs` 可以从任何 Chrome 能解码的音频重新生成 `test/fixtures/speech-16k.wav`：

```sh
node test/make-fixture.cjs input.mp3        # 需要 Chrome；不需要 ffmpeg
```

## 已知限制

- 只在 Web 端生效（Desktop 原生键盘桥接未接线到本插件）。
- 没有流式字幕：松开后才出文字。
- 从不自动发送 —— 转写结果只进草稿，由你确认。
- 同一时刻只监听一个按住键；不改 `KEY_OPTIONS` 的话只能从内置候选键里选。

## 许可证

MIT
