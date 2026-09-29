import type { CatalogSnapshot } from "./catalog.ts";
import { CREDENTIAL_TEXT, type CredentialCode, type PublicCredential } from "./credential.ts";
import { appFrame, escapeHtml } from "./html.ts";

export interface CredentialDraft {
  platform: string;
  authKind: string;
  partition: string;
  displayName: string;
  accountHint: string;
  roleArn: string;
  accessKeyId: string;
  clientId: string;
  tenantId: string;
  subscriptionId: string;
}

export function credentialsPage(
  viewer: { username: string; role: string; csrf: string },
  catalog: CatalogSnapshot,
  rows: PublicCredential[],
  error: string,
  saved: boolean,
  draft: CredentialDraft,
): string {
  const admin = viewer.role === "admin";
  const message = error ? CREDENTIAL_TEXT[error as CredentialCode] ?? error : "";
  const banner = message ? `<p class="banner" role="alert">${escapeHtml(message)}</p>` : "";
  const savedNote = saved ? `<p class="lead">已加密保存。密钥不会再显示。</p>` : "";
  const form = admin ? credentialForm(viewer.csrf, draft) : `<p class="lead">当前角色只能查看账号提示，不能写入密钥。</p>`;
  return appFrame({
    username: viewer.username,
    role: viewer.role,
    csrf: viewer.csrf,
    active: "/credentials",
    main: `<section>
<h1>鉴权</h1>
<p class="lead">密钥用本机主密钥做 AES-256-GCM 信封加密后写入数据库。执行进程以后按云读取：AWS 静态密钥注入访问密钥，担任角色只注入临时凭证；Azure 注入服务主体；阿里云注入 ALIBABA_CLOUD 访问密钥。Terraform 文件里不写密钥。这一页不执行命令，也不调用云 API。</p>
${banner}${savedNote}${form}
<section class="block"><h2>已保存</h2>
${credentialTable(catalog, rows, admin)}
</section>
</section>`,
  });
}

function credentialForm(csrf: string, draft: CredentialDraft): string {
  const platform = draft.platform || "aws";
  const kind = draft.authKind || "static_key";
  const option = (value: string, label: string, current: string) =>
    `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`;
  return `<form class="panel cred" method="post" action="/credentials" autocomplete="off">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<h2>保存鉴权</h2>
<p class="lead">密钥只写这一次。静态密钥会长期交给以后的执行进程，页面上会标出来。没有“显示密钥”。</p>
<div class="fields">
<label>云平台<select name="platform">
${option("aws", "AWS", platform)}
${option("azure", "Azure", platform)}
${option("aliyun", "阿里云", platform)}
</select></label>
<label>方式<select name="auth_kind">
${option("static_key", "静态密钥", kind)}
${option("assume_role", "担任角色", kind)}
${option("service_principal", "服务主体", kind)}
</select></label>
<label>名称<input name="display_name" maxlength="40" placeholder="例如 sandbox" value="${escapeHtml(draft.displayName)}" autocomplete="off"></label>
<label data-show="aws aliyun">账号<input name="account_hint" maxlength="64" placeholder="AWS 为 12 位账号，阿里云为账号 ID" value="${escapeHtml(draft.accountHint)}" autocomplete="off"></label>
<label data-show="aliyun">站点<select name="partition">
<option value="">选择站点</option>
${option("cn", "国内站", draft.partition)}
${option("intl", "国际站", draft.partition)}
</select></label>
<label data-show="aws aliyun">Access Key ID<input name="access_key_id" maxlength="128" value="${escapeHtml(draft.accessKeyId)}" autocomplete="off" spellcheck="false"></label>
<label data-show="aws:static_key aws:assume_role">Secret Access Key<input name="secret_access_key" type="password" maxlength="256" autocomplete="new-password"></label>
<label data-show="aliyun:static_key">Access Key Secret<input name="access_key_secret" type="password" maxlength="256" autocomplete="new-password"></label>
<label data-show="aws:assume_role">角色 ARN<input name="role_arn" maxlength="2048" placeholder="arn:aws:iam::123456789012:role/novtf" value="${escapeHtml(draft.roleArn)}" autocomplete="off" spellcheck="false"></label>
<label data-show="aws:assume_role">External ID<input name="external_id" type="password" maxlength="256" autocomplete="new-password" placeholder="可空"></label>
<label data-show="azure:service_principal">应用程序 ID<input name="client_id" maxlength="64" value="${escapeHtml(draft.clientId)}" autocomplete="off" spellcheck="false"></label>
<label data-show="azure:service_principal">租户 ID<input name="tenant_id" maxlength="64" value="${escapeHtml(draft.tenantId)}" autocomplete="off" spellcheck="false"></label>
<label data-show="azure:service_principal">订阅 ID<input name="subscription_id" maxlength="64" value="${escapeHtml(draft.subscriptionId)}" autocomplete="off" spellcheck="false"></label>
<label data-show="azure:service_principal">客户端密钥<input name="client_secret" type="password" maxlength="256" autocomplete="new-password"></label>
</div>
<button class="primary" type="submit">保存鉴权</button>
</form>
<script>
const form = document.querySelector("form.cred");
const platform = form.querySelector("[name=platform]");
const kind = form.querySelector("[name=auth_kind]");
const kinds = {
  aws: [["static_key", "静态密钥"], ["assume_role", "担任角色"]],
  azure: [["service_principal", "服务主体"]],
  aliyun: [["static_key", "静态密钥"]]
};
const sync = () => {
  const allowed = kinds[platform.value] || kinds.aws;
  const current = kind.value;
  kind.replaceChildren();
  for (const [value, label] of allowed) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (value === current) option.selected = true;
    kind.appendChild(option);
  }
  if (kind.selectedIndex < 0) kind.selectedIndex = 0;
  form.querySelectorAll("[data-show]").forEach((block) => {
    const tokens = block.dataset.show.split(/\\s+/);
    const visible = tokens.includes(platform.value) || tokens.includes(platform.value + ":" + kind.value);
    block.classList.toggle("is-off", !visible);
    block.querySelectorAll("input, select, textarea").forEach((input) => { input.disabled = !visible; });
  });
};
platform.addEventListener("change", sync);
kind.addEventListener("change", sync);
sync();
</script>`;
}

function credentialTable(catalog: CatalogSnapshot, rows: PublicCredential[], admin: boolean): string {
  if (rows.length === 0) return `<p class="empty-note">还没有鉴权信息</p>`;
  const body = rows
    .map((row) => {
      const label = catalog.platforms.find((platform) => platform.id === row.platform)?.label ?? row.platform;
      if (!admin) return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(row.accountHint)}</td></tr>`;
      const kind = row.authKind === "assume_role" ? "担任角色" : row.authKind === "service_principal" ? "服务主体" : "静态密钥";
      const site = row.partition === "cn" ? "国内站" : row.partition === "intl" ? "国际站" : "";
      const warning = row.warning === "static_key" ? `<p class="note-warn">静态密钥长期有效，执行进程会直接使用它。</p>` : "";
      return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(row.displayName)}</td><td>${kind}</td><td>${site}</td><td>${escapeHtml(row.accountHint)}</td><td>${escapeHtml(row.fingerprint)}</td><td>${warning}</td></tr>`;
    })
    .join("");
  const headers = admin ? ["云平台", "名称", "方式", "站点", "账号", "指纹", ""] : ["云平台", "账号"];
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}
