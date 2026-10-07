// 按住听写（push-to-talk）—— client 半侧（ModuleLoader 预打包格式）。
//
// 交互：按住 F2 开始录音，松开即停止并转写，识别文字插入当前草稿。
//
// 为什么是单键、为什么要自己监听：
//   dsh-client-shortcuts 只派发 keydown，没有 keyup；而且它的组合校验要求
//   必须带 Ctrl/Alt 这类修饰键（bindingIssue: "modifier-required"），
//   浏览器端还要过一层组合白名单。因此「按住一个单键说话」这个交互
//   由本插件自己接管：文档级 keydown 开始、keyup 结束。
//
// 三条安全边界（避免单键变成第二个修饰键、或抢走弹窗的操作）：
//   * 按住期间按下任何其它键 → 取消本次采集（见 onKeyDown）；
//   * 弹窗/菜单打开、焦点在终端里 → 让出按键，不开始录音；
//   * 带 Ctrl/Alt/Shift/Meta 的 F2 不拦截，留给浏览器与系统。
//
// 录音与转写复用已启用的语音输入 bundle 提供的 speech Remote：
// follow 流给就绪状态，transcribe 做识别。草稿插入需要会话作用域的
// inputActions，本插件在 conversation.input.left 注册一个常驻组件登记它，
// 同时兼作录音状态显示。

window.__ModuleLoader__.load({
  id: "dsh-voice-ptt",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");

    var NAME = "dsh-voice-ptt";
    /** 词典命名空间。 */
    var NS = "voice-ptt";
    /** 可按住的候选单键。功能键不产生字符；右侧修饰键由右手小指按住最顺手。 */
    var KEY_OPTIONS = [
      { code: "F2", labelKey: "key.F2" },
      { code: "F4", labelKey: "key.F4" },
      { code: "Insert", labelKey: "key.Insert" },
      { code: "ControlRight", labelKey: "key.ControlRight" },
      { code: "ShiftRight", labelKey: "key.ShiftRight" }
    ];
    /** 默认键：功能键，不输入字符，冲突最少。 */
    var DEFAULT_HOLD_CODE = "F2";
    /** localStorage 中记住用户选择。 */
    var STORE_KEY = NAME + "/hold-key";
    /**
     * 候选键自身对应的修饰位。按住修饰键做听写时，必须忽略它自己这一位，
     * 否则「带修饰键的按键不拦截」这条规则会把按住键本身也挡掉。
     */
    var OWN_MODIFIER = {
      ControlRight: "ctrlKey",
      ControlLeft: "ctrlKey",
      ShiftRight: "shiftKey",
      ShiftLeft: "shiftKey",
      AltRight: "altKey",
      AltLeft: "altKey",
      MetaRight: "metaKey",
      MetaLeft: "metaKey"
    };

    /** 读取用户选择；无存储时用默认键。 */
    function readHoldCode() {
      try {
        var saved = localStorage.getItem(STORE_KEY);
        if (saved && KEY_OPTIONS.some(function (option) {
          return option.code === saved;
        })) return saved;
      } catch (error) {
        /* 隐私模式等场景下不可读，退回默认 */
      }
      return DEFAULT_HOLD_CODE;
    }

    /** 键名（用于提示文案与候选按钮），经词典本地化。 */
    function holdLabel(code, t) {
      var found = KEY_OPTIONS.find(function (option) {
        return option.code === code;
      });
      return found ? t(found.labelKey) : code;
    }
    /** 本仓库 UI 原语使用的弹窗/菜单选择器（与 dsh-client-shortcuts 判定一致）。 */
    var MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="menu"]';
    /** 输入框槽位条目 id。 */
    var SLOT_ID = "voice-ptt";
    /** 终态提示（错误/提示）自动消失时间，避免长期占住输入框工具行。 */
    var NOTICE_MS = 4000;

    var zh = {
      "shortcut.noready": "输入框尚未就绪",
      hint: "按住 {key} 听写",
      pick: "选择按住键：",
      "key.F2": "F2",
      "key.F4": "F4",
      "key.Insert": "Insert",
      "key.ControlRight": "右 Ctrl",
      "key.ShiftRight": "右 Shift",
      requesting: "请允许使用麦克风…",
      recording: "正在录音，松开 {key} 结束",
      transcribing: "识别中…",
      empty: "未识别到语音",
      conflict: "草稿已变化，识别文字未能插入",
      failed: "语音识别失败：{message}",
      unavailable: "语音识别尚未就绪，请先在语音插件详情中准备识别模型",
      permission: "麦克风权限未开启，请在浏览器和系统设置中允许访问",
      unsupported: "当前浏览器不支持录音",
      tooLarge: "录音超过服务限制，请缩短后重试",
      cancelled: "已取消语音输入"
    };
    var en = {
      "shortcut.noready": "The composer is not ready yet",
      hint: "Hold {key} to dictate",
      pick: "Hold key:",
      "key.F2": "F2",
      "key.F4": "F4",
      "key.Insert": "Insert",
      "key.ControlRight": "Right Ctrl",
      "key.ShiftRight": "Right Shift",
      requesting: "Allow microphone access…",
      recording: "Recording — release {key} to finish",
      transcribing: "Transcribing…",
      empty: "No speech recognized",
      conflict: "The draft changed; the transcript was not inserted",
      failed: "Speech recognition failed: {message}",
      unavailable: "Speech recognition is not ready. Prepare the model in the voice plugin details first.",
      permission: "Microphone access is disabled. Allow it in browser and system settings.",
      unsupported: "This browser cannot record audio",
      tooLarge: "The recording exceeds the service limit. Try a shorter one.",
      cancelled: "Voice input cancelled"
    };

    /** 极简可观察值：状态条与控制器之间共享，避免额外依赖。 */
    function createStore(initial) {
      var value = initial;
      var listeners = new Set();
      return {
        get: function () {
          return value;
        },
        set: function (next) {
          value = next;
          for (var fn of Array.from(listeners)) {
            try {
              fn();
            } catch (error) {
              console.error(NAME + ": status listener failed", error);
            }
          }
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () {
            listeners.delete(listener);
          };
        }
      };
    }

    /** 采集失败；message 是词典键，由调用方本地化。 */
    function RecordingError(kind) {
      var error = new Error(kind);
      error.kind = kind;
      error.name = "RecordingError";
      return error;
    }

    /** 单声道浮点采样编码为 Host 接受的 16 kHz PCM16 WAV。 */
    function encodeWave(samples) {
      var bytes = new Uint8Array(44 + samples.length * 2);
      var view = new DataView(bytes.buffer);
      var text = function (at, value) {
        for (var i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
      };
      text(0, "RIFF");
      view.setUint32(4, bytes.length - 8, true);
      text(8, "WAVE");
      text(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true);
      view.setUint32(28, 32000, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      text(36, "data");
      view.setUint32(40, samples.length * 2, true);
      for (var i = 0; i < samples.length; i++) {
        var sample = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      }
      return bytes;
    }

    /** 录音二进制转 base64（无 data URL 前缀）。 */
    function audioBase64(bytes) {
      var text = "";
      for (var i = 0; i < bytes.length; i += 8192) {
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      return btoa(text);
    }

    /** 一次麦克风采集：录制、重采样与释放共享同一个 disposal Promise。 */
    function Recording(onDispose) {
      this.onDispose = onDispose;
      this.stream = undefined;
      this.recorder = undefined;
      this.context = undefined;
      this.chunks = [];
      this.lifetime = new AbortController();
      this.disposal = undefined;
    }

    Recording.prototype.start = async function () {
      var devices = navigator.mediaDevices;
      if (!devices || typeof MediaRecorder === "undefined") throw RecordingError("unsupported");
      var stream;
      try {
        stream = await devices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotAllowedError") throw RecordingError("permission");
        throw error;
      }
      if (this.lifetime.signal.aborted) {
        stream.getTracks().forEach(function (track) {
          track.stop();
        });
        throw RecordingError("cancelled");
      }
      this.stream = stream;
      try {
        this.context = new AudioContext();
        this.recorder = new MediaRecorder(stream);
        this.recorder.ondataavailable = (event) => {
          if (!this.lifetime.signal.aborted && event.data.size > 0) this.chunks.push(event.data);
        };
        this.recorder.start();
      } catch (error) {
        await this.dispose();
        throw error;
      }
    };

    /** 结束采集并重采样为 16 kHz WAV。 */
    Recording.prototype.stop = async function (maxDurationSeconds) {
      var recorder = this.recorder;
      var context = this.context;
      if (!recorder || !context || recorder.state !== "recording") {
        await this.dispose();
        throw RecordingError("empty");
      }
      try {
        await new Promise(function (resolve, reject) {
          recorder.onstop = function () {
            resolve();
          };
          recorder.onerror = function () {
            reject(RecordingError("empty"));
          };
          recorder.stop();
        });
        this.stream?.getTracks().forEach(function (track) {
          track.stop();
        });
        this.lifetime.signal.throwIfAborted();
        var blob = new Blob(this.chunks, { type: recorder.mimeType });
        if (blob.size === 0) throw RecordingError("empty");
        var decoded = await context.decodeAudioData(await blob.arrayBuffer());
        this.lifetime.signal.throwIfAborted();
        var frames = Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * 16000));
        var offline = new OfflineAudioContext(1, frames, 16000);
        var source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start();
        var resampled = await offline.startRendering();
        this.lifetime.signal.throwIfAborted();
        return encodeWave(resampled.getChannelData(0));
      } finally {
        await this.dispose();
      }
    };

    Recording.prototype.dispose = function () {
      if (!this.disposal) {
        var closing = Promise.withResolvers();
        this.disposal = closing.promise;
        this.release().then(closing.resolve, closing.reject);
      }
      return this.disposal;
    };

    Recording.prototype.release = async function () {
      this.lifetime.abort(RecordingError("cancelled"));
      if (this.recorder?.state === "recording") this.recorder.stop();
      this.stream?.getTracks().forEach(function (track) {
        track.stop();
      });
      this.stream = undefined;
      var context = this.context;
      this.context = undefined;
      this.chunks = [];
      try {
        if (context && context.state !== "closed") await context.close();
      } finally {
        this.onDispose();
      }
    };

    /** 释放一次采集；释放期错误不影响用户可见结果。 */
    async function disposeQuietly(recording) {
      try {
        await recording.dispose();
      } catch (error) {
        /* 已释放或释放失败，均无需上报 */
      }
    }

    /** 面板当前是否处于可识别状态：连接正常且所选 Provider 已就绪。 */
    function usableCatalog(snapshot) {
      var catalog = snapshot.catalog;
      if (!snapshot.connected || !catalog) return undefined;
      var provider = (catalog.providers || []).find(function (item) {
        return item.id === catalog.selection.providerId;
      });
      var phase = provider && provider.preparation && provider.preparation.phase;
      if (phase !== "ready" && phase !== "standby" && phase !== "waking") return undefined;
      return catalog;
    }

    /**
     * 按住听写控制器：按键、录音、转写、插入草稿与状态广播。
     * @param ctx - 插件上下文（已注入 remote/slots/locale/sessions）。
     * @param t - voice-ptt 词典的翻译函数。
     */
    function createController(ctx, t) {
      // 状态归属某个会话：多个会话同时打开时，只有录音所属的那个输入框显示提示。
      var status = createStore({ phase: "idle", text: "", level: "info", sessionId: null });
      // 当前获得焦点的输入框所属会话；用于在空闲时显示「按住 F2 听写」提示。
      var focusSession = createStore(null);
      var readiness = createStore({ connected: false, catalog: null, error: null });
      /** 注入后才可用的 speech Remote 命名空间（cordis 服务必须经 inject 取得）。 */
      var speech = null;
      /** sessionId -> 该会话的插入动作与输入框根节点。 */
      var targets = new Map();
      var attachSeq = 0;
      /** 正在进行的采集。 */
      var active = null;
      var generation = 0;
      var disposed = false;

      /** 用户选定的按住键；改动后立刻生效。 */
      var holdCode = readHoldCode();
      /** 键位选择的可观察值：设置面板与提示文案都读它。 */
      var keyChoice = createStore(holdCode);
      var noticeTimer;
      /** 当前提示归属的会话；开始录音时确定，回到空闲时清除。 */
      var statusSession = null;
      /** 最近一次采集的结束原因（仅用于诊断与测试断言）。 */
      var lastStop = "idle";

      /** 发布状态；终态（错误/提示）在数秒后自动清空，过程态保持显示。 */
      function publish(phase, text, level) {
        if (noticeTimer !== undefined) {
          clearTimeout(noticeTimer);
          noticeTimer = undefined;
        }
        var owner = phase === "idle" ? null : statusSession;
        if (phase === "idle") statusSession = null;
        status.set({
          phase: phase,
          text: text || "",
          level: level || (phase === "error" ? "error" : "info"),
          sessionId: owner
        });
        if (text && phase === "error") {
          noticeTimer = setTimeout(function () {
            noticeTimer = undefined;
            if (status.get().phase === phase) {
              statusSession = null;
              status.set({ phase: "idle", text: "", level: "info", sessionId: null });
            }
          }, NOTICE_MS);
        }
      }

      /** 选择插入目标：优先焦点所在的输入框，其次最近登记的会话。 */
      function pickTarget() {
        var focused = null;
        var fallback = null;
        for (var entry of targets.values()) {
          if (fallback === null || entry.seq > fallback.seq) fallback = entry;
          var root = entry.root;
          var node = document.activeElement;
          if (root && node && root.contains(node)) {
            if (focused === null || entry.seq > focused.seq) focused = entry;
          }
        }
        return focused || fallback;
      }

      /** 尽力向会话输入框推送一条提示；失败不影响状态条。 */
      function notify(level, text) {
        var target = pickTarget();
        if (!target) return;
        try {
          var conversation = ctx.get("conversation");
          var sessions = ctx.get("sessions");
          if (!conversation || !sessions) return;
          var actx = sessions.scope(target.sessionId);
          if (!actx) return;
          conversation.input.for(actx).notify(level, text);
        } catch (error) {
          /* 提示是尽力而为 */
        }
      }

      function failureText(failure) {
        if (failure && failure.name === "RecordingError") return t(failure.kind);
        var message = failure instanceof Error ? failure.message : String(failure);
        return t("failed", { message: message });
      }

      /** 摘掉当前采集并中止其等待，返回该采集（调用方负责释放资源）。 */
      function detachActive() {
        var current = active;
        active = null;
        if (!current) return null;
        if (current.timer !== undefined) clearTimeout(current.timer);
        current.abort.abort();
        return current;
      }

      /** 取消：丢弃录音，不产生文字。debug 字段记录取消来源，便于定位误取消。 */
      function cancel(reason, source) {
        generation++;
        statusSession = null;
        lastStop = source || "cancel";
        var current = detachActive();
        if (current) void disposeQuietly(current.recording);
        publish("idle", "");
        if (reason) notify("info", t(reason));
      }

      /** 开始录音；不可用时给出可见反馈。 */
      async function start() {
        if (disposed || active) return;
        var catalog = usableCatalog(readiness.get());
        if (!catalog) {
          publish("error", t("unavailable"));
          notify("error", t("unavailable"));
          return;
        }
        var target = pickTarget();
        if (!target) {
          publish("error", t("shortcut.noready"));
          return;
        }
        var run = ++generation;
        statusSession = target.sessionId;
        var recording = new Recording(function () {});
        var current = {
          recording: recording,
          actions: target.actions,
          span: target.actions.captureInsertion(),
          selection: catalog.selection,
          maxDurationSeconds: catalog.maxDurationSeconds,
          maxAudioBytes: catalog.maxAudioBytes,
          abort: new AbortController(),
          timer: undefined,
          phase: "requesting"
        };
        active = current;
        publish("requesting", t("requesting"));
        try {
          await recording.start();
          if (run !== generation || active !== current) return;
          current.phase = "recording";
          publish("recording", t("recording", { key: holdLabel(holdCode, t) }));
          current.timer = setTimeout(function () {
            void finish();
          }, current.maxDurationSeconds * 1000);
        } catch (failure) {
          await disposeQuietly(recording);
          if (run !== generation) return;
          active = null;
          var text = failureText(failure);
          publish("error", text);
          notify("error", text);
        }
      }

      /** 松开按键：结束录音、转写并插入草稿。 */
      async function finish() {
        var current = active;
        if (!current) return;
        // 还在等麦克风授权：用户已经松手，直接放弃这次采集。
        if (current.phase === "requesting") {
          cancel(undefined, "released-while-requesting");
          return;
        }
        if (current.phase !== "recording") return;
        current.phase = "transcribing";
        var run = generation;
        lastStop = "released";
        if (current.timer !== undefined) clearTimeout(current.timer);
        publish("transcribing", t("transcribing"));
        try {
          var audio = await current.recording.stop(current.maxDurationSeconds);
          if (run !== generation) return;
          if (audio.byteLength > current.maxAudioBytes) {
            active = null;
            publish("error", t("tooLarge"));
            notify("error", t("tooLarge"));
            return;
          }
          if (speech === null) throw new Error("speech remote unavailable");
          var result = await speech.transcribe(
            { audioBase64: audioBase64(audio), ...current.selection },
            current.abort.signal
          );
          if (run !== generation) return;
          active = null;
          if (!result.ok) {
            var failureMessage = t("failed", { message: result.error.message });
            publish("error", failureMessage);
            notify("error", failureMessage);
            return;
          }
          var text = result.value.text;
          if (text === "") {
            publish("error", t("empty"));
            notify("error", t("empty"));
            return;
          }
          if (!current.actions.insertText(text, current.span)) {
            publish("error", t("conflict"));
            notify("error", t("conflict"));
            return;
          }
          publish("idle", "");
        } catch (failure) {
          if (run !== generation) return;
          await disposeQuietly(current.recording);
          var message = failureText(failure);
          publish("error", message);
          notify("error", message);
        } finally {
          if (active === current) active = null;
        }
      }

      /** 当前是否有弹窗/菜单占着最前面（此时让出按键）。 */
      function modalOpen() {
        return document.querySelector(MODAL_SELECTOR) !== null;
      }

      /** 焦点是否在终端里（xterm 自己要用功能键）。 */
      function inTerminal(event) {
        var path = typeof event.composedPath === "function" ? event.composedPath() : [];
        for (var node of path) {
          if (node instanceof Element && node.closest(".xterm")) return true;
        }
        var element = document.activeElement;
        return element instanceof Element && element.closest(".xterm") !== null;
      }

      /** 焦点所在的已登记输入框；没有则返回 undefined。 */
      function focusedTarget() {
        var node = document.activeElement;
        if (!node) return undefined;
        var best;
        for (var entry of targets.values()) {
          if (entry.root && entry.root.contains(node)) {
            if (best === undefined || entry.seq > best.seq) best = entry;
          }
        }
        return best;
      }

      /** 单键按下：满足边界条件时开始录音。 */
      var onKeyDown = function (event) {
        // 弹窗/菜单最前时不抢键。
        if (modalOpen()) return;
        if (event.code !== holdCode) {
          // 录音期间又按了别的键：说明用户在打字或做别的操作，
          // 直接取消本次采集，让那个键照常工作（例如录音中按 Ctrl+C）。
          if (active && event.key !== "Escape") cancel("cancelled", "other-key:" + event.code);
          return;
        }
        // 只有「按住键本身」才触发；组合使用（如 Ctrl+F2）留给浏览器与系统。
        // 若所选键本身就是修饰键，则忽略它自己那一位。
        var own = OWN_MODIFIER[holdCode];
        if ((event.ctrlKey && own !== "ctrlKey") || (event.altKey && own !== "altKey")) return;
        if ((event.metaKey && own !== "metaKey") || (event.shiftKey && own !== "shiftKey")) return;
        if (inTerminal(event)) return;
        if (active) return;
        // 焦点必须真的在已登记的输入框里，避免在别处误触。
        if (!focusedTarget()) return;
        event.preventDefault();
        void start();
      };

      /** 单键松开：结束录音并转写。 */
      var onKeyUp = function (event) {
        if (event.code !== holdCode || !active) return;
        event.preventDefault();
        void finish();
      };
      /** 重新计算「哪个输入框有焦点」。 */
      function syncFocus() {
        var entry = focusedTarget();
        var next = entry ? entry.sessionId : null;
        if (focusSession.get() !== next) focusSession.set(next);
      }

      var onFocusChange = function () {
        syncFocus();
      };
      var onBlur = function () {
        if (active && active.phase === "recording") cancel("cancelled", "window-blur");
      };
      var onVisibility = function () {
        if (document.hidden && active && active.phase !== "transcribing") cancel("cancelled", "hidden");
      };

      return {
        status: status,
        readiness: readiness,
        setSpeech: function (namespace) {
          speech = namespace;
        },
        attachTarget: function (sessionId, actions, root) {
          targets.set(sessionId, { sessionId: sessionId, actions: actions, root: root, seq: ++attachSeq });
          syncFocus();
        },
        focusSession: focusSession,
        keyChoice: keyChoice,
        /** 当前按住键的显示名；每次现取，切换界面语言后立即跟随。 */
        keyLabel: function () {
          return holdLabel(holdCode, t);
        },
        /** 换键：立刻生效并记住。正在录音时先取消，避免半途换键。 */
        setHoldCode: function (code) {
          if (!KEY_OPTIONS.some(function (option) {
            return option.code === code;
          })) return false;
          if (code === holdCode) return true;
          if (active) cancel("cancelled", "key-changed");
          holdCode = code;
          try {
            localStorage.setItem(STORE_KEY, code);
          } catch (error) {
            /* 存不下也不影响本次会话 */
          }
          keyChoice.set(code);
          return true;
        },
        /** 诊断用：最近一次采集的结束原因。 */
        lastStop: function () {
          return lastStop;
        },
        detachTarget: function (sessionId) {
          targets.delete(sessionId);
          syncFocus();
        },
        start: start,
        cancel: cancel,
        /**
         * 订阅「该会话草稿是否为空」。提示只在空草稿时显示，避免与真实内容并存。
         * 服务不可用时退化为常量 true（宁可不显示，也不要报错）。
         */
        draftEmptyStore: function (sessionId) {
          var source = null;
          try {
            var conversation = ctx.get("conversation");
            var sessions = ctx.get("sessions");
            if (conversation && sessions) {
              var actx = sessions.scope(sessionId);
              if (actx) source = conversation.input.for(actx).state;
            }
          } catch (error) {
            source = null;
          }
          if (!source) return { subscribe: function () { return function () {}; }, get: function () { return false; } };
          return {
            subscribe: function (listener) {
              return source.subscribe(listener);
            },
            get: function () {
              return source.getSnapshot().draft === "";
            }
          };
        },
        installListeners: function () {
          document.addEventListener("keyup", onKeyUp, true);
          document.addEventListener("keydown", onKeyDown, true);
          document.addEventListener("focusin", onFocusChange, true);
          document.addEventListener("focusout", onFocusChange, true);
          window.addEventListener("blur", onBlur);
          document.addEventListener("visibilitychange", onVisibility);
          return function () {
            document.removeEventListener("keyup", onKeyUp, true);
            document.removeEventListener("keydown", onKeyDown, true);
            document.removeEventListener("focusin", onFocusChange, true);
            document.removeEventListener("focusout", onFocusChange, true);
            window.removeEventListener("blur", onBlur);
            document.removeEventListener("visibilitychange", onVisibility);
          };
        },
        dispose: function () {
          disposed = true;
          generation++;
          var current = detachActive();
          if (current) void disposeQuietly(current.recording);
          targets.clear();
        }
      };
    }

    var CSS = [
      ".dshVoicePtt_status{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
      ".dshVoicePtt_status[data-phase=recording]{color:var(--dsw-alias-state-business-primary)}",
      ".dshVoicePtt_status[data-phase=error]{color:var(--dsw-alias-state-error-primary)}",
      ".dshVoicePtt_dot{flex:none;width:8px;height:8px;border-radius:50%;background:currentColor;animation:dshVoicePttPulse 1s ease-in-out infinite alternate}",
      ".dshVoicePtt_text{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
      ".dshVoicePtt_hint{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;opacity:.75}",
      ".dshVoicePtt_hint:hover{opacity:1;text-decoration:underline}",
      ".dshVoicePtt_picker{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}",
      ".dshVoicePtt_key{padding:0 6px;height:18px;border-radius:4px;border:1px solid var(--dsw-alias-border-secondary);background:none;color:inherit;font:inherit;cursor:pointer}",
      ".dshVoicePtt_key:hover{border-color:var(--dsw-alias-label-secondary)}",
      ".dshVoicePtt_key[data-active=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
      ".dshVoicePtt_meta{opacity:.7}",
      "@keyframes dshVoicePttPulse{0%{opacity:.3}100%{opacity:1}}"
    ].join("");

    function installCss() {
      if (typeof document === "undefined") return;
      var tagId = NAME + "/client.css";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = NAME;
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * 常驻输入框条目：登记本会话的插入动作，并显示录音状态。
     * 空闲时不渲染任何内容。
     */
    function VoicePttStatus(props) {
      var snapshot = react.useSyncExternalStore(props.status.subscribe, props.status.get);
      var host = react.useRef(null);
      var sessionId = props.sessionId;
      var inputActions = props.inputActions;
      react.useEffect(
        function () {
          if (sessionId === undefined || inputActions === undefined) return undefined;
          var node = host.current;
          var card = node ? node.closest("[data-composer-card]") : null;
          props.attachTarget(sessionId, inputActions, card || (node ? node.parentElement : null));
          return function () {
            props.detachTarget(sessionId);
          };
        },
        [sessionId, inputActions]
      );
      var focusSession = react.useSyncExternalStore(props.focusSession.subscribe, props.focusSession.get);
      var draftStore = react.useMemo(
        function () {
          return props.draftEmptyStore(sessionId);
        },
        [sessionId]
      );
      var draftEmpty = react.useSyncExternalStore(draftStore.subscribe, draftStore.get);
      var chosen = react.useSyncExternalStore(props.keyChoice.subscribe, props.keyChoice.get);
      var picker = react.useState(false);
      var pickerOpen = picker[0];
      var setPickerOpen = picker[1];
      react.useEffect(
        function () {
          if (!pickerOpen) return undefined;
          var onKey = function (event) {
            if (event.key === "Escape") setPickerOpen(false);
          };
          document.addEventListener("keydown", onKey, true);
          return function () {
            document.removeEventListener("keydown", onKey, true);
          };
        },
        [pickerOpen]
      );
      // 状态只在本会话的输入框显示；空闲且草稿为空时显示一行按键提示
      // （单键没有「快捷键」面板条目，提示同时是发现途径与换键入口）。
      var active = snapshot.phase !== "idle" && snapshot.text !== "";
      var owns = snapshot.sessionId === null || snapshot.sessionId === sessionId;
      var label = props.keyLabel();
      var idle = !active && focusSession === sessionId && draftEmpty;
      // 选择器打开后不依赖焦点：点击它本身就会让输入框失焦。
      var visible = (active && owns) || idle || pickerOpen;
      var text = active && owns ? snapshot.text : idle ? props.hint(label) : "";

      var body;
      if (pickerOpen) {
        body = react.createElement(
          "span",
          { className: "dshVoicePtt_picker", "data-voice-ptt": "picker" },
          [
            react.createElement("span", { key: "lead", className: "dshVoicePtt_meta" }, props.pickLabel),
            ...props.keyOptions().map(function (option) {
              return react.createElement(
                "button",
                {
                  key: option.code,
                  type: "button",
                  className: "dshVoicePtt_key",
                  "data-active": option.code === chosen ? "true" : "false",
                  "data-voice-ptt-key": option.code,
                  onMouseDown: function (event) {
                    // 别把焦点从输入框抢走：否则点击一次就失焦。
                    event.preventDefault();
                  },
                  onClick: function () {
                    props.setHoldCode(option.code);
                    setPickerOpen(false);
                  }
                },
                props.keyLabelOf(option.code)
              );
            })
          ]
        );
      } else if (active && owns) {
        body = [
          react.createElement("span", { key: "dot", className: "dshVoicePtt_dot", "aria-hidden": "true" }),
          react.createElement("span", { key: "text", className: "dshVoicePtt_text" }, text)
        ];
      } else if (idle) {
        body = react.createElement(
          "button",
          {
            key: "hint",
            type: "button",
            className: "dshVoicePtt_hint",
            "data-voice-ptt": "hint",
            title: props.pickLabel,
            onMouseDown: function (event) {
              event.preventDefault();
            },
            onClick: function () {
              setPickerOpen(true);
            }
          },
          text
        );
      }

      return react.createElement(
        "span",
        {
          ref: host,
          className: "dshVoicePtt_status",
          "data-phase": active ? snapshot.phase : "hint",
          "data-voice-ptt": "status",
          "data-voice-ptt-stop": props.lastStop(),
          role: "status",
          title: text,
          style: visible ? undefined : { display: "none" }
        },
        body || null
      );
    }

    var inject = ["remote", "slots", "locale", "sessions"];

    function apply(ctx) {
      installCss();
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      });
      var t = ctx.locale.bind(NS);
      var controller = createController(ctx, t);

      ctx.effect(function () {
        return controller.installListeners();
      });
      ctx.effect(function () {
        return function () {
          controller.dispose();
        };
      });

      // 识别服务由语音输入 bundle 动态挂载，因此等到 remote.speech 出现再订阅状态。
      ctx.inject(["remote.speech"], function (scope) {
        controller.setSpeech(scope.remote.speech);
        var stream = scope.remote.$stream({
          name: "Voice PTT speech readiness",
          open: function (signal) {
            return scope.remote.speech.follow(signal);
          },
          ended: function () {
            return new Error("speech readiness stream ended");
          },
          carrierFailed: function (error) {
            var snapshot = controller.readiness.get();
            controller.readiness.set({
              connected: false,
              catalog: snapshot.catalog,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        });
        scope.effect(function () {
          var stopped = false;
          var loop = (async function () {
            try {
              for await (var item of stream) {
                if (stopped) break;
                controller.readiness.set({ connected: true, catalog: item.value, error: null });
                item.accept();
              }
            } catch (error) {
              if (stopped) return;
              var failed = error instanceof Error ? error.message : String(error);
              if (failed.indexOf("abort") !== -1 || failed.indexOf("disposed") !== -1) return;
              var snapshot = controller.readiness.get();
              controller.readiness.set({ connected: false, catalog: snapshot.catalog, error: failed });
            }
          })();
          return async function () {
            stopped = true;
            await stream.dispose();
            await loop;
          };
        });
      });

      // 单键按住听写由 controller 自己的文档级 keydown/keyup 接管：
      // 官方快捷键服务的组合校验要求必须带修饰键（modifier-required），
      // 浏览器端还有组合白名单，无法表达「按住一个单键说话」，
      // 因此这里有意不注册快捷键命令。

      // 输入框常驻条目：登记插入动作 + 显示状态。
      ctx.slots.inject("conversation.input.left", function () {
        return ctx.slots.register(
          {
            name: "conversation.input.left",
            id: SLOT_ID,
            order: 20,
            inject: function () {
              return {
                status: controller.status,
                focusSession: controller.focusSession,
                hint: function (key) {
                  return t("hint", { key: key });
                },
                pickLabel: t("pick"),
                keyOptions: function () {
                  return KEY_OPTIONS;
                },
                keyChoice: controller.keyChoice,
                keyLabel: controller.keyLabel,
                keyLabelOf: function (code) {
                  return holdLabel(code, t);
                },
                setHoldCode: controller.setHoldCode,
                lastStop: controller.lastStop,
                draftEmptyStore: controller.draftEmptyStore,
                attachTarget: controller.attachTarget,
                detachTarget: controller.detachTarget
              };
            }
          },
          VoicePttStatus
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = NAME;
    return module.exports;
  }
});
