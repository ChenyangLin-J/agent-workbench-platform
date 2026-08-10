(function () {
  const FALLBACK_SAMPLE_RATE = 24_000;
  const REALTIME_V3_VOICES = ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"];
  const DEFAULT_REALTIME_V3_VOICE = REALTIME_V3_VOICES[0];

  function createRealtimeController({
    launchButton,
    dialog,
    dismissButton,
    startButton,
    stopButton,
    fallbackButton,
    voiceSelect,
    statusElement,
    transcriptElement,
    errorElement,
    outputAudio,
    send,
    fallbackToDictation,
    activateSession,
  }) {
    let enabled = false;
    let launchable = false;
    let preparingSession = false;
    let state = { status: "idle", voice: DEFAULT_REALTIME_V3_VOICE, transcript: [], error: "" };
    let inputStream = null;
    let peerConnection = null;
    let eventChannel = null;
    let outputContext = null;
    let nextPlaybackAt = 0;
    let mediaAttempt = 0;
    let startSent = false;

    return {
      install,
      open,
      handleMessage,
      setEnabled,
      setLaunchable,
      failPreparation,
      resetPreparation,
      isPreparing: () => preparingSession,
      isBusy: () => ["starting", "live", "stopping"].includes(state.status),
    };

    function install() {
      launchButton.addEventListener("click", open);
      dismissButton.addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
      startButton.addEventListener("click", start);
      stopButton.addEventListener("click", stop);
      fallbackButton.addEventListener("click", useFallback);
      renderState();
    }

    function open() {
      if (!dialog.open) dialog.showModal();
      if (!enabled) {
        if (!launchable || preparingSession) return;
        clearError();
        if (state.status === "failed") state.status = "idle";
        preparingSession = true;
        renderState();
        try {
          if (activateSession?.() === false) {
            failPreparation("当前 Session 暂时无法启动实时语音。");
          }
        } catch (error) {
          failPreparation(error.message || "无法创建实时语音 Session。");
        }
        return;
      }
      send({ type: "realtime-voices" });
    }

    function setEnabled(value) {
      const nextEnabled = Boolean(value);
      const becameEnabled = nextEnabled && !enabled;
      enabled = nextEnabled;
      if (becameEnabled && preparingSession) {
        preparingSession = false;
        send({ type: "realtime-voices" });
      }
      if (!enabled && ["starting", "live", "stopping"].includes(state.status)) {
        state.error = "连接已断开，麦克风已经停止；重连后请结束并重新开始实时对话。";
        void stopMedia();
      }
      renderState();
    }

    function setLaunchable(value) {
      launchable = Boolean(value);
      renderState();
    }

    function failPreparation(message) {
      if (!preparingSession) return;
      preparingSession = false;
      state.status = "failed";
      state.error = message || "无法创建实时语音 Session。";
      renderState();
    }

    function resetPreparation() {
      if (!preparingSession) return;
      preparingSession = false;
      renderState();
    }

    async function start() {
      if (!enabled || ["starting", "live", "stopping"].includes(state.status)) return;
      clearError();
      state = {
        status: "starting",
        voice: normalizeVoice(voiceSelect.value || state.voice),
        transcript: [],
        error: "",
      };
      renderState();
      const attempt = ++mediaAttempt;
      startSent = false;
      try {
        const sdp = await startWebRtc(attempt);
        if (!sdp || attempt !== mediaAttempt || state.status !== "starting" || !enabled) return;
        if (!send({ type: "realtime-start", voice: state.voice, transport: { type: "webrtc", sdp } })) {
          throw new Error("连接恢复中，请稍后重试。");
        }
        startSent = true;
      } catch (error) {
        if (attempt !== mediaAttempt) return;
        await stopMedia();
        state.status = "failed";
        state.error = error.message || "无法开始实时语音。";
        renderState();
      }
    }

    async function stop() {
      if (!["starting", "live", "stopping"].includes(state.status)) return;
      const shouldNotifyServer = startSent;
      state.status = "stopping";
      renderState();
      await stopMedia();
      startSent = false;
      if (!shouldNotifyServer) {
        state.status = "idle";
        renderState();
        return;
      }
      if (!send({ type: "realtime-stop" })) {
        state.status = "failed";
        state.error = "连接恢复中，实时语音没有正常停止。";
        renderState();
      }
    }

    async function useFallback() {
      if (["starting", "live", "stopping"].includes(state.status)) {
        if (startSent) send({ type: "realtime-stop" });
        await stopMedia();
        startSent = false;
        state.status = "idle";
      }
      dialog.close();
      await fallbackToDictation?.();
    }

    function handleMessage(type, payload = {}) {
      if (type === "realtime-voices") {
        renderVoices(payload);
        return;
      }
      if (type === "realtime-audio") {
        void playAudioChunk(payload).catch((error) => showError(error.message || "语音播放失败。"));
        return;
      }
      if (type === "realtime-sdp") {
        void acceptRemoteSdp(payload.sdp);
        return;
      }
      if (type === "realtime-error") {
        startSent = false;
        showError(payload.message || "实时语音失败。");
        void stopMedia();
        return;
      }
      if (type !== "realtime-state") return;
      state = {
        status: String(payload.status || "idle"),
        voice: normalizeVoice(payload.voice || state.voice),
        transcript: Array.isArray(payload.transcript) ? payload.transcript : [],
        error: String(payload.error || ""),
      };
      if (state.status === "starting" || state.status === "live") startSent = true;
      if (state.status === "idle" || state.status === "failed") {
        startSent = false;
        void stopMedia();
      }
      renderState();
    }

    function renderVoices(payload) {
      const received = Array.isArray(payload.voices) ? payload.voices.map(String) : [];
      const supported = received.filter((voice) => REALTIME_V3_VOICES.includes(voice));
      const voices = supported.length ? supported : REALTIME_V3_VOICES;
      const selected = [state.voice, payload.defaultVoice, voiceSelect.value, DEFAULT_REALTIME_V3_VOICE]
        .map(normalizeVoice)
        .find((voice) => voices.includes(voice)) || voices[0];
      voiceSelect.replaceChildren(
        ...voices.map((voice) => {
          const option = document.createElement("option");
          option.value = voice;
          option.textContent = voice;
          return option;
        }),
      );
      voiceSelect.value = selected;
      state.voice = selected;
    }

    function normalizeVoice(value) {
      const voice = String(value || "").trim();
      return REALTIME_V3_VOICES.includes(voice) ? voice : DEFAULT_REALTIME_V3_VOICE;
    }

    function renderState() {
      const labels = {
        idle: "尚未开始",
        starting: "正在连接麦克风…",
        live: "实时对话中",
        stopping: "正在停止…",
        failed: "连接失败",
      };
      statusElement.textContent = preparingSession ? "正在创建 Session…" : labels[state.status] || state.status;
      statusElement.dataset.state = preparingSession ? "starting" : state.status;
      const busy = ["starting", "live", "stopping"].includes(state.status);
      launchButton.disabled = !enabled && !launchable;
      startButton.disabled = !enabled || preparingSession || busy;
      stopButton.disabled = !enabled || !busy || state.status === "stopping";
      voiceSelect.disabled = !enabled || preparingSession || busy;
      fallbackButton.disabled = !enabled || preparingSession;
      errorElement.textContent = state.error || "";
      errorElement.classList.toggle("hidden", !state.error);
      renderTranscript();
    }

    function renderTranscript() {
      const items = Array.isArray(state.transcript) ? state.transcript : [];
      if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "feature-empty";
        empty.textContent = "开始后可直接说话，Codex 会用语音回应。";
        transcriptElement.replaceChildren(empty);
        return;
      }
      const shouldFollow =
        transcriptElement.scrollHeight - transcriptElement.scrollTop - transcriptElement.clientHeight < 80;
      transcriptElement.replaceChildren(
        ...items.map((item) => {
          const message = document.createElement("article");
          message.className = "realtime-message";
          message.dataset.role = item.role === "user" ? "user" : "assistant";
          message.textContent = item.text || (item.final ? "…" : "正在听…");
          return message;
        }),
      );
      if (shouldFollow) transcriptElement.scrollTop = transcriptElement.scrollHeight;
    }

    async function startWebRtc(attempt) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持麦克风输入。");
      if (!globalThis.RTCPeerConnection) throw new Error("当前浏览器不支持实时语音连接。");
      await stopMedia({ cancel: false });
      if (attempt !== mediaAttempt) return "";
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (attempt !== mediaAttempt) {
        for (const track of stream.getTracks()) track.stop();
        return "";
      }
      inputStream = stream;
      const connection = new RTCPeerConnection();
      peerConnection = connection;
      connection.ontrack = (event) => {
        const stream = event.streams?.[0];
        if (!stream) return;
        outputAudio.srcObject = stream;
        void outputAudio.play?.().catch(() => {});
      };
      connection.onconnectionstatechange = () => {
        if (peerConnection !== connection || connection.connectionState !== "failed") return;
        void failRealtimeConnection("实时语音连接失败，请停止后重试。");
      };
      for (const track of stream.getAudioTracks()) connection.addTrack(track, stream);
      eventChannel = connection.createDataChannel("oai-events");
      const offer = await connection.createOffer();
      if (attempt !== mediaAttempt || peerConnection !== connection) return "";
      await connection.setLocalDescription(offer);
      if (attempt !== mediaAttempt || peerConnection !== connection) return "";
      await waitForIceGathering(connection);
      if (attempt !== mediaAttempt || peerConnection !== connection) return "";
      const sdp = String(connection.localDescription?.sdp || offer.sdp || "");
      if (!sdp) throw new Error("浏览器没有生成有效的实时语音连接信息。");
      return sdp;
    }

    async function acceptRemoteSdp(sdp) {
      const connection = peerConnection;
      const attempt = mediaAttempt;
      if (!connection || connection.signalingState === "closed") return;
      if (connection.signalingState !== "have-local-offer") return;
      try {
        const answer = String(sdp || "");
        if (!answer) throw new Error("服务端没有返回有效的实时语音连接信息。");
        await connection.setRemoteDescription({ type: "answer", sdp: answer });
      } catch (error) {
        if (attempt !== mediaAttempt || peerConnection !== connection) return;
        await failRealtimeConnection(error.message || "实时语音连接协商失败。");
      }
    }

    async function failRealtimeConnection(message) {
      const shouldNotifyServer = startSent;
      state.status = shouldNotifyServer ? "stopping" : "failed";
      state.error = message;
      renderState();
      if (shouldNotifyServer && send({ type: "realtime-stop" })) {
        startSent = false;
      } else if (shouldNotifyServer) {
        state.status = "failed";
        renderState();
      }
      await stopMedia();
    }

    async function stopMedia({ cancel = true } = {}) {
      if (cancel) mediaAttempt += 1;
      eventChannel?.close?.();
      peerConnection?.close?.();
      for (const track of inputStream?.getTracks?.() || []) track.stop();
      const fallbackContext = outputContext;
      inputStream = null;
      peerConnection = null;
      eventChannel = null;
      outputContext = null;
      nextPlaybackAt = 0;
      if (outputAudio) {
        outputAudio.pause?.();
        outputAudio.srcObject = null;
      }
      if (fallbackContext && fallbackContext.state !== "closed") await fallbackContext.close().catch(() => {});
    }

    async function playAudioChunk(chunk) {
      const bytes = base64Bytes(chunk.data);
      const channels = Math.max(1, Math.min(2, Number(chunk.numChannels) || 1));
      const sampleRate = Math.max(8_000, Math.min(48_000, Number(chunk.sampleRate) || FALLBACK_SAMPLE_RATE));
      const sampleCount = Math.floor(bytes.byteLength / 2 / channels);
      if (!sampleCount) return;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error("当前浏览器不支持语音播放。");
      if (!outputContext || outputContext.state === "closed") outputContext = new AudioContext();
      await outputContext.resume();
      const audioBuffer = outputContext.createBuffer(channels, sampleCount, sampleRate);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let channel = 0; channel < channels; channel += 1) {
        const output = audioBuffer.getChannelData(channel);
        for (let index = 0; index < sampleCount; index += 1) {
          output[index] = view.getInt16((index * channels + channel) * 2, true) / 32768;
        }
      }
      const source = outputContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(outputContext.destination);
      const startsAt = Math.max(outputContext.currentTime + 0.025, nextPlaybackAt);
      source.start(startsAt);
      nextPlaybackAt = startsAt + audioBuffer.duration;
    }

    function showError(message) {
      state.status = "failed";
      state.error = message;
      renderState();
    }

    function clearError() {
      state.error = "";
      errorElement.textContent = "";
      errorElement.classList.add("hidden");
    }
  }

  async function waitForIceGathering(connection) {
    if (connection.iceGatheringState === "complete") return;
    await new Promise((resolve) => {
      const timeout = window.setTimeout(done, 3_000);
      connection.addEventListener("icegatheringstatechange", onStateChange);
      function onStateChange() {
        if (connection.iceGatheringState === "complete") done();
      }
      function done() {
        window.clearTimeout(timeout);
        connection.removeEventListener("icegatheringstatechange", onStateChange);
        resolve();
      }
    });
  }

  function base64Bytes(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  if (typeof window !== "undefined") window.AgentRealtime = { create: createRealtimeController };
})();
