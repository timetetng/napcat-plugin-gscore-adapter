 import WebSocket from 'ws';
import type { OB11Message, OB11PostSendMsg } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';

/**
 * GsCore Message 结构（早柚核心消息单元）
 */
interface GsCoreMessage {
  type: string | null;
  data: unknown;
}

/**
 * GsCore MessageSend 结构（早柚核心发送的消息）
 */
interface GsCoreMessageSend {
  bot_id: string;
  bot_self_id: string;
  msg_id: string;
  target_type: string | null;
  target_id: string | null;
  content: GsCoreMessage[] | null;
}

export class GScoreService {
  private static instance: GScoreService;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private isManualRetry: boolean = false;
  private isTimeoutTerminated: boolean = false;
  private readonly CONNECTION_TIMEOUT = 10000;

  private constructor() { }

  public static getInstance(): GScoreService {
    if (!GScoreService.instance) {
      GScoreService.instance = new GScoreService();
    }
    return GScoreService.instance;
  }

  public getStatus(): 'connected' | 'connecting' | 'disconnected' {
    if (this.ws?.readyState === WebSocket.OPEN) return 'connected';
    if (this.isConnecting || this.ws?.readyState === WebSocket.CONNECTING || this.reconnectTimer) return 'connecting';
    return 'disconnected';
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  public getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * 手动重连命令处理
   */
  public async manualReconnect(): Promise<string> {
    if (this.isManualRetry) {
      return '⚠️ 手动重连正在进行中，请勿重复触发。';
    }

    const maxAttempts = pluginState.config.maxReconnectAttempts ?? 10;
    if (maxAttempts === 0) {
      return '当前已开启无限重连模式，连接器会自动尝试连接，您无需执行此命令。';
    }

    const status = this.getStatus();
    if (status === 'connected') {
      return '✅ 当前 Bot 已连接。';
    }
    if (status === 'connecting') {
      return '🔄 正在重连中，请稍后查看状态。';
    }

    this.disconnect(true);
    this.isManualRetry = true;
    pluginState.logger.info('[GScore] 触发手动重连命令');
    this.connect();

    const result = await new Promise<string>((resolve) => {
      const timer = setInterval(() => {
        if (this.getStatus() === 'connected') {
          clearInterval(timer);
          this.isManualRetry = false;
          resolve('✅ 当前 Bot 已连接。');
          return;
        }
        if (!this.isManualRetry) {
          clearInterval(timer);
          resolve('❌ 连接失败，手动重连次数已达上限，请检查配置或手动重试。');
        }
      }, 500);
    });

    return result;
  }

  public connect() {
    if (!pluginState.config.gscoreEnable) {
      this.disconnect();
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) {
      pluginState.logger.debug('[GScore] 连接已存在或正在连接中，跳过重复连接');
      return;
    }

    // 如果存在定时器，先清除
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }

    this.isConnecting = true;
    let url = pluginState.config.gscoreUrl || 'ws://localhost:8765';

    // 确保 url 不以 / 结尾
    if (url.endsWith('/')) {
      url = url.slice(0, -1);
    }

    // 使用 napcat-qq号 作为 bot_id 以兼容多bot
    const botId = `napcat-${pluginState.selfId || 'unknown'}`;
    // 如果 url 不包含 /ws/，则拼接 /ws/{botId}
    if (!url.includes('/ws/')) {
      url = `${url}/ws/${botId}`;
    }

    const token = pluginState.config.gscoreToken || '';

    // 如果 url 不包含 token 且 token 存在，则拼接到 url query
    const wsUrl = new URL(url);
    if (token && !wsUrl.searchParams.has('token')) {
      wsUrl.searchParams.append('token', token);
    }

    pluginState.logger.info(`[GScore] 正在连接...`);

    try {
      this.ws = new WebSocket(wsUrl.toString());

      this.connectionTimeout = setTimeout(() => {
        if (this.isConnecting && this.ws && this.ws.readyState !== WebSocket.OPEN) {
          pluginState.logger.warn('[GScore] 连接超时，正在终止...');
          this.isTimeoutTerminated = true;
          this.isConnecting = false;
          this.ws.terminate();
        }
      }, this.CONNECTION_TIMEOUT);

      this.ws.on('open', () => {
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
        pluginState.logger.info('[GScore] 连接成功！');
        this.isConnecting = false;
        this.isTimeoutTerminated = false;
        this.reconnectAttempts = 0;
        this.isManualRetry = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      });

      this.ws.on('message', (data) => {
        try {
          // GsCore 发回的是 MessageSend 的二进制 JSON
          const raw = typeof data === 'string' ? data : data.toString('utf-8');
          const msgSend = JSON.parse(raw) as GsCoreMessageSend;

          pluginState.logger.debug(`[GScore] 收到消息: target_type=${msgSend.target_type}, target_id=${msgSend.target_id}`);

          // 处理 GsCore 发回的消息
          this.handleGsCoreMessage(msgSend);
        } catch (err) {
          pluginState.logger.error('[GScore] 解析收到的消息失败:', err);
        }
      });

      this.ws.on('error', (err) => {
        if (!this.isTimeoutTerminated) {
          const errorMsg = err.message || '连接失败（可能是目标地址不可达或被拒绝）';
          const errorCode = (err as any).code || '';
          if (errorCode) {
            pluginState.logger.error(`[GScore] 连接错误 [${errorCode}]: ${errorMsg}`);
          } else {
            pluginState.logger.error(`[GScore] 连接错误: ${errorMsg}`);
          }
        }
        if (this.isConnecting) {
          this.isConnecting = false;
        }
      });

      this.ws.on('close', (code, reason) => {
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
        this.isConnecting = false;
        this.ws = null;
        if (!this.isTimeoutTerminated) {
          const reasonStr = reason.toString() || '';
          if (code === 1006) {
            pluginState.logger.warn(`[GScore] 连接异常关闭 (1006): ${reasonStr || '目标服务器无响应或连接被拒绝，请检查 gscoreUrl 是否正确'}`);
          } else {
            pluginState.logger.warn(`[GScore] 连接关闭: ${code} ${reasonStr}`);
          }
        }
        this.isTimeoutTerminated = false;
        setImmediate(() => this.scheduleReconnect());
      });

    } catch (error) {
      pluginState.logger.error('[GScore] 创建连接失败:', error);
      this.isConnecting = false;
      setImmediate(() => this.scheduleReconnect());
    }
  }

  public disconnect(resetCounter: boolean = true) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
    this.isTimeoutTerminated = false;
    if (resetCounter) {
      this.reconnectAttempts = 0;
      this.isManualRetry = false;
    }
  }

  private scheduleReconnect() {
    if (!pluginState.config.gscoreEnable) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const maxAttempts = this.isManualRetry ? 3 : (pluginState.config.maxReconnectAttempts ?? 10);

    // maxAttempts 为 0 时表示无限重试
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      if (this.isManualRetry) {
        pluginState.logger.error(`[GScore] 手动重连次数已达上限（${maxAttempts})，停止重连。请检查配置或手动重试。`);
      } else {
        pluginState.logger.error(`[GScore] 自动重连次数已达上限（${maxAttempts})，停止重连。请检查配置或手动重试。`);
      }
      this.isManualRetry = false;
      return;
    }

    // 使用配置的重连间隔，如果没配置则默认 5000ms
    const interval = pluginState.config.reconnectInterval ?? 5000;

    const attemptInfo = maxAttempts > 0 ? `${this.reconnectAttempts + 1}/${maxAttempts}` : `${this.reconnectAttempts + 1}/∞`;
    pluginState.logger.info(`[GScore] ${interval / 1000} 秒后尝试重连 (${attemptInfo})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      pluginState.logger.info(`[GScore] 开始第 ${this.reconnectAttempts} 次重连尝试...`);
      this.connect();
    }, interval);
  }

  /**
   * 将 OB11 消息转发到 GsCore
   * 按照早柚协议文档，将 OB11 消息转换为 MessageReceive 格式
   */
  public async forwardMessage(event: OB11Message) {
    if (this.getStatus() !== 'connected') return;

    // 仅转发群消息和私聊消息
    if (event.message_type !== 'group' && event.message_type !== 'private') return;

    try {
      // 将 OB11 message 段转换为 GsCore 的 Message[] (content)
      const content = await this.convertOB11ToGsCoreContent(event);

      // 解析额外引用/转发内嵌的图片
      if (Array.isArray(event.message)) {
        const extraImages = await this.extractExtraImages(pluginState.ctx, event.message, 0, 2);
        for (const url of extraImages) {
          content.push({ type: 'image', data: url });
          pluginState.logger.debug(`[GScore] 已提取额外(引用/转发)消息中的图片: ${url}`);
        }
      }

      // 确定 user_type
      const userType = event.message_type === 'group' ? 'group' : 'direct';

      // 确定 user_pm（用户权限）
      let userPm = 6; // 默认普通用户
      const sender = event.sender as Record<string, unknown> | undefined;
      if (sender) {
        if (sender.role === 'owner') userPm = 2;
        else if (sender.role === 'admin') userPm = 3;
      }

      // 构造 GsCore MessageReceive 结构
      const messageReceive = {
        bot_id: 'onebot',
        bot_self_id: String(pluginState.selfId || event.self_id || ''),
        msg_id: String(event.message_id || ''),
        user_type: userType,
        group_id: event.group_id ? String(event.group_id) : null,
        user_id: String(event.user_id),
        sender: sender ? {
          ...sender,
          user_id: sender.user_id ? String(sender.user_id) : String(event.user_id),
          nickname: sender.nickname || sender.card || '',
          avatar: `https://q1.qlogo.cn/g?b=qq&nk=${sender.user_id || event.user_id}&s=640`
        } : {
          user_id: String(event.user_id),
          nickname: '',
          avatar: `https://q1.qlogo.cn/g?b=qq&nk=${event.user_id}&s=640`
        },
        user_pm: userPm,
        content: content,
      };

      const payload = JSON.stringify(messageReceive);
      // GsCore 使用 receive_bytes()，需要发送二进制帧
      this.ws?.send(Buffer.from(payload));
      pluginState.logger.debug(`[GScore] 已转发${userType === 'group' ? '群' : '私聊'} ${event.group_id || event.user_id} 消息`);
    } catch (error) {
      pluginState.logger.error('[GScore] 发送消息失败:', error);
    }
  }

  /**
   * 递归提取消息段中的图片
   * 支持解析引用（reply）和转发（forward/node），最多解析 maxDepth 层
   */
  private async extractExtraImages(ctx: NapCatPluginContext, segments: any[], currentDepth: number, maxDepth: number): Promise<string[]> {
    if (currentDepth > maxDepth) return [];
    const imageUrls: Set<string> = new Set();

    for (const seg of segments) {
      // 0 层级的普通图片已经在 convertOB11ToGsCoreContent 处理过了，所以此处限制 currentDepth > 0
      if (currentDepth > 0 && seg.type === 'image') {
        const url = seg.data?.url || seg.data?.file;
        if (typeof url === 'string' && url.trim()) {
          imageUrls.add(url.trim());
        }
      } else if (seg.type === 'reply') {
        const replyId = seg.data?.id;
        if (replyId) {
          try {
            const replyMsg = await ctx.actions.call('get_msg', { message_id: replyId }, ctx.adapterName, ctx.pluginManager.config) as OB11Message;
            if (replyMsg && Array.isArray(replyMsg.message)) {
              const nestedImages = await this.extractExtraImages(ctx, replyMsg.message, currentDepth + 1, maxDepth);
              nestedImages.forEach(u => imageUrls.add(u));
            }
          } catch (err) {
            pluginState.logger.warn(`[GScore] 获取引用消息失败: ${err}`);
          }
        }
      } else if (seg.type === 'forward' || seg.type === 'node') {
        const data = seg.data as any;
        // 已有直接 content 信息的合并转发片段
        if (Array.isArray(data?.content) && data.content.length > 0) {
          for (const sub of data.content) {
            let subSegments: any[] = [];
            if (Array.isArray(sub.message)) {
              subSegments = sub.message;
            } else if (Array.isArray(sub.content)) {
              subSegments = sub.content;
            } else if (sub.type) {
              subSegments = [sub];
            }
            if (subSegments.length > 0) {
              const nestedImages = await this.extractExtraImages(ctx, subSegments, currentDepth + 1, maxDepth);
              nestedImages.forEach(u => imageUrls.add(u));
            }
          }
        } else if (data?.id) {
          // 需要通过接口获取详情的合并转发信息
          try {
            const forwardMsg = await ctx.actions.call('get_forward_msg', { message_id: data.id }, ctx.adapterName, ctx.pluginManager.config) as any;
            let msgList: any[] = [];
            if (Array.isArray(forwardMsg)) {
              msgList = forwardMsg;
            } else if (forwardMsg && Array.isArray(forwardMsg.messages)) {
              msgList = forwardMsg.messages;
            } else if (forwardMsg && Array.isArray(forwardMsg.data)) {
              msgList = forwardMsg.data;
            }
            
            for (const m of msgList) {
              let subSegments: any[] = [];
              if (Array.isArray(m.message)) subSegments = m.message;
              else if (Array.isArray(m.content)) subSegments = m.content;
              else if (m.type) subSegments = [m];

              if (subSegments.length > 0) {
                const nestedImages = await this.extractExtraImages(ctx, subSegments, currentDepth + 1, maxDepth);
                nestedImages.forEach(u => imageUrls.add(u));
              }
            }
          } catch (err) {
            pluginState.logger.warn(`[GScore] 获取转发消息失败: ${err}`);
          }
        }
      }
    }
    return Array.from(imageUrls);
  }

  /**
   * 将 OB11 消息段数组转换为 GsCore 的 Message[] 格式
   */
  private async convertOB11ToGsCoreContent(event: OB11Message): Promise<Array<{ type: string; data: unknown }>> {
    const content: Array<{ type: string; data: unknown }> = [];
    const message = event.message;

    if (!message || !Array.isArray(message)) {
      if (event.raw_message) {
        content.push({ type: 'text', data: event.raw_message });
      }
      return content;
    }

    for (const seg of message) {
      const segData = seg.data as Record<string, unknown> | undefined;
      switch (seg.type) {
        case 'text':
          content.push({ type: 'text', data: segData?.text || '' });
          break;
        case 'image':
          content.push({ type: 'image', data: segData?.url || segData?.file || '' });
          break;
        case 'at':
          content.push({ type: 'at', data: String(segData?.qq || '') });
          break;
        case 'reply':
          content.push({ type: 'reply', data: String(segData?.id || '') });
          break;
        case 'face':
          content.push({ type: 'text', data: `[表情:${segData?.id || ''}]` });
          break;
        case 'record':
          content.push({ type: 'record', data: segData?.url || segData?.file || '' });
          break;
        case 'file':
          if (event.message_type === 'private') {
            if (!pluginState.config.privateFileForwardEnabled) {
              pluginState.logger.debug('[GScore] 私聊文件转发开关关闭，已跳过 file 段');
              break;
            }

            try {
              const ctx = pluginState.ctx;
              const fileIdRaw = segData?.file_id ?? segData?.fid ?? segData?.file;
              const fileId = String(fileIdRaw || '').trim();

              if (!fileId) {
                pluginState.logger.warn('[GScore] 私聊 file 段缺少 file_id，无法获取链接，已跳过');
                break;
              }

              const resp = await ctx.actions.call(
                'get_private_file_url',
                {
                  user_id: String(event.user_id || ''),
                  file_id: fileId,
                },
                ctx.adapterName,
                ctx.pluginManager.config
              ) as { url?: string };

              const fileUrl = typeof resp?.url === 'string' ? resp.url.trim() : '';
              if (!fileUrl) {
                pluginState.logger.warn('[GScore] get_private_file_url 未返回有效 url，已跳过私聊 file 段');
                break;
              }

              const fileName = String(segData?.file || 'file').trim() || 'file';
              const isJsonFile = fileName.toLowerCase().endsWith('.json');
              if (isJsonFile) {
                try {
                  const maxKbRaw = pluginState.config.privateJsonBase64MaxKb;
                  const maxKb = typeof maxKbRaw === 'number' && Number.isFinite(maxKbRaw) && maxKbRaw > 0 ? maxKbRaw : 1024;
                  const maxBytes = Math.floor(maxKb * 1024);

                  const response = await fetch(fileUrl);
                  if (!response.ok) {
                    pluginState.logger.warn(`[GScore] 下载私聊 JSON 文件失败: status=${response.status}，已跳过 file 段`);
                    break;
                  }

                  const buffer = Buffer.from(await response.arrayBuffer());
                  const fileSize = buffer.byteLength;

                  if (fileSize > maxBytes) {
                    pluginState.logger.warn(`[GScore] 私聊 JSON 文件过大(${fileSize} bytes > ${maxBytes} bytes)，已跳过 file 段`);
                    await ctx.actions.call(
                      'send_msg',
                      {
                        message_type: 'private',
                        user_id: String(event.user_id || ''),
                        message: `⚠️ JSON 过大（${(fileSize / 1024).toFixed(1)}KB），超过限制 ${maxKb}KB，已跳过转发`
                      },
                      ctx.adapterName,
                      ctx.pluginManager.config
                    );
                    break;
                  }

                  const fileBase64Raw = buffer.toString('base64');
                  content.push({ type: 'file', data: `${fileName}|${fileBase64Raw}` });
                } catch (error) {
                  pluginState.logger.warn('[GScore] 处理私聊 JSON 文件失败，已跳过 file 段:', error);
                }
              } else {
                content.push({ type: 'file', data: `${fileName}|${fileUrl}` });
              }
            } catch (error) {
              pluginState.logger.warn('[GScore] 获取私聊文件链接失败，已跳过 file 段:', error);
            }
          } else {
            content.push({ type: 'file', data: `${segData?.file || 'file'}|${segData?.url || ''}` });
          }
          break;
        default:
          if (segData?.text) {
            content.push({ type: 'text', data: segData.text });
          }
          break;
      }
    }

    return content;
  }

  // ==================== GsCore 消息接收处理 ====================

  /**
   * 处理 GsCore 发回的 MessageSend 消息
   * 将其转换为 OB11 格式并通过 NapCat API 发送到 QQ
   */
  private async handleGsCoreMessage(msgSend: GsCoreMessageSend) {
    const { target_type, target_id, content } = msgSend;

    if (!content || content.length === 0) {
      pluginState.logger.debug('[GScore] 收到空消息，忽略');
      return;
    }

    // 检查是否为 log 类型消息（仅输出日志不发送）
    const firstMsg = content[0];
    if (firstMsg.type && firstMsg.type.startsWith('log_')) {
      const level = firstMsg.type.replace('log_', '').toLowerCase();
      const logData = String(firstMsg.data || '');
      switch (level) {
        case 'info':
          pluginState.logger.info(`[GScore Log] ${logData}`);
          break;
        case 'warning':
          pluginState.logger.warn(`[GScore Log] ${logData}`);
          break;
        case 'error':
          pluginState.logger.error(`[GScore Log] ${logData}`);
          break;
        case 'success':
          pluginState.logger.info(`[GScore Log] ✅ ${logData}`);
          break;
        default:
          pluginState.logger.debug(`[GScore Log] [${level}] ${logData}`);
      }
      return;
    }

    if (!target_id) {
      pluginState.logger.warn('[GScore] 收到消息但没有 target_id，无法发送');
      return;
    }

    try {
      // 将 GsCore Message[] 转换为 OB11 消息段
      const ob11Message = this.convertGsCoreToOB11(content);

      if (ob11Message.length === 0) {
        pluginState.logger.debug('[GScore] 转换后消息为空，忽略');
        return;
      }

      const ctx = pluginState.ctx;

      // 根据 target_type 决定发送目标
      if (target_type === 'direct') {
        // 私聊消息
        const params: OB11PostSendMsg = {
          message: ob11Message as OB11PostSendMsg['message'],
          message_type: 'private',
          user_id: target_id,
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        pluginState.logger.debug(`[GScore] 已发送私聊消息到 ${target_id}`);
      } else {
        // 群消息（group/channel/sub_channel 都走群发送）
        const params: OB11PostSendMsg = {
          message: ob11Message as OB11PostSendMsg['message'],
          message_type: 'group',
          group_id: target_id,
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        pluginState.logger.debug(`[GScore] 已发送群消息到 ${target_id}`);
      }
    } catch (error) {
      pluginState.logger.error('[GScore] 发送回复消息失败:', error);
    }
  }

  /**
   * 将 GsCore Message[] 转换为 OB11 消息段数组
   */
  private convertGsCoreToOB11(content: GsCoreMessage[]): Array<{ type: string; data: Record<string, unknown> }> {
    const result: Array<{ type: string; data: Record<string, unknown> }> = [];

    for (const msg of content) {
      if (!msg.type || msg.data === null || msg.data === undefined) continue;

      switch (msg.type) {
        case 'text':
          result.push({ type: 'text', data: { text: String(msg.data) } });
          break;

        case 'image': {
          const imgData = String(msg.data);
          const customSummary = pluginState.config.customImageSummary;
          let summary = '[图片]'; // 默认值

          if (customSummary && customSummary.trim().length > 0) {
            const summaries = customSummary.split(',').map(s => s.trim()).filter(s => s.length > 0);
            if (summaries.length > 0) {
              summary = summaries[Math.floor(Math.random() * summaries.length)];
            }
          }

          const imageData: { file: string; summary?: string } = { file: '' };

          if (imgData.startsWith('base64://')) {
            imageData.file = imgData;
          } else if (imgData.startsWith('link://')) {
            imageData.file = imgData.replace('link://', '');
          } else {
            imageData.file = imgData;
          }

          if (imageData.file) {
            imageData.summary = summary;
          }

          result.push({ type: 'image', data: imageData });
          break;
        }

        case 'at':
          result.push({ type: 'at', data: { qq: String(msg.data) } });
          break;

        case 'reply':
          result.push({ type: 'reply', data: { id: String(msg.data) } });
          break;

        case 'record': {
          const recData = String(msg.data);
          result.push({ type: 'record', data: { file: recData } });
          break;
        }

        case 'file': {
          const fileStr = String(msg.data);
          const sepIdx = fileStr.indexOf('|');
          if (sepIdx > 0) {
            const fileName = fileStr.substring(0, sepIdx).trim() || 'file';
            const fileContentRaw = fileStr.substring(sepIdx + 1).trim();

            let fileData = '';
            if (fileContentRaw.startsWith('base64://')) {
              fileData = fileContentRaw;
            } else if (fileContentRaw.length > 0) {
              fileData = `base64://${fileContentRaw}`;
            }

            if (fileData) {
              result.push({ type: 'file', data: { file: fileData, name: fileName } });
            }
          }
          break;
        }

        case 'markdown':
          result.push({ type: 'text', data: { text: String(msg.data) } });
          break;

        case 'node': {
          if (Array.isArray(msg.data)) {
            const subMessagesRaw = msg.data as GsCoreMessage[];
            for (const subMsg of subMessagesRaw) {
              const ob11Segments = this.convertGsCoreToOB11([subMsg]);

              if (ob11Segments.length > 0) {
                let userId = `3889929917`;
                let nickname = `🦊小助手`;
                
                if (pluginState.config.customForwardInfo) {
                  const customQQ = pluginState.config.customForwardQQ;
                  const customName = pluginState.config.customForwardName;
                  
                  if (customQQ && customQQ.trim()) {
                    userId = customQQ.trim();
                  } else {
                    userId = String(pluginState.selfId || '3889929917');
                  }
                  
                  if (customName && customName.trim()) {
                    nickname = customName.trim();
                  } else {
                    nickname = String(pluginState.selfNickname || '🦊小助手');
                  }
                }

                result.push({
                  type: 'node',
                  data: {
                    user_id: userId,
                    nickname: nickname,
                    content: ob11Segments
                  }
                });
              }
            }
          }
          break;
        }

        case 'image_size':
        case 'buttons':
        case 'template_buttons':
        case 'template_markdown':
        case 'group':
          break;

        default:
          if (msg.data && typeof msg.data === 'string' && msg.data.length > 0) {
            result.push({ type: 'text', data: { text: msg.data } });
          }
          break;
      }
    }

    return result;
  }
}
