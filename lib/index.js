/** 按住听写（push-to-talk）—— host 半侧。
 *
 * 行为全部在 client 半侧（浏览器）：快捷键注册、录音、转写、插入草稿。
 * host 半侧只需让这条行可以被挂载。
 *
 * 依赖 @deepseek-ai/dsh-experimental-voice-input-bundle 提供的 speech Remote
 * （识别服务就绪状态 + 转写调用）；该 bundle 已在 web profile 中启用。
 */

const name = "dsh-voice-ptt";

function apply() {
  // host 半侧有意为空。
}

export { name, apply };
