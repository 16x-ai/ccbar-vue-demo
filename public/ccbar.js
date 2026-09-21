class CCBar {
    constructor(options = {}) {
      // 默认配置
      this.defaultOptions = {
        eventHandle: {
          onRequestError: () => {},
          onError: () => {},
          onRecviceCall: () => {},
          onStatusChange: () => {},
          onWebPhoneHandle: () => {}
        },
        // baseUrl: 'https://vxapi.yundianlab.com',
        // //HTTP请求配置
        httpConfig: {
          // baseURL: '',
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      };

      this.refreshBufferTime = 300;
      this.refreshTimeout  = null;
      this.reqFn = null
  
      // 合并配置
      this.options = { ...this.defaultOptions, ...options };
      
      // 状态变量
      this.status = {
        workStatus: 'online',
        serviceStatus: 'idle',
        sipStatus: 'unreg',
        signedIn: false,
        // 通话前的 workStatus，用于结束后恢复（参考 guanjiapo）
        _preWorkStatus: null
      };
      
      // SIP 相关（多路：Map<id, RTCSession>，activeSessionId 为当前操作/放音路）
      this.ua = null;
      this.sessions = new Map();
      this.activeSessionId = null;
      this.loginTimeout = null;
      this._signingOut = false;
      this._sipLoginConfig = null;
      this._sipUaGeneration = 0;
      this._sipReady = false;
      this._rebuildUaTimer = null;
      this._rebuildUaAttempts = 0;
      this._wsPingTimer = null;
      this._wsPingIntervalMs = 20000;
      this._localStream = null;
      this._sipCallReadyAt = 0;
      this._sipWasRegistering = false;
      this._reregisterTimer = null;
      this._webrtcWarmed = false;
      this._callRetried = false;
      this._lastCallArgs = null;
      this._pendingCallRetry = false;
      // HTTP 相关
      this.httpInterceptors = {
        request: [],
        response: []
      };

      this.baseUrl = this.options.customUrl
        || (this.options.isPre
          ? 'vxapi-pre.yundianlab.com/openapi/token/v1'
          : 'vxapi.yundianlab.com/openapi/token/v1');

      
      // 初始化UI
      this.initUI();
      this.bindEvents();
      //启用调试
      // JsSIP.debug.enable('*');

      this.loading = {
        element: null,
        isShowing: false,

        init() {
            // 创建样式
            const style = document.createElement('style');
            style.textContent = `
                .fullscreen-loading {
                    position: fixed; top: 0; left: 0; 
                    width: 100vw; height: 100vh;
                    background: rgba(0,0,0,0.8);
                    display: none; justify-content: center; 
                    align-items: center; z-index: 9999;
                }
                .loading-spinner {
                    width: 30px; height: 30px;
                    border: 3px solid #333;
                    border-top: 6px solid #fff;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                body.loading-active { overflow: hidden; }
            `;
            document.head.appendChild(style);

            // 创建元素
            this.element = document.createElement('div');
            this.element.className = 'fullscreen-loading';
            this.element.innerHTML = '<div class="loading-spinner"></div>';
            document.body.appendChild(this.element);
        },
    
        show() {
            if (!this.element) this.init();
            this.isShowing = true;
            this.element.style.display = 'flex';
            document.body.classList.add('loading-active');
        },
    
        hide() {
            if (this.element) {
                this.isShowing = false;
                this.element.style.display = 'none';
                document.body.classList.remove('loading-active');
            }
        }
      }

      document.addEventListener('DOMContentLoaded', () => {
          this.loading.init();
      });
    }

    /** 兼容旧代码：当前激活路 */
    get session() {
      return this.getActiveSession();
    }

    getActiveSession() {
      if (!this.activeSessionId) return null;
      const s = this.sessions.get(this.activeSessionId);
      if (!s) return null;
      try {
        if (s.isEnded && s.isEnded()) return null;
      } catch (e) {}
      return s;
    }

    getSession(sessionId) {
      return sessionId != null ? this.sessions.get(sessionId) : null;
    }

    listSessions() {
      return Array.from(this.sessions.values()).map((s) => ({
        id: s.id,
        direction: s.direction,
        remote: s.remote_identity?.uri?.user,
        displayName: s.remote_identity?.display_name,
        isEstablished: typeof s.isEstablished === 'function' ? s.isEstablished() : false,
        isEnded: typeof s.isEnded === 'function' ? s.isEnded() : false
      }));
    }

    setActiveSession(sessionId) {
      if (!sessionId || !this.sessions.has(sessionId)) return false;
      this.activeSessionId = sessionId;
      this._refreshServiceStatus();
      this._focusActiveSessionAudio();
      this.options.eventHandle.onWebPhoneHandle('session.activeChanged', { sessionId });
      return true;
    }

    _addSession(session) {
      if (!session) return;
      this.sessions.set(session.id, session);
      this.activeSessionId = session.id;
      this._refreshServiceStatus();
    }

    _removeSession(session) {
      if (!session) return;
      const id = session.id;
      if (!this.sessions.has(id)) return;
      this._stopSessionMedia(session);
      this.sessions.delete(id);
      if (this.activeSessionId === id) {
        this.activeSessionId = this.sessions.size
          ? this.sessions.keys().next().value
          : null;
      }
      this._refreshServiceStatus();
      if (this.sessions.size === 0) {
        if (!this._pendingCallRetry) {
          this._releaseCallMedia();
        }
      } else {
        this._focusActiveSessionAudio();
      }
    }

    _refreshServiceStatus() {
      // 没有活跃会话时，服务状态恢复为空闲，并恢复到通话前的坐席状态
      if (this.sessions.size === 0) {
        if (this._pendingCallRetry) {
          this.setStatus('serviceStatus', 'calling');
          return;
        }
        this.setStatus('serviceStatus', 'idle');
        // 恢复到通话前的 workStatus（参考 guanjiapo 分支逻辑）
        if (this.status.signedIn && this.status._preWorkStatus != null) {
          const prev = this.status._preWorkStatus;
          this.status._preWorkStatus = null;
          this.setStatus('workStatus', prev);
          // 恢复到通话前的坐席状态
          if (prev === 'online') {
            this.setSeatStatus('Available', '空闲');
          } else if (prev === 'busy') {
            this.setSeatStatus('On Break', '忙碌');
          } else if (prev === 'reset') {
            this.setSeatStatus('On Break', '休息');
          }
        }
        return;
      }
      const s = this.getActiveSession();
      if (!s) return;
      try {
        const hold = typeof s.isOnHold === 'function' ? s.isOnHold() : { local: false, remote: false };
        if (hold.local || hold.remote) {
          this.setStatus('serviceStatus', 'hold');
          return;
        }
        if (s.direction === 'outgoing') {
          const established = typeof s.isEstablished === 'function' && s.isEstablished();
          this.setStatus('serviceStatus', established ? 'calling' : 'busy');
          return;
        }
        const inEst = typeof s.isEstablished === 'function' && s.isEstablished();
        this.setStatus('serviceStatus', inEst ? 'calling' : 'busy');
      } catch (e) {
        this.setStatus('serviceStatus', 'busy');
      }
    }

    _focusActiveSessionAudio() {
      this._attachRemoteAudio(this.getActiveSession());
    }

    _clearAudioPrompt() {
      const text = this.ui?.errorInfo?.textContent || '';
      if (!text || /启用音频/.test(text)) {
        this.clearError();
      }
    }

    _ensureAudioUnlock(el) {
      if (!el || this._audioUnlockBound) return;
      this._audioUnlockBound = true;
      const unlock = () => {
        this._audioUnlockBound = false;
        el.muted = false;
        const p = el.play();
        if (p && typeof p.then === 'function') {
          p.then(() => this._clearAudioPrompt()).catch(() => {});
        }
      };
      document.addEventListener('click', unlock, { once: true });
      document.addEventListener('keydown', unlock, { once: true });
    }

    _playRemoteAudio(el) {
      if (!el) return;
      if (!el._ccbarPlayingBound) {
        el._ccbarPlayingBound = true;
        el.addEventListener('playing', () => this._clearAudioPrompt());
      }
      el.muted = false;
      const p = el.play();
      if (!p || typeof p.then !== 'function') return;
      p.then(() => this._clearAudioPrompt()).catch((error) => {
        if (error && error.name === 'AbortError') return;
        console.warn('自动播放被阻止:', error);
        this.setError('请点击页面任意位置启用音频');
        this._ensureAudioUnlock(el);
      });
    }

    _bindPeerAudio(session, connection) {
      if (!session || !connection || connection._ccbarAudioBound) return;
      connection._ccbarAudioBound = true;
      connection.addEventListener('track', (event) => {
        if (event.track && event.track.kind === 'audio') {
          console.log(`收到远程音频流-${session.direction === 'incoming' ? '来电' : '去电'}`);
          this.handleAudioStream(event.track, session);
        }
      });
      connection.addEventListener('iceconnectionstatechange', () => {
        console.log('ICE 连接状态:', connection.iceConnectionState);
      });
      this._attachRemoteAudio(session);
    }

    _attachRemoteAudio(session, tries = 10) {
      const el = document.getElementById('remoteAudio');
      if (!el || !session) return;
      const conn = session.connection;
      if (!conn) {
        if (tries > 0) {
          setTimeout(() => this._attachRemoteAudio(session, tries - 1), 200);
        }
        return;
      }
      this._bindPeerAudio(session, conn);
      let track = null;
      try {
        const receivers = conn.getReceivers?.() || [];
        track = receivers.find((r) => r.track && r.track.kind === 'audio' && r.track.readyState !== 'ended')?.track;
        if (!track && typeof conn.getRemoteStreams === 'function') {
          const streams = conn.getRemoteStreams() || [];
          const first = streams[0];
          track = first && first.getAudioTracks && first.getAudioTracks()[0];
        }
      } catch (e) {
        console.warn('读取远程音频失败:', e);
      }
      if (track) {
        const current = el.srcObject;
        const sameTrack = current && typeof current.getAudioTracks === 'function'
          && current.getAudioTracks()[0] === track;
        if (!sameTrack) {
          el.srcObject = new MediaStream([track]);
        }
        this._playRemoteAudio(el);
        return;
      }
      if (tries > 0) {
        setTimeout(() => this._attachRemoteAudio(session, tries - 1), 250);
      }
    }

    hangupAll() {
      [...this.sessions.values()].forEach((s) => {
        try {
          this._stopSessionMedia(s);
          s.terminate();
        } catch (e) {}
      });
      this.sessions.clear();
      this.activeSessionId = null;
      this._releaseCallMedia();
      this._refreshServiceStatus();
    }

    isHttps() {
      return this.options.isHttp ? false : true
    }

    // 添加HTTP请求拦截器
    useRequestInterceptor(interceptor) {
      this.httpInterceptors.request.push(interceptor);
    }

    // 添加HTTP响应拦截器
    useResponseInterceptor(interceptor) {
      this.httpInterceptors.response.push(interceptor);
    }

    // 核心请求方法httpRequest
    async httpRequest(url, options = {}, data = null) {

      const controller = new AbortController();
      // 合并配置
      const mergedOptions = {
        // signal,
        headers: {
          ...options.headers,
          ...this.defaultOptions.httpConfig.headers
        },
        ...options
      };

      let requestBody = null;
      if (data && (mergedOptions.method === 'POST' || mergedOptions.method === 'PUT' || mergedOptions.method === 'PATCH')) {
        requestBody = typeof data === 'string' ? data : JSON.stringify(data);
        mergedOptions.body = requestBody;
      }
      // 请求拦截
      const baseUrl = `${this.isHttps() ? 'https' : 'http'}://${this.baseUrl}`;
      let finalUrl = baseUrl + url;

      let finalOptions = mergedOptions;

      for (const interceptor of this.httpInterceptors.request) {
        const result = interceptor(finalUrl, finalOptions);
        finalUrl = result.url || finalUrl;
        finalOptions = result.options || finalOptions;
      }      


      // 超时处理
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => {
          controller.abort();
          reject(new Error(`Request timeout after ${this.options.httpConfig.timeout}ms`));
        }, this.options.httpConfig.timeout)
      );


      try {
        const response = await Promise.race([
          fetch(finalUrl, finalOptions),
          timeoutPromise
        ]);

        // 响应拦截
        let processedResponse = response;
        for (const interceptor of this.httpInterceptors.response) {
          processedResponse = await interceptor(processedResponse);
        }
        if (!response.ok) {
          const error = new Error(`HTTP error! status: ${response.status}`);
          error.response = response;
          throw error;
        }

        // 自动解析响应类型
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) { 
          return await response.json();
        } else if (contentType?.includes('text/')) {
          return await response.text();
        } else {
          return await response.blob();
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          error.message = 'Request was aborted';
        }
        this.options.eventHandle.onRequestError(error);
        throw error;
      }
    }

    genMd5Sign (params, secret) {
      const sortedKeys = Object.keys(params).sort();
      let signStr = '';
      for (const key of sortedKeys) {
        signStr += params[key];
      }
      signStr += secret;
      return CryptoJS.MD5(signStr).toString();
    };

    generateNonce() {
      return Math.random().toString(36).substring(2, 10) + 
             Math.random().toString(36).substring(2, 10);
    }
    //解密
    encryptPwd(password) {
      if (!password) return '';
              const key = CryptoJS.enc.Utf8.parse("q7X4p6MvK1z8Lb3A"); // 16字节
	          const iv = CryptoJS.enc.Utf8.parse("W9e2T4mN0aQ7Ru6C");  // 16字节
              const decrypted = CryptoJS.AES.decrypt(password, key, {
				iv: iv,
				mode: CryptoJS.mode.CBC,
				padding: CryptoJS.pad.Pkcs7
			});
      return decrypted.toString(CryptoJS.enc.Utf8);
    }

    // 快捷方法
    async get(url, params = {}, options = {}) {
      const hasParams = Object.keys(params).length > 0;
      
      const requestUrl = hasParams 
        ? `${url}?${new URLSearchParams(params).toString()}`
        : url;

      return this.httpRequest(requestUrl, {
        ...options,
        method: 'GET'
      });
    }

    async post(url, data = {}, options = {}) {
      return this.httpRequest(url, {
        method: 'POST',
        ...options
      }, data);
    }

 
    //我的队列列表
    getQueueList(params = {}) {
      return new Promise((resolve, reject) => {
        this.post('/sip-queues/queue/list', params).then(data => {
          resolve(data);
        }).catch(err => {
          reject(err);
        });
      })
    }
    //获取坐席分机账号密码
    getSeatsList(data = {}) {
      return new Promise((resolve, reject) => {
        this.post('/sip-queues/queue/seats', data).then(data => {
          resolve(data);
        }).catch(err => {
          reject(err);
        });
      })
    }

  
    // 初始化UI元素引用
    initUI() {
      this.ui = {
        workStatus: document.getElementById('____ccbar_wor_status____'),
        serStatus: document.getElementById('____ccbar_ser_status____'),
        sipStatus: document.getElementById('____ccbar_sip_status____'),
        numberInput: document.getElementById('____ccbar_numb_input____'),
        errorInfo: document.getElementById('____ccbar_errori____'),
        dialBtn: document.getElementById('____ccbar_dailto____'),
        hangupBtn: document.getElementById('____ccbar_hangup____'),
        // ccbar_transf: document.getElementById('____ccbar_transf____'),
        ccbar_cahold: document.getElementById('____ccbar_cahold____'),
        ccbar_unhold: document.getElementById('____ccbar_unhold____'),
        ccbar_signout: document.getElementById('____ccbar_signou____'),
        ccbar_transo: document.getElementById('____ccbar_transo____'),
        ccbar_set_id: document.getElementById('____ccbar_set_id____'),
        ccbar_set_bu: document.getElementById('____ccbar_set_bu____'),
        ccbar_set_re: document.getElementById('____ccbar_set_re____'),
        ccbar_inside: document.getElementById('____ccbar_inside____'),
        // ccbar_tranin: document.getElementById('____ccbar_tranin____'),
      };
    }
  
    // 绑定事件
    bindEvents() {
      // 外呼按钮
      this.ui.dialBtn && this.ui.dialBtn.addEventListener('click', () => {
        const number = this.ui.numberInput.value.trim();
        if (number) {
          this.call(number);
        } else {
          this.setError('请输入号码');
        }
      });
      //内呼
      this.ui.ccbar_inside && this.ui.ccbar_inside.addEventListener('click', () => {
        const number = this.ui.numberInput.value.trim();
        if (number) {
          this.insideCall(number);
        } else {
          this.setError('请输入号码');
        }
      });
      // 挂断按钮
      this.ui.hangupBtn && this.ui.hangupBtn.addEventListener('click', () => {
        this.hangup();
      });

      //保持按钮
      this.ui.ccbar_cahold && this.ui.ccbar_cahold.addEventListener('click', () => {
        this.holdCall();
      });
      
      //恢复
      this.ui.ccbar_unhold && this.ui.ccbar_unhold.addEventListener('click', () => {
        this.unholdCall();
      });
      //退签
      this.ui.ccbar_signout && this.ui.ccbar_signout.addEventListener('click', () => {
        this.signOut();
      })
      //转外线
      this.ui.ccbar_transo && this.ui.ccbar_transo.addEventListener('click', () => {
        this.transSo(true);
      });
      //空闲
      this.ui.ccbar_set_id && this.ui.ccbar_set_id.addEventListener('click', () => {
        this.setId();
      });
      //置忙
      this.ui.ccbar_set_bu && this.ui.ccbar_set_bu.addEventListener('click', () => {
        this.setBu();
      });
      //休息
      this.ui.ccbar_set_re && this.ui.ccbar_set_re.addEventListener('click', () => {
        this.setRe();
      });
      //转内线
      // this.ui.ccbar_tranin && this.ui.ccbar_tranin.addEventListener('click', () => {
      //   this.transSo(true);
      // })
    }

    _stopWsPing() {
      if (this._wsPingTimer) {
        clearInterval(this._wsPingTimer);
        this._wsPingTimer = null;
      }
    }

    _startWsPing(socket) {
      this._stopWsPing();
      if (!socket) return;
      this._wsPingTimer = setInterval(() => {
        try {
          if (this._sipRefreshing || (this.ua && this.ua._registrator && this.ua._registrator._registering)) {
            return;
          }
          if (socket.isConnected && socket.isConnected()) {
            socket.send('\r\n\r\n');
          }
        } catch (e) {}
      }, this._wsPingIntervalMs);
    }

    _createSipSocket(wsUrl) {
      const socket = new JsSIP.WebSocketInterface(wsUrl);
      const origOnOpen = socket._onOpen.bind(socket);
      const origOnClose = socket._onClose.bind(socket);
      const origDisconnect = socket.disconnect.bind(socket);
      socket._onOpen = () => {
        origOnOpen();
        this._startWsPing(socket);
      };
      socket._onClose = (ev) => {
        this._stopWsPing();
        origOnClose(ev);
      };
      socket.disconnect = () => {
        this._stopWsPing();
        origDisconnect();
      };
      return socket;
    }

    _clearRebuildUaTimer() {
      if (this._rebuildUaTimer) {
        clearTimeout(this._rebuildUaTimer);
        this._rebuildUaTimer = null;
      }
    }

    _scheduleRebuildUa(reason) {
      if (this._signingOut || !this._sipLoginConfig) return;
      if (this._rebuildUaTimer) return;
      this._rebuildUaAttempts += 1;
      const delay = Math.min(15000, 1000 * Math.pow(2, Math.max(0, this._rebuildUaAttempts - 1)));
      console.warn('SIP 将重建 UA:', reason, 'attempt=', this._rebuildUaAttempts, 'delay=', delay);
      this.options.eventHandle.onWebPhoneHandle('ua.rebuild', {
        reason: reason,
        attempt: this._rebuildUaAttempts,
        delay: delay
      });
      this._rebuildUaTimer = setTimeout(() => {
        this._rebuildUaTimer = null;
        this._rebuildUa(reason);
      }, delay);
    }

    _rebuildUa(reason) {
      if (this._signingOut || !this._sipLoginConfig) return;
      try {
        this._executeLogin(this._sipLoginConfig, { rebuild: true });
      } catch (e) {
        console.error('重建 UA 失败:', e);
        this._scheduleRebuildUa(reason || 'rebuild-error');
      }
    }

    login(config) {
      this._signingOut = false;
      this._clearRebuildUaTimer();
      this._rebuildUaAttempts = 0;
      this._sipReady = false;
      // 清除之前的定时器
      if (this.loginTimeout) {
        clearTimeout(this.loginTimeout);
      }

      // 设置新的定时器
      this.loginTimeout = setTimeout(() => {
        this._executeLogin(config);
      }, 300);
    }
    
    // 登录功能
    _executeLogin(config, opts = {}) {
      const rebuild = !!opts.rebuild;
      this._clearRebuildUaTimer();
      this._stopWsPing();
      this._sipUaGeneration += 1;
      const generation = this._sipUaGeneration;

      if (this.ua) {
        try {
          this.ua.stop();
          if (this.ua.isConnected && this.ua.isConnected()) {
            this.ua.transport.disconnect();
          }
          this.ua.removeAllListeners();
        } catch (e) {}
        this.ua = null;
        if (!rebuild) {
          this.status.signedIn = false;
        }
      }

      if (!rebuild) {
        this.clearError();
      }
      this.loading.hide();
      if (!config || !config.url || !config.username || !config.password) {
        this.setError('缺少必要的登录参数');
        return;
      }

      config.register = config.register === false ? false : true;
      this._sipLoginConfig = Object.assign({}, config);
      this.options = {
        ...this.options,
        ...config
      }

      if (this.status.signedIn && !rebuild) {
          this.setError('已经处于签入状态');
          return;
        }
    
        // // 如果SIP UA已经存在且已注册，直接设置状态
        // if (this.ua && this.status.sipStatus === 'registered') {
        //   this.setStatus('workStatus', 'online');
        //   this.setStatus('serviceStatus', 'idle');
        //   this.options.eventHandle.onWebPhoneHandle('user.signedIn');
        //   console.log('长签成功(已注册)');
        //   return;
        // }

      try {
        this.setStatus('sipStatus', 'connecting');

        // 初始化JsSIP
        if(this.options.debug){
          JsSIP.debug.enable('*')
        }
        const useWss = config.useWss !== false;
        const wsHost = config.wsHost || config.url || config.turnIp;
        if (!wsHost) {
          throw new Error('缺少话机域名 domain');
        }
        const wsPort = useWss ? config.wssPort : config.wsPort;
        const omitPort = useWss ? (!wsPort || Number(wsPort) === 443) : (!wsPort || Number(wsPort) === 80);
        const portPart = !omitPort && wsPort ? ':' + wsPort : '';
        const pathPart = config.wsPath ? (config.wsPath.charAt(0) === '/' ? config.wsPath : '/' + config.wsPath) : '';
        const wsUrl = config.wsUrl || `${useWss ? 'wss' : 'ws'}://${wsHost}${portPart}${pathPart}`;
        const sipDomain = config.sipDomain || config.url || wsHost;
        const registerExpires = Number(config.registerExpries || config.registerExpires || config.register_expires);
        this._sipWsUrl = wsUrl;
        this._sipSocket = this._createSipSocket(wsUrl);
        this.ua = new JsSIP.UA({
          uri: `sip:${config.username}@${sipDomain}`,
          password: config.password,
          sockets: [this._sipSocket],
          register: config.register !== false,
          register_expires: registerExpires > 0 ? registerExpires : 600,
          session_timers: false,
          pcConfig: {
            iceServers: [{
              urls: `stun:${this.options.turnIp || config.turnIp}:${this.options.turnPort || config.turnPort || 3478}`
            }],
            iceCandidatePoolSize: 2
          },
        });
        if (!rebuild) {
          this.loading.show();
          setTimeout(() => {
            this.loading.hide();
          }, 2000)
        }
  
        // 注册事件处理
        this.ua.on('connected', () => {
          if (generation !== this._sipUaGeneration) return;
          this._sipReady = true;
          this._rebuildUaAttempts = 0;
          this.setStatus('sipStatus', 'connected');
          if (this.options.register === false) {
            this._sipCallReadyAt = Date.now() + 400;
          }
          this.options.eventHandle.onWebPhoneHandle('ua.connected');
        });
  
        this.ua.on('disconnected', (e) => {
          if (generation !== this._sipUaGeneration) return;
          this._stopWsPing();
          const code = (e && e.code) || (e && e.error && e.error.code);
          const reason = (e && e.reason) || (e && e.error && e.error.reason);
          if (this._signingOut) {
            this._signingOut = false;
            this.setStatus('sipStatus', 'unreg');
            this.options.eventHandle.onWebPhoneHandle('ua.disconnected', { error: false, reason: 'signout' });
            return;
          }
          console.error('离线:', e);
          if (code === 409) {
            this.setStatus('sipStatus', 'unregistered');
            this.setStatus('workStatus', 'offline');
            if (message?.error) {
              message?.error(reason);
            } else {
              this.setError(reason);
            }
            this.signOut(true);
            return;
          }
          if (!this._sipReady) {
            this.setStatus('sipStatus', 'failed');
            this.setStatus('workStatus', 'offline');
            this.setError('话机连接失败：' + String(this._sipWsUrl || '').replace(/([?&]token=)[^&]*/gi, '$1***') + (reason ? '（' + reason + '）' : ''));
          } else {
            this.setStatus('sipStatus', 'unregistered');
          }
          this.options.eventHandle.onWebPhoneHandle('ua.disconnected', { error: true, code: code, reason: reason });
          this._scheduleRebuildUa('disconnected');
        });
  
        this.ua.on('registered', () => {
          if (generation !== this._sipUaGeneration) return;
          this._sipReady = true;
          this._rebuildUaAttempts = 0;
          this.setStatus('sipStatus', 'registered');
          this._sipRefreshing = false;
          this._authFailedCount = 0;
          this._sipCallReadyAt = Date.now() + 1200;
          this._warmupWebRtc();
          this._startWsPing(this._sipSocket);
          document.querySelector('.ccbar_input_group_login')?.classList.add('disabled-button');
          if (!this.status.signedIn) {
            this.status.signedIn = true;
            this.setStatus('workStatus', 'online');
            this.options.eventHandle.onWebPhoneHandle('user.signedIn');
          }
          if(!this.options.register){
            this.setStatus('workStatus', 'busy');
            setTimeout(() => {
              this.setBu(true)
            }, 1500)
          }
          this.options.eventHandle.onWebPhoneHandle('reg.registered');
        });
  
        this.ua.on('registrationExpiring', () => {
          if (generation !== this._sipUaGeneration) return;
          this._sipRefreshing = true;
          this._stopWsPing();
          try {
            this.ua.register();
          } catch (err) {
            console.warn('SIP 续注册触发失败:', err);
          }
        });

        this.ua.on('unregistered', () => {
          if (generation !== this._sipUaGeneration) return;
          this.setStatus('sipStatus', 'unregistered');
          this.options.eventHandle.onWebPhoneHandle('reg.unregistered');
          if (this._sipReady && !this._signingOut) {
            this._sipCallReadyAt = Date.now() + 800;
          }
        });
  
        this.ua.on('registrationFailed', (e) => {
          if (generation !== this._sipUaGeneration) return;
          if (this._signingOut) return;
          const reason = e && (e.cause || (e.error && e.error.reason) || e.message);
          this.options.eventHandle.onWebPhoneHandle('reg.failed', { cause: reason });
          if (this._sipReady && this.ua && this.ua.isConnected()) {
            this.setStatus('sipStatus', 'unregistered');
            this._sipRefreshing = false;
            const isAuth = /Authentication Error/i.test(String(reason || ''));
            this._authFailedCount = (this._authFailedCount || 0) + 1;
            if (isAuth || this._authFailedCount >= 2) {
              console.warn('SIP 续注册鉴权失败，重建 UA:', reason);
              this._scheduleRebuildUa('registration-auth');
              return;
            }
            console.warn('SIP 续注册失败，稍后重试 REGISTER:', reason);
            if (this._reregisterTimer) clearTimeout(this._reregisterTimer);
            this._reregisterTimer = setTimeout(() => {
              this._reregisterTimer = null;
              try {
                if (this.ua && generation === this._sipUaGeneration && !this._signingOut) {
                  this.ua.register();
                }
              } catch (err) {}
            }, 800);
            return;
          }
          this.setStatus('sipStatus', 'failed');
          console.error('Registration failed:', e);
          if (!this._sipReady) {
            this.setStatus('workStatus', 'offline');
          }
          this.setError('SIP 注册失败' + (reason ? '：' + reason : '') + '（' + String(this._sipWsUrl || '').replace(/([?&]token=)[^&]*/gi, '$1***') + '）');
          this._scheduleRebuildUa('registrationFailed');
        });
  
        this.ua.on('newRTCSession', (data) => {
          if (generation !== this._sipUaGeneration) return;
          console.log('新会话:', data);
          
          this.handleNewSession(data.session);
          const xCallId = data.request.getHeader('X-Call-Id'); ;
          console.log(xCallId,'data.session.requestdata.session.request');
          
          this.options.eventHandle.onWebPhoneHandle('newRTCSession', {
            call_id: xCallId || data?.request.call_id
          });
        });
  
        // 开始连接
        this.ua.start();
      } catch (error) {
        console.log('初始化SIP失败:', error);
        this.setError('初始化SIP失败: ' + error.message);
        this.setStatus('sipStatus', 'error');
        if (this._sipLoginConfig && !this._signingOut) {
          this._scheduleRebuildUa('init-error');
        }
      }
      // }, 2000)
    }

    // 处理新会话
    handleNewSession(session) {
      // 记录通话前的 workStatus，用于结束后恢复
      this.status._preWorkStatus = this.status.workStatus;
      this._pendingCallRetry = false;
      this._addSession(session);
      this.setStatus('serviceStatus', 'busy');

      // Common event listeners setup with safety checks
      const setupCommonListeners = () => {
        try {
          session.on('peerconnection', (e) => {
            this._bindPeerAudio(session, e.peerconnection);
          });
          if (session.connection) {
            this._bindPeerAudio(session, session.connection);
          }
        } catch (error) {
          console.error('设置WebRTC监听器时出错:', error);
          this.setError('设置音频连接失败: ' + error.message);
        }
      };
    
      // Handle incoming call specific events
      if (session.direction === 'incoming') {
        this.options.eventHandle.onWebPhoneHandle('incoming.notify');
        console.log('来电');
        const caller = session.remote_identity.display_name || session.remote_identity.uri.user;
        this.options.eventHandle.onRecviceCall(caller, { callid: session.id });
      
        session.on('accepted', () => {
          this._refreshServiceStatus();
          this._focusActiveSessionAudio();
          this.options.eventHandle.onWebPhoneHandle('incoming.accepted', { sessionId: session.id });
        });

        session.on('ended', (data) => {
          const reasonHeader = data.message?.getHeader('Reason');
    
          if (reasonHeader) {          
              const match = reasonHeader.match(/text="([^"]+)"/);

              if (match && match[1]) {
                  const timeoutReason = match[1];
                  data.desc = timeoutReason;
              }
          }
          data.sessionId = session.id;
          this.options.eventHandle.onWebPhoneHandle('incoming.ended', data);
          this._removeSession(session);
          // 通话结束后保持原有的 workStatus（忙碌/在线），不强制切换为在线
          if (this.sessions.size === 0) {
            this._refreshServiceStatus();
          }
        });

        session.on('failed', (data) => {
          const reasonHeader = data.message?.getHeader('Reason');
    
          if (reasonHeader) {          
              const match = reasonHeader.match(/text="([^"]+)"/);
              if (match && match[1]) {
                  const timeoutReason = match[1];
                  data.desc = timeoutReason;
              }
          }
          data.sessionId = session.id;
          this.options.eventHandle.onWebPhoneHandle('incoming.failed', data);
          this._removeSession(session);
          // 通话结束/失败后保持原有的 workStatus，不强制切换为在线
          if (this.sessions.size === 0) {
            this._refreshServiceStatus();
          }
        });
      
        session.on('hold', (data) => {
          if (session.id === this.activeSessionId) {
            this.setStatus('serviceStatus', 'hold');
          }
          data.sessionId = session.id;
          this.options.eventHandle.onWebPhoneHandle('call.hold', data);
        });

        session.on('unhold', (data) => {
          this._refreshServiceStatus();
          data.sessionId = session.id;
          this.options.eventHandle.onWebPhoneHandle('call.unhold', data);
        });
      } else if (session.direction === 'outgoing') {
        session.on('progress', (data) => {
          data.sessionId = session.id;
          this.options.eventHandle.onWebPhoneHandle('outgoing.progress', data);
        });
        // 未接通时主动挂断（CANCEL），JsSIP 触发 cancel 而非 ended
        session.on('cancel', () => {
          this.options.eventHandle.onWebPhoneHandle('outgoing.cancel', { sessionId: session.id });
          this._removeSession(session);
          if (this.sessions.size === 0) {
            this._refreshServiceStatus();
          }
        });
        session.on('accepted', (data) => {
          data.sessionId = session.id;
          this.options.eventHandle.onWebPhoneHandle('outgoing.accepted', data);
          this._refreshServiceStatus();
          this._focusActiveSessionAudio();
        });
        session.on('failed', (data) => {
          data.sessionId = session.id;
          this.options.eventHandle.onWebPhoneHandle('outgoing.failed', data);
          if (data.originator !== 'local' && this._shouldRetryCall(data)) {
            this._pendingCallRetry = true;
            this.setStatus('serviceStatus', 'calling');
            this._removeSession(session);
            this._retryLastCall();
            return;
          }
          this._removeSession(session);
          if (data.originator !== 'local') {
            const status = data.message && data.message.status_code;
            const cause = data.cause || status || '';
            this.setError('呼叫失败' + (cause ? '：' + cause : ''));
          }
        });
        session.on('ended', (data) => {
          data.sessionId = session.id;
          this.options.eventHandle.onWebPhoneHandle('outgoing.ended', data);
          this._removeSession(session);
          // 通话结束后保持原有的 workStatus（忙碌/在线），不强制切换为在线
          if (this.sessions.size === 0) {
            this._refreshServiceStatus();
          }
        });
      }
    
      setupCommonListeners();
      if (session.connection) {
        queueMicrotask(() => this._focusActiveSessionAudio());
      }
    }

    //音频处理（仅当前激活路输出到 remoteAudio，避免多路互相覆盖）
    handleAudioStream(stream, session = null) {
      if (session && this.activeSessionId && session.id !== this.activeSessionId) {
        return;
      }
      this._attachRemoteAudio(session);
    }

    cleanupSessionListeners(session) {
      if (!session) return;

      try {
        // 移除connection监听器
        if (session.connection && session._listeners) {
          session.connection.removeEventListener('track', session._listeners.track);
          session.connection.removeEventListener(
            'iceconnectionstatechange', 
            session._listeners.iceChange
          );
        }

        // 移除所有JsSIP事件监听
        session.off();
      } catch (e) {
        console.error('清理监听器时出错:', e);
      }
    }

    /**
     * 将 userdata（字符串）写入 SIP INVITE 的 X-User-Data 头
     * 仅接受非空字符串，其它类型忽略
     * @returns {string[]}
     */
    _userDataToExtraHeaders(userdata) {
      if (userdata == null || typeof userdata !== 'string') {
        return [];
      }
      const trimmed = userdata.trim();
      if (trimmed === '') {
        return [];
      }
      return ['X-User-Data: ' + trimmed];
    }

    /**
     * 合并 JsSIP extraHeaders 与 X-User-Data
     */
    _mergeExtraHeaders(baseExtraHeaders, userdata) {
      return [...(baseExtraHeaders || []), ...this._userDataToExtraHeaders(userdata)];
    }
  
    _stopLocalStream() {
      if (!this._localStream) return;
      try {
        this._localStream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      this._localStream = null;
    }

    _stopSessionMedia(session) {
      try {
        const conn = session && session.connection;
        if (!conn) return;
        const stopTrack = (t) => {
          try { if (t && t.stop) t.stop(); } catch (e) {}
        };
        (conn.getSenders ? conn.getSenders() : []).forEach((s) => stopTrack(s && s.track));
        (conn.getReceivers ? conn.getReceivers() : []).forEach((r) => stopTrack(r && r.track));
      } catch (e) {}
    }

    _releaseCallMedia() {
      this._stopLocalStream();
      const el = document.getElementById('remoteAudio');
      if (!el) return;
      try { el.pause(); } catch (e) {}
      el.srcObject = null;
    }

    async _ensureLocalAudio() {
      const live = this._localStream && this._localStream.getAudioTracks().some((t) => t.readyState === 'live');
      if (live) return this._localStream;
      this._stopLocalStream();
      this._localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      return this._localStream;
    }

    _warmupWebRtc() {
      if (this._webrtcWarmed || this._webrtcWarming) return this._webrtcWarming;
      const iceServers = [];
      const turnIp = this.options.turnIp;
      const turnPort = this.options.turnPort || 3478;
      if (turnIp) {
        iceServers.push({ urls: 'stun:' + turnIp + ':' + turnPort });
      }
      let pc;
      try {
        pc = new RTCPeerConnection({ iceServers: iceServers, iceCandidatePoolSize: 2 });
        pc.addTransceiver('audio', { direction: 'sendrecv' });
      } catch (e) {
        this._webrtcWarmed = true;
        return Promise.resolve();
      }
      this._webrtcWarming = pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => {})
        .then(() => {
          this._webrtcWarmed = true;
          this._webrtcWarming = null;
          try { pc.close(); } catch (e) {}
        });
      return this._webrtcWarming;
    }

    _isTemporarilyUnavailable(data) {
      const code = data && data.message && data.message.status_code;
      if (Number(code) === 480) return true;
      return /480|Temporarily Unavailable|UNAVAILABLE/i.test(String((data && data.cause) || ''));
    }

    _shouldRetryCall(data) {
      return !this._callRetried && this._lastCallArgs && this._isTemporarilyUnavailable(data);
    }

    _retryLastCall() {
      const args = this._lastCallArgs;
      if (!args) return;
      this._callRetried = true;
      this._pendingCallRetry = true;
      this.setStatus('serviceStatus', 'calling');
      console.warn('首通 480 Temporarily Unavailable，自动重拨一次');
      this.options.eventHandle.onWebPhoneHandle('outgoing.retry', { reason: '480' });
      setTimeout(() => {
        this._startSipCall(args.target, args.options, args.userdata).catch((err) => {
          this._pendingCallRetry = false;
          this._refreshServiceStatus();
          this.setError('呼叫失败: ' + (err && err.message ? err.message : err));
        });
      }, 800);
    }

    async _waitUntilSipReady(timeoutMs = 8000) {
      if (!this.ua) {
        throw new Error('SIP未初始化');
      }
      const needRegister = this.options.register !== false;
      const isReady = () => {
        if (!this.ua || !this.ua.isConnected()) return false;
        if (needRegister && typeof this.ua.isRegistered === 'function' && !this.ua.isRegistered()) return false;
        const registering = !!(this.ua._registrator && this.ua._registrator._registering);
        if (registering) {
          this._sipWasRegistering = true;
          return false;
        }
        if (this._sipWasRegistering) {
          this._sipWasRegistering = false;
          this._sipCallReadyAt = Math.max(this._sipCallReadyAt || 0, Date.now() + 500);
        }
        if (this._sipCallReadyAt && Date.now() < this._sipCallReadyAt) return false;
        return true;
      };
      if (isReady()) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          clearInterval(poll);
          reject(new Error(needRegister && this.ua && this.ua.isConnected()
            ? '话机尚未注册完成，请稍后再拨'
            : 'SIP未连接'));
        }, timeoutMs);
        const poll = setInterval(() => {
          if (isReady()) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve();
          }
        }, 100);
      });
    }

    async _startSipCall(target, options = {}, userdata = '') {
      await this._waitUntilSipReady();
      const mediaStream = await this._ensureLocalAudio();
      await this._warmupWebRtc();
      this._lastCallArgs = { target: target, options: options, userdata: userdata };
      this.setStatus('serviceStatus', 'calling');
      this.ua.call(target, {
        mediaConstraints: { audio: true, video: false },
        mediaStream,
        sessionTimersExpires: 120,
        ...options,
        extraHeaders: this._mergeExtraHeaders(options.extraHeaders, userdata),
        ...(typeof userdata === 'string' && userdata.trim() !== ''
          ? { data: userdata }
          : {})
      });
    }

    // 外呼功能
    async call(number, params = {}) {
      const { options = {}, userdata = '' } = params;
      this.clearError();
      
      try {
        if (!this.ua) {
          this.setError('SIP未连接');
          return;
        }

        if(this.status.workStatus === 'reset'){
          return
        }

        this._callRetried = false;
        await this._startSipCall(number, options, userdata);
      } catch (error) {
        this.setError('呼叫失败: ' + error.message);
      }
    }


        //内呼功能
    async insideCall(number, options = {}) {
      const { userdata, ...restOptions } = options;
      this.clearError();
      
      try {
        if (!this.ua) {
          this.setError('SIP未连接');
          return;
        }

        if(this.status.workStatus === 'reset'){
          return
        }

        this._callRetried = false;
        const insideNumber = `${this.options.prefix}${number}`
        await this._startSipCall(insideNumber, restOptions, userdata);
      } catch (error) {
        this.setError('呼叫失败: ' + error.message);
      }
    }
  
    // 挂断功能（不传 sessionId 则挂断当前激活路）
    hangup(sessionId) {
      this.clearError();
      const target =
        sessionId != null ? this.getSession(sessionId) : this.getActiveSession();
      if (!target) {
        this.setError('没有可挂断的通话');
        return;
      }
      try {
        target.terminate();
      } catch (error) {
        this.setError('挂断失败: ' + error.message);
      }
      if (this.sessions.size === 0) {
        this._releaseCallMedia();
      }
    }
    //保持当前通话（可传 sessionId 指定路）
    holdCall(sessionId) {
      this.clearError();
      const target =
        sessionId != null ? this.getSession(sessionId) : this.getActiveSession();
      if (!target) {
        this.setError('没有活跃的通话');
        return;
      }
    
      try {
        target.hold();
        this._refreshServiceStatus();
        this.options.eventHandle.onWebPhoneHandle('call.hold', { sessionId: target.id });
      } catch (error) {
        console.error('保持通话异常:', error);
        this.setError('保持通话异常: ' + error.message);
      }
    }

    //恢复被保持的通话
    unholdCall(sessionId) {
      this.clearError();
      const target =
        sessionId != null ? this.getSession(sessionId) : this.getActiveSession();
      if (!target) {
        this.setError('没有活跃的通话');
        return;
      }
    
      try {
        target.unhold();
        this._refreshServiceStatus();
        this.options.eventHandle.onWebPhoneHandle('call.unhold', { sessionId: target.id });
      } catch (error) {
        console.error('恢复通话异常:', error);
        this.setError('恢复通话异常: ' + error.message);
      }
    }
    // 退签功能
    signOut(isLogin = false) {
      this.clearError();
      this._signingOut = true;
      this._clearRebuildUaTimer();
      this._stopWsPing();
      this._sipLoginConfig = null;
      this._sipReady = false;
      this._rebuildUaAttempts = 0;
      this._sipUaGeneration += 1;
      if (!this.ua) {
        this._signingOut = false;
        this.setError('SIP未初始化，无法退签');
        return;
      }
    
      try {
        // 如果有活跃的通话，先全部挂断
        if (this.sessions.size > 0) {
          this.hangupAll();
        }
    
        // 停止SIP UA并注销
        if (this.ua) {
          this.ua.stop();
          this.ua.removeAllListeners();
        }
        
        // 重置状态
        this.setStatus('workStatus', 'offline');
        this.setStatus('serviceStatus', 'idle');
        this.setStatus('sipStatus', 'unreg');
        this.status.signedIn = false;
        if(!isLogin){
          this.setSeatStatus('Logged Out');
        }
        // 清除引用
        this.ua = null;
        this.sessions.clear();
        this.activeSessionId = null;
        this._stopLocalStream();
        this._sipCallReadyAt = 0;
        this._sipWasRegistering = false;
        this._webrtcWarmed = false;
        this._callRetried = false;
        this._lastCallArgs = null;
        if (this._reregisterTimer) {
          clearTimeout(this._reregisterTimer);
          this._reregisterTimer = null;
        }
        
        // 触发事件
        this.options.eventHandle.onWebPhoneHandle('user.signout');
        this.loading.show();
        setTimeout(() => {
          this.loading.hide();
        }, 2000);
        const el = document?.querySelector('.ccbar_input_group_login');
        if(el && el.classList.contains('disabled-button')){
          el.classList.remove('disabled-button');
        }
        
        console.log('退签成功');
        this._signingOut = false;
      } catch (error) {
        this._signingOut = false;
        this.setError('退签失败: ' + error.message);
        console.error('退签失败:', error);
      }
    }
    //转接
    transSo(isIn, sessionId) {
      this.clearError();
      // 如果没有传入目标号码，则从输入框获取
      const number = this.ui?.numberInput.value.trim();
      const target =
        sessionId != null ? this.getSession(sessionId) : this.getActiveSession();
        
      if (!target) {
        this.setError('没有活跃的通话可转接');
        return;
      }
    
      if (!number) {
        this.setError('请输入转外线号码');
        return;
      }
    
      const tranNumber = isIn ? `${this.options.prefix}${number}` : number
      try {
        const domain = this.ua.configuration.uri.host || window.location.hostname;
        const targetUri = `sip:${tranNumber}@${domain};api_key=${this.options.apiKey}`;

        console.log('Attempting refer to:', targetUri);
      
        // 使用 refer 方法代替 transfer
        target.refer(targetUri, { 
          eventHandlers: {
            succeeded: (response) => {
              console.log('转接成功', response);
              this.options.eventHandle.onWebPhoneHandle('externalTransfer.success', response);
            },
            failed: (cause) => {
              console.error('转接失败', cause);
              this.setError(`转接失败: ${cause}`);
              this.options.eventHandle.onWebPhoneHandle('externalTransfer.error', cause);
            }
          }
        });

      } catch (error) {
        console.error('转外线异常:', error);
        this.setError('转外线异常: ', error);
        this.options.eventHandle.onWebPhoneHandle('externalTransfer.error', error);
      }
     }

     // 接听来电（可传 sessionId；不传则优先当前激活路，否则第一通未接来电）
    answer(sessionId) {
      this.clearError();
      
      let target =
        sessionId != null ? this.getSession(sessionId) : this.getActiveSession();
      if (!target) {
        target = [...this.sessions.values()].find(
          (s) => s.direction === 'incoming' && !s.isEstablished()
        );
      }
      if (!target) {
        this.setError('没有来电可以接听');
        return;
      }
      
      if (target.direction !== 'incoming') {
        this.setError('当前会话不是来电');
        return;
      }
      
      try {
        this.setActiveSession(target.id);
        target.answer({
          mediaConstraints: { audio: true, video: false },
          rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
        });
        this._bindPeerAudio(target, target.connection);
        this._attachRemoteAudio(target);
        [300, 800, 1600, 3000].forEach((ms) => {
          setTimeout(() => this._attachRemoteAudio(target), ms);
        });
        
        this.setStatus('serviceStatus', 'calling');
        this.setStatus('workStatus', 'busy');
        this.options.eventHandle.onWebPhoneHandle('incoming.answered');
      } catch (error) {
        this.setError('接听失败: ' + error.message);
        console.error('接听失败:', error);
      }
    }

    //空闲
    setId() {
      console.trace('setId 被调用了，调用栈：'); 
      this.clearError();
      try {
        // 如果当前有通话，不能直接设置为空闲
        if (this.sessions.size > 0) {
          this.setError('请先结束当前通话');
          return;
        }
      
        // 如果SIP未注册，不能设置为空闲
        if (!this.ua || this.status.sipStatus !== 'registered') {
          this.setError('SIP未注册，无法设置为空闲');
          return;
        }
      
        // 设置工作状态为在线，服务状态为空闲
        this.setStatus('workStatus', 'online');
        this.setStatus('serviceStatus', 'idle');

        this.setSeatStatus('Available', '空闲');
        // 触发事件
        this.options.eventHandle.onWebPhoneHandle('status.idle');
        console.log('已设置为空闲状态');

      } catch (error) {
        this.setError('设置空闲状态失败: ' + error.message);
        console.error('设置空闲状态失败:', error);
      }
    }
    //置忙  可以外呼不能呼入
    setBu(isRegister = false) {
      this.clearError();
      try {
        // 如果SIP未注册，不能设置为忙碌
        if (!this.ua || this.status.sipStatus !== 'registered') {
          this.setError('SIP未注册，无法设置为忙碌');
          return;
        }
    
        // 设置工作状态为忙碌
        if(!isRegister){
          this.setStatus('workStatus', 'busy');
        }
        
        // 如果有通话中，服务状态保持为busy
        if (this.sessions.size === 0) {
          this.setStatus('serviceStatus', 'idle');
        }

        this.setSeatStatus('On Break', '忙碌');
        // 触发事件
        this.options.eventHandle.onWebPhoneHandle('status.busy');
        console.log('已设置为忙碌状态');
        
      } catch (error) {
        this.setError('设置忙碌状态失败: ' + error.message);
        console.error('设置忙碌状态失败:', error);
      }
    }

    //休息
    setRe() {
      this.clearError();
      try {
        // 如果SIP未注册，不能设置为休息
        if (!this.ua || this.status.sipStatus !== 'registered') {
          this.setError('SIP未注册，无法设置为休息');
          return;
        }

        if (this.sessions.size > 0) {
          this.setError('请先结束当前通话再休息');
          return;
        }
    
        // 设置工作状态为休息
        this.setStatus('workStatus', 'reset');
        this.setStatus('serviceStatus', 'idle');
        // 设置 UA 的接收模式为拒绝
        // this.ua.configuration.receiveIncomingCalls = false;
        // 触发事件
        this.options.eventHandle.onWebPhoneHandle('status.reset');
        console.log('已设置为休息状态');
        this.setSeatStatus('On Break', '休息');
        
      } catch (error) {
        this.setError('设置休息状态失败: ' + error.message);
        console.error('设置休息状态失败:', error);
      }
    }
    //长签
    signIn() {
      this.clearError();
      try {
        // 如果已经长签，不需要重复操作
        if (this.status.signedIn) {
          this.setError('已经处于签入状态');
          return;
        }
    
        // 如果SIP UA已经存在且已注册，直接设置状态
        if (this.ua && this.status.sipStatus === 'registered') {
          this.status.signedIn = true;
          this.setStatus('workStatus', 'online');
          this.setStatus('serviceStatus', 'idle');
          this.options.eventHandle.onWebPhoneHandle('user.signedIn');
          console.log('长签成功(已注册)');
          return;
        }
    
        // 从UI获取登录信息

        // const url = document.getElementById('____ccbar_url_input____').value.trim();
        // const username = document.getElementById('____ccbar_username_input____').value.trim();
        // const password = document.getElementById('____ccbar_password_input____').value.trim();
        // const customer = document.getElementById('____ccbar_customer_input____').value.trim();
        const { url, username, password } = this.options;
    
        if (!url || !username || !password) {
          this.setError('URL、用户名和密码不能为空');
          return;
        }
    
        // 配置长签参数
        const loginConfig = {
          url: url,
          username: username,
          password: password,
          type: 'persistent',
          // lineMode: 'SIP'
        };
    
        // 调用登录功能
        this.login(this.options);
        
        // 标记为已长签
        this.status.signedIn = true;
        
        // 设置初始状态
        // this.setStatus('workStatus', 'online');
        // this.setStatus('serviceStatus', 'idle');
        
        // 触发事件
        this.options.eventHandle.onWebPhoneHandle('user.signedIn');
        console.log('长签成功');    
      } catch (error) {
        this.setError('长签失败: ' + error.message);
        console.error('长签失败:', error);
        this.status.signedIn = false;
      }
    }

    //获取坐席账号
    getSeatAccountList(data = {}) {
      return new Promise((resolve, reject) => {
        this.post('/seat/account/get', data).then(data => {
          resolve(data);
        }).catch(err => {
          reject(err);
        });
      })
    }
    //获取坐席账号
    getAccount(options = {}) {
      return new Promise((resolve, reject) => {
        this.post('/seat/account/get', {}, options).then(data => {
          resolve(data);
        }).catch(err => {
          reject(err);
        });
      })
    }

     //获取坐席账号third
    getAccountThird(options = {}) {
      return new Promise((resolve, reject) => {
        this.post('/seat/third/account/get', {}, options).then(data => {
          resolve(data);
        }).catch(err => {
          reject(err);
        });
      })
    }

    getToken (Fn, isRefresh = false){
      if(typeof Fn !== 'function') {
        throw new Error('Fn must be a function');
        return
      }
      this.reqFn = Fn
      return new Promise (async(resolve, reject) => {
        try {
          const result = await Fn();
          const { token = '', expires = 3600000} = result

          this.defaultOptions.httpConfig.headers['Authorization'] = token

          const refreshTime = (expires - this.refreshBufferTime) || 3600;
          if(!isRefresh){
            resolve(result)
          }

          if(this.refreshTimeout){
            clearTimeout(this.refreshTimeout)
          }

          if(typeof refreshTime === 'number' && refreshTime > 0){
            // 设置刷新定时器
            this.refreshTimeout = setTimeout(() => {
              this.getToken(this.reqFn, true);
            }, refreshTime * 1000);
          }
        } catch (error) {
          reject(error)
        }
      })     
    }
    
  
    // 设置状态
    setStatus(type, value) {
      this.status[type] = value;
      this.updateUIStatus();
      this.options.eventHandle.onStatusChange(
        this.status.workStatus,
        this.status.serviceStatus,
        this.status.signedIn,
        this.status.sipStatus
      );
    }

    // 更新UI状态显示
    updateUIStatus() {
      // 工作状态
      if(this.ui.workStatus){
        this.ui.workStatus.textContent = this.getStatusText('work', this.status.workStatus);
        this.ui.workStatus.className = `ccbar_status ccbar_work_status_${this.status.workStatus}`;
      }
      // 服务状态
      if(this.ui.serStatus){
        this.ui.serStatus.textContent = this.getStatusText('serv', this.status.serviceStatus);
        this.ui.serStatus.className = `ccbar_status ccbar_serv_status_${this.status.serviceStatus}`;
      }
      // SIP状态
      if(this.ui.sipStatus){  
        this.ui.sipStatus.textContent = this.getStatusText('sip', this.status.sipStatus);
        this.ui.sipStatus.className = `ccbar_status ccbar_sip_status_${this.status.sipStatus === 'registered' ? 'reg' : 'unreg'}`;
      }
    }
  
    // 获取状态文本
    getStatusText(type, status) {
      const texts = {
        work: {
          offline: '离线',
          online: '在线',
          busy: '忙碌',
          reset: '休息'
        },
        serv: {
          idle: '空闲',
          busy: '振铃中',
          calling: '呼出中',
          hold: '保持中',
          transferring: '转接中'
        },
        sip: {
          unreg: '未注册',
          connecting: '连接中',
          connected: '已连接',
          registered: '已注册',
          unregistered: '未注册',
          failed: '注册失败',
          error: '错误'
        }
      };
      return texts[type][status] || status;
    }
  
    // 设置错误信息
    setError(message) {
      if(this.ui?.errorInfo){
        this.ui.errorInfo.textContent = message;
      }
      this.options.eventHandle.onError(message);
    }
  
    // 清除错误信息
    clearError() {
      if(this.ui?.errorInfo){
        this.ui.errorInfo.textContent = '';
      }
    }
    //设置坐席状态
    setSeatStatus(status, reason = '') {
        if(!this.options.username || !status) return
        //状态 Available-登陆 Logged Out-退出 On Break-休息 this.options.username
        return new Promise((resolve, reject) => {
          this.post('/seats/set-status', { extension: this.options.username, status, reason }).then(data => {
          // this.post('/seats/third/set-status', { extension: this.options.username, status, reason }).then(data => {
            resolve(data);
          }).catch(err => {
            reject(err);
          });
        })
    }

    //设置坐席状态third
    // setSeatStatusThird(status, reason = '') {
    //     if(!this.options.username || !status) return
    //     //状态 Available-登陆 Logged Out-退出 On Break-休息 this.options.username
    //     return new Promise((resolve, reject) => {
    //       this.post('/seats/third/set-status', { extension: this.options.username, status, reason }).then(data => {
    //         resolve(data);
    //       }).catch(err => {
    //         reject(err);
    //       });
    //     })
    // }
}
  
  // 暴露到全局
  window.CCBarSDK = CCBar;