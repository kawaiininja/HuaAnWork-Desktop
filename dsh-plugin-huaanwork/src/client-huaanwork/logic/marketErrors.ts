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
 * 修复轮 N-1：该态文案**不得指向本界面不存在的路径**。provider 选择器住在
 * `client/DesktopSettingsSection.tsx`（经 `settings.section` slot 注入），而默认
 * advanced shell 下 `client-huaanwork/` 独占 layout、对该 slot 零消费（实测
 * grep 无命中）⇒「设置 → 桌面 → 插件市场」在华安工作台界面不可达。文案改为
 * 陈述真实缺口 + 给出可达动作（联系部署方），入口本身登记为技术债（AGENTS.md
 * 「市场来源选择入口未接入华安工作台界面」行）。
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
  // N-1：不写「设置 → 桌面 → 插件市场」这类本界面走不通的路径（见文件头）。
  body: "当前市场来源为「禁用」，市场路由未注册，目录与安装均不可用。启用需在桌面设置的「插件市场」中选择「华安内网市场」（huaanwork-market）；华安工作台界面尚未接入该设置项，请联系部署方启用。",
  canBypass: false,
};

const UNKNOWN_PRESENTATION: MarketErrorPresentation = {
  kind: "unknown",
  title: "市场操作失败",
  body: "操作失败，请稍后重试或联系市场管理员。",
  canBypass: false,
};

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
  const message = error instanceof Error ? error.message.trim() : "";
  if (message === "") return UNKNOWN_PRESENTATION;
  return { ...UNKNOWN_PRESENTATION, body: `${UNKNOWN_PRESENTATION.body}（${message}）` };
}
