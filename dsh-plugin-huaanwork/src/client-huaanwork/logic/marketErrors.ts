/**
 * 市场错误分类与诚实文案（M5 Task 6 Step 3/4，P2④ + round3 R23）。
 *
 * 三类可区分错误态，各自对应固定文案与是否可旁路：
 * ① 内网不可达/宕机 —— 提示本地安装旁路（canBypass = true）；
 * ② 目录签名验签失败 —— fail-closed，无旁路；
 * ③ 制品 sha256 不符 —— fail-closed，无旁路。
 *
 * R23 收窄：验签/sha 失败**远程流程内绝不提供「仍要安装」绕过**；本地安装 tab
 * 是用户自主路径（Task 7 落地），文案仅指路，不由本模块提供绕过按钮。
 */

/** 分类后的错误种类。 */
export type MarketErrorKind = "unreachable" | "verification" | "sha256" | "install-gate" | "busy" | "unknown";

/** 错误展示：标题 + 正文 + 是否可经本地安装旁路。 */
export interface MarketErrorPresentation {
  readonly kind: MarketErrorKind;
  readonly title: string;
  readonly body: string;
  readonly canBypass: boolean;
}

const UNREACHABLE_PRESENTATION: MarketErrorPresentation = {
  kind: "unreachable",
  title: "内网市场不可达",
  body: "无法连接内网市场服务（宕机或网络不可达）。可稍后重试，或改用本地安装：在「来源」页查看当前源地址，确认内网连通后再回到本页。",
  canBypass: true,
};

const VERIFICATION_PRESENTATION: MarketErrorPresentation = {
  kind: "verification",
  title: "目录签名校验失败",
  body: "目录签名校验失败，已拒绝；请联系市场管理员或检查信任锚。",
  canBypass: false,
};

const SHA256_PRESENTATION: MarketErrorPresentation = {
  kind: "sha256",
  title: "插件文件校验失败",
  body: "插件文件校验失败，已拒绝安装。",
  canBypass: false,
};

const INSTALL_GATE_PRESENTATION: MarketErrorPresentation = {
  kind: "install-gate",
  title: "插件未通过安装预检",
  body: "插件不满足市场安装约束（零依赖、无安装脚本），已拒绝安装。",
  canBypass: false,
};

const BUSY_PRESENTATION: MarketErrorPresentation = {
  kind: "busy",
  title: "已有安装在进行",
  body: "另一个市场安装正在进行，请等待其完成后再试。",
  canBypass: false,
};

const UNKNOWN_PRESENTATION: MarketErrorPresentation = {
  kind: "unknown",
  title: "市场操作失败",
  body: "操作失败，请稍后重试或联系市场管理员。",
  canBypass: false,
};

/** wrapper routes 错误码 → 分类。未知码回落 unknown（展示时附原始信息）。 */
export function classifyMarketError(code: string | undefined): MarketErrorKind {
  switch (code) {
    case "market-unreachable":
    case "market-config":
      return "unreachable";
    case "market-verification-failed":
    case "market-verification-unavailable":
      return "verification";
    case "market-sha256-mismatch":
      return "sha256";
    case "market-artifact-origin":
    case "market-install-gate":
    case "market-invalid-tarball":
    case "market-artifact-io":
    case "market-artifact-url":
      return "install-gate";
    case "market-execute-busy":
      return "busy";
    default:
      return "unknown";
  }
}

/** 分类 → 展示文案。fail-closed 类（verification/sha256/install-gate）恒 canBypass = false。 */
export function marketErrorPresentation(kind: MarketErrorKind): MarketErrorPresentation {
  switch (kind) {
    case "unreachable":
      return UNREACHABLE_PRESENTATION;
    case "verification":
      return VERIFICATION_PRESENTATION;
    case "sha256":
      return SHA256_PRESENTATION;
    case "install-gate":
      return INSTALL_GATE_PRESENTATION;
    case "busy":
      return BUSY_PRESENTATION;
    default:
      return UNKNOWN_PRESENTATION;
  }
}

/** 从（可能带 .code 的）Error 值一步得到展示形态。 */
export function presentMarketError(error: unknown): MarketErrorPresentation {
  const code =
    error instanceof Error && typeof (error as { code?: unknown }).code === "string"
      ? (error as unknown as { code: string }).code
      : undefined;
  return marketErrorPresentation(classifyMarketError(code));
}
