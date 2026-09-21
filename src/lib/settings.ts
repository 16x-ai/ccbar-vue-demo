/**
 * 页面设置：读 / 校验 / 写回 localStorage。
 *
 * 只做「数据」这一件事，不碰 SDK，也不碰界面。页面上点「保存」时才写盘，
 * 所以设置框里改坏了、点取消，都不会影响下次打开页面。
 */

import { migrateApiHost, validateApiHost, validateSipWs } from "./helpers";

export type PhoneConfig = {
  /** 接口网关地址，例如 https://call-ng.innopaas.com（不带尾巴斜杠） */
  host: string;
  /** 服务端签名凭据：只出现在设置框和请求体里，不进日志 */
  appKey: string;
  appSecret: string;
  /** 坐席分机号，例如 8001 */
  extension: string;
  /** 软电话 WSS 覆盖项，留空＝用会话里给的地址 */
  sipWs: string;
  /** SIP 注册有效期（秒），会交给服务端写进会话 */
  registerExpires: number | string;
};

export const SETTINGS_KEY = "ccbar.vueDemo.settings";
export const REGISTER_EXPIRES_DEFAULT = 600;
const REGISTER_EXPIRES_MIN = 10;
const REGISTER_EXPIRES_MAX = 3600;

// 每个客户/环境的接口网关都不一样，所以代码里没有写死的默认值。
// 交付时可以按客户注入：VITE_API_HOST=https://客户的网关 npm run build
function defaultApiHost(): string {
  return String(import.meta.env?.VITE_API_HOST || "").trim();
}

/**
 * 页面启动时调用一次：已保存的值优先，没有就用构建时注入的默认值。
 */
export function createConfig(): PhoneConfig {
  const saved = readSaved();
  return {
    host: migrateApiHost(saved.host || defaultApiHost()),
    appKey: saved.appKey || "",
    appSecret: saved.appSecret || "",
    extension: saved.extension || "1000",
    sipWs: saved.sipWs || "",
    registerExpires: saved.registerExpires ?? REGISTER_EXPIRES_DEFAULT,
  };
}

/**
 * 校验设置并返回规整后的副本（去空格、补协议…）。
 * 任何一项不合格就抛错，错误文案会显示在页面上的红色提示行里。
 */
export function normalizeConfig(config: PhoneConfig): PhoneConfig {
  const host = validateApiHost(config.host);
  if (!config.appKey.trim() || !config.appSecret.trim()) {
    throw new Error("API KEY、API SECRET 均不能为空");
  }

  const rawExpires = String(config.registerExpires ?? "").trim();
  const expires = rawExpires ? Number(rawExpires) : REGISTER_EXPIRES_DEFAULT;
  if (!Number.isInteger(expires) || expires < REGISTER_EXPIRES_MIN || expires > REGISTER_EXPIRES_MAX) {
    throw new Error(
      `SIP 注册有效期须为 ${REGISTER_EXPIRES_MIN}–${REGISTER_EXPIRES_MAX} 的整数，` +
        `或留空使用默认 ${REGISTER_EXPIRES_DEFAULT} 秒`,
    );
  }

  return {
    host,
    appKey: config.appKey.trim(),
    appSecret: config.appSecret.trim(),
    extension: config.extension.trim() || "1000",
    // 必填：validateSipWs 对空值也会报错
    sipWs: validateSipWs(config.sipWs),
    registerExpires: expires,
  };
}

export function persistConfig(config: PhoneConfig): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(config));
  } catch {
    /* 隐私模式下写不了 localStorage：本次会话照常可用，只是下次要重填 */
  }
}

type SavedConfig = Partial<PhoneConfig>;

function readSaved(): SavedConfig {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as SavedConfig) : {};
  } catch {
    return {};
  }
}
