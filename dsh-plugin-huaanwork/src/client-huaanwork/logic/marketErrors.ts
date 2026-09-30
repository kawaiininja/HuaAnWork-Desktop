/**
 * 市场错误分类与诚实文案（M5 Task 6 Step 3/4，P2④ + round3 R23）。
 *
 * 三类可区分错误态，各自对应固定文案与是否可旁路：
 * ① 内网不可达/宕机 —— 提示本地安装旁路（canBypass = true）；
 * ② 目录签名验签失败 —— fail-closed，无旁路；
 * ③ 制品 sha256 不符 —— fail-closed，无旁路。
 *
 * R23 收窄：验签/sha 失败**远程流程内绝不提供「仍要安装」绕过**；本地安装 tab
 * 是用户自主路径（Task 7 已并入 MarketView「本地安装」页签），unreachable 文案指路该页签。
 *
 * 评审 D10：provider 未启用（出厂默认 disabled ⇒ wrapper bundle 未加载 ⇒
 * market routes 未注册）时 webserver 对 `/api/huaanwork-market/*` 统一答
 * 404 `not-found`（或 frontend-static fallback 的无 code 404/405）——归为
 * not-registered 态，而非落进 unknown 的通用文案。
 *
 * M6 Task 5.1（债务 N-1 摘除）：来源选择入口已接入 `client-huaanwork/`
 * （MarketView「来源」页签内的 provider 开关，读/写走 M5 既有 desktop settings
 * route）。故该态文案不再声称「本界面无法切换」，改为指向本界面真实可达的
 * 「来源」页签与 provider 值；来源地址仍由部署方配置（spec §7.3），文案如实
 * 保留部署方口径。
 *
 * 评审 D12：unknown 不再丢弃诊断信息——服务端原始 message 附进正文；
 * `pnpm-busy`（plugins-host 的 asPnpmBusy 映射）走 busy 文案。
 */

/** 分类后的错误种类。 */
export type MarketErrorKind =
  | "unreachable"
  | "verification"
  | "sha256"
  | "install-gate"
  | "busy"
  | "not-registered"
  | "unknown";

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
  body: "无法连接内网市场服务（宕机或网络不可达），远程安装暂不可用。可稍后重试，或切换到「本地安装」页签安装本地目录或 .tgz 插件（不经签名与 sha256 校验，风险披露见该页确认框）。",
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

const NOT_REGISTERED_PRESENTATION: MarketErrorPresentation = {
  kind: "not-registered",
  title: "插件市场未启用",
  // M6 Task 5.1：入口已落地（「来源」页签内的 provider 开关），文案指向真实路径；
  // 不得再声称「尚未接入」，也不得给出本界面走不通的箭头导航（承 N-1 回归门）。
  body: "当前市场来源为「禁用」，市场路由未注册，目录与安装均不可用。可在本页「来源」页签选择「华安内网市场」（huaanwork-market），确认并重启应用后启用；来源地址由部署方配置。",
  canBypass: false,
};

const UNKNOWN_PRESENTATION: MarketErrorPresentation = {
  kind: "unknown",
  title: "市场操作失败",
  body: "操作失败，请稍后重试或联系市场管理员。",
  canBypass: false,
};

/** unknown 态透出到 UI 的服务端原文上限（修复轮 N-6，纵深：见 presentMarketError）。 */
const UNKNOWN_DETAIL_MAX_CHARS = 200;

/**
 * wrapper routes 错误码 → 分类。未知码回落 unknown（展示时附原始信息）。
 *
 * `status` 为 marketFetch 记录的 HTTP 状态：无 code（非 JSON 应答）但 404/405
 * 同样视为市场路由未注册（D10）。
 */
export function classifyMarketError(code: string | undefined, status?: number): MarketErrorKind {
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
    case "pnpm-busy":
      return "busy";
    case "not-found":
      // webserver 对未注册路由的统一应答（market routes 全部表外注册，未加载
      // wrapper bundle 时 `/api/huaanwork-market/*` 全部落到这里）。
      return "not-registered";
    default:
      if (code === undefined && (status === 404 || status === 405)) return "not-registered";
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
    case "not-registered":
      return NOT_REGISTERED_PRESENTATION;
    default:
      return UNKNOWN_PRESENTATION;
  }
}

/** 从（可能带 .code / .status 的）Error 值一步得到展示形态。 */
export function presentMarketError(error: unknown): MarketErrorPresentation {
  const code =
    error instanceof Error && typeof (error as { code?: unknown }).code === "string"
      ? (error as unknown as { code: string }).code
      : undefined;
  const status =
    error instanceof Error && typeof (error as { status?: unknown }).status === "number"
      ? (error as unknown as { status: number }).status
      : undefined;
  const kind = classifyMarketError(code, status);
  if (kind !== "unknown") return marketErrorPresentation(kind);
  // unknown：附服务端原始信息（D12）——plugin-error 500 / pnpm-unavailable 503 /
  // market-package-not-found 404 等最常真实发生的失败全部落进此类，排障线索不得归零。
  // 截断（修复轮 N-6）：服务端 message 由 routes.ts 的具名错误类提供、已不含路径，
  // 但本函数无法约束未来的错误来源，故对透出到 UI 的原文设上限作纵深。
  const raw = error instanceof Error ? error.message.trim() : "";
  if (raw === "") return UNKNOWN_PRESENTATION;
  const message = raw.length > UNKNOWN_DETAIL_MAX_CHARS ? `${raw.slice(0, UNKNOWN_DETAIL_MAX_CHARS)}…` : raw;
  return { ...UNKNOWN_PRESENTATION, body: `${UNKNOWN_PRESENTATION.body}（${message}）` };
}
