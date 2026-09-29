import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import {
  authorizeRun,
  bootstrapAdmin,
  clearCookieHeader,
  cookieHeader,
  createUser,
  grantPlatform,
  hasPlatformGrant,
  isRole,
  login,
  logout,
  readSession,
  type SessionUser,
} from "./auth.ts";
import { admit, placeText, storedServiceCount, type CatalogSnapshot, type NormalizedSelection } from "./catalog.ts";
import { addPlatform, addRegion, addService, loadCatalog, saveServiceConfig } from "./catalog-store.ts";
import { highlightJson } from "./highlight.ts";
import { renderTerraform } from "./render.ts";
import { composeForm } from "./compose-form.ts";
import { credentialsPage, type CredentialDraft } from "./credential-page.ts";
import {
  CREDENTIAL_TEXT,
  credentialChoices,
  credentialPlatform,
  listCredentials,
  saveCredential,
  type CredentialRequest,
} from "./credential.ts";
import { withImmediate } from "./db.ts";
import { appFrame, escapeHtml, renderPage } from "./html.ts";
import { platformsPage, regionsPage, servicesPage } from "./manage.ts";
import { randomUUID } from "node:crypto";

const ERROR_TEXT: Record<string, string> = {
  platform_not_granted: "没有这个云平台的授权",
  platform_disabled: "这个平台或未启用的云资源不能提交",
  platform_unknown: "先新增云平台，再添加资源或区域",
  platform_exists: "这个云平台已经有了",
  service_exists: "这个云平台里已经有这个云资源",
  region_unknown: "区域不在可选列表里",
  zone_unknown: "可用区不属于所选区域",
  too_many_zones: "一次最多添加 8 个可用区",
  bad_id: "标识或显示名不符合规则",
  service_unknown: "至少选择一个云资源",
  service_requires_network: "需要网络的云资源必须选择一套已填写名称的网络",
  network_unknown: "云资源指向的网络没有名称",
  network_unused: "有网络填了名称，但没有云资源使用它",
  network_not_a_service: "网络不是一个云资源",
  duplicate_network_name: "网络名称重复或不符合小写字母开头的规则",
  too_many_networks: "一个云平台最多三套网络",
  cidr_not_slash16: "CIDR 必须是 RFC1918 里的 IPv4 /16",
  cidr_overlap: "同一个云里的网络 CIDR 重叠了",
  no_platform: "至少选择一个云平台",
  config_required: "选中的云资源要写明配置",
  config_too_long: "资源配置不能超过 500 字",
  count_invalid: "数量要是 1 到 10 的整数",
  credential_unknown: "所选鉴权不存在，或不属于这个云平台",
};
const ACTIONS = new Set(["plan", "apply", "destroy", "drift"]);

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: string, type: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": type, ...headers });
  response.end(body);
}

function formValue(body: string, key: string): string {
  const params = new URLSearchParams(body);
  return params.get(key) ?? "";
}

function visiblePlatformIds(db: DatabaseSync, user: SessionUser, catalog: CatalogSnapshot): string[] {
  const enabled = catalog.platforms.filter((platform) => platform.enabled).map((platform) => platform.id);
  if (user.role !== "operator") return enabled;
  const rows = db.prepare("SELECT platform FROM user_platform_grant WHERE user_id = ?").all(user.userId) as Array<{
    platform: string;
  }>;
  const grants = new Set(rows.map((row) => row.platform));
  return enabled.filter((platform) => grants.has(platform));
}

export function page(db: DatabaseSync, user: SessionUser, error = "", audit = ""): string {
  const platformFilter = user.role === "operator" ? " WHERE platform IN (SELECT platform FROM user_platform_grant WHERE user_id = ?)" : "";
  const args = user.role === "operator" ? [user.userId] : [];
  const runs = db
    .prepare(
      `SELECT id, stack_id, platform, phase, action, last_error FROM provider_run${platformFilter} ORDER BY created_at DESC LIMIT 50`,
    )
    .all(...args) as Array<Record<string, string | null>>;
  const records = db
    .prepare(
      `SELECT stack_id, platform, service, cloud_id, origin, status FROM service_record${platformFilter} ORDER BY recorded_at DESC LIMIT 50`,
    )
    .all(...args) as Array<Record<string, string | null>>;
  const health = db
    .prepare(
      `SELECT stack_id, platform, address, health, stale, checked_at FROM runtime_status${platformFilter} ORDER BY checked_at DESC LIMIT 50`,
    )
    .all(...args) as Array<Record<string, string | number | null>>;
  const selectionFilter =
    user.role === "operator"
      ? " WHERE stack_selection.platform IN (SELECT platform FROM user_platform_grant WHERE user_id = ?)"
      : "";
  const selections = db
    .prepare(
      `SELECT stack.id AS stack_id, stack.name AS stack_name, stack_selection.platform, stack_selection.region, stack_selection.services, stack_selection.networks, stack_selection.parameters, stack_selection.zones, stack_selection.credential_id
       FROM stack_selection JOIN stack ON stack.id = stack_selection.stack_id${selectionFilter}
       ORDER BY stack.created_at DESC LIMIT 20`,
    )
    .all(...args) as Array<Record<string, string>>;
  const catalog = loadCatalog(db);
  const draft = composeDraft(db, user);
  const choices = credentialChoices(db);
  const selectionRows = selections.map((item) => ({
    stack_id: item.stack_id,
    stack_name: item.stack_name,
    platform: platformLabel(catalog, item.platform),
    region: placeLabel(catalog, item.platform, item.region, item.zones),
    services: describeServices(catalog, item.platform, item.services),
    networks: describeNetworks(item.networks),
    configs: describeConfigs(catalog, item.platform, item.parameters),
    credential: choices.find((choice) => choice.id === item.credential_id)?.label ?? "",
  }));
  const runRows = runs.map((item) => ({ ...item, platform: platformLabel(catalog, String(item.platform ?? "")) }));
  const recordRows = records.map((item) => ({
    ...item,
    platform: platformLabel(catalog, String(item.platform ?? "")),
    service: serviceLabel(catalog, String(item.platform ?? ""), String(item.service ?? "")),
  }));
  const healthRows = health.map((item) => ({ ...item, platform: platformLabel(catalog, String(item.platform ?? "")) }));
  return appFrame({
    username: user.username,
    role: user.role,
    csrf: user.csrfSecret,
    active: "/",
    main: `<section>
<h1>编排</h1>
<p class="lead">勾选平台和云资源，写明配置、数量并指定网络。提交后先展示 Terraform 配置文件，供审计，不执行命令。</p>
${auditSection(db, user, catalog, audit)}
${composeForm(user.csrfSecret, catalog, visiblePlatformIds(db, user, catalog), ERROR_TEXT[error] ?? error, user.role !== "auditor", draft, choices)}
</section>
<section class="block">
<h2>已保存的选择</h2>
<p class="lead">这次提交记下的平台、资源配置和网络。</p>
${savedList(selectionRows)}
</section>
<section class="block">
<h2>执行队列</h2>
<p class="lead">生成配置不会进入这个队列，也不执行命令。</p>
${dataTable(["id", "stack", "平台", "动作", "阶段", "错误"], runRows, ["id", "stack_id", "platform", "action", "phase", "last_error"])}
</section>
<section class="block">
<h2>服务登记</h2>
<p class="lead">已经记下的云上资源。</p>
${dataTable(["stack", "平台", "云资源", "云上 id", "来源", "状态"], recordRows, ["stack_id", "platform", "service", "cloud_id", "origin", "status"])}
</section>
<section class="block">
<h2>运行状态</h2>
<p class="lead">资源是否健康。和执行队列是两套记录。</p>
${dataTable(["stack", "平台", "地址", "健康", "过期", "检查时间"], healthRows, ["stack_id", "platform", "address", "health", "stale", "checked_at"])}
</section>`,
  });
}

function auditSection(db: DatabaseSync, user: SessionUser, catalog: CatalogSnapshot, stackId: string): string {
  if (!stackId) return "";
  const missing = `<section class="audit block"><h2>Terraform 配置</h2><p class="lead">没有这份配置。</p></section>`;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stackId)) return missing;
  const rows = db
    .prepare(
      `SELECT stack.name AS stack_name, stack_selection.platform, stack_selection.region, stack_selection.services, stack_selection.networks, stack_selection.parameters, stack_selection.zones
       FROM stack_selection JOIN stack ON stack.id = stack_selection.stack_id
       WHERE stack.id = ? ORDER BY stack_selection.rowid`,
    )
    .all(stackId) as Array<Record<string, string>>;
  if (rows.length === 0) return missing;
  const visible = rows.filter((row) => user.role !== "operator" || hasPlatformGrant(db, user.userId, row.platform));
  if (visible.length === 0) {
    return `<section class="audit block"><h2>Terraform 配置</h2><p class="lead">没有这个云平台的授权。</p></section>`;
  }
  const blocks = visible
    .map((row) => {
      const files = renderTerraform(stackId, selectionFromRow(row));
      const listing = files
        .map((file) => `<h4>${escapeHtml(file.name)}</h4><pre class="code">${highlightJson(file.body)}</pre>`)
        .join("");
      return `<h3>${escapeHtml(platformLabel(catalog, row.platform))} · ${escapeHtml(row.region)}</h3>${listing}`;
    })
    .join("");
  return `<section class="audit block"><h2>Terraform 配置</h2><p class="lead">${escapeHtml(visible[0].stack_name)}。供审计阅读。没有执行 terraform，也没有调用云 API。</p>${blocks}</section>`;
}

function selectionFromRow(row: Record<string, string>): NormalizedSelection {
  return {
    platform: row.platform,
    region: row.region,
    services: parseStringArray(row.services),
    networks: parseNetworks(row.networks),
    zones: parseStringArray(row.zones),
    parameters: parseParameters(row.parameters),
  };
}

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function parseNetworks(raw: string): Array<{ name: string; cidr: string }> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.map((item) => {
      const network = item as { name?: string; cidr?: string };
      return { name: String(network.name ?? ""), cidr: String(network.cidr ?? "") };
    });
  } catch {
    return [];
  }
}

function parseParameters(raw: string): NormalizedSelection["parameters"] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const parameters: NormalizedSelection["parameters"] = {};
    for (const [id, item] of Object.entries(value as Record<string, { network?: string; config?: string; count?: unknown }>)) {
      const config = String(item?.config ?? "");
      const count = storedServiceCount(item?.count);
      parameters[id] = item?.network ? { network: String(item.network), config, count } : { config, count };
    }
    return parameters;
  } catch {
    return {};
  }
}

function savedList(items: Array<Record<string, string>>): string {
  if (items.length === 0) return `<p class="empty-note">还没有记录</p>`;
  return `<ul class="saved">${items
    .map(
      (item) => `<li><div class="saved-top"><strong>${escapeHtml(item.stack_name)}</strong><span>${escapeHtml(item.platform)}</span><span>${escapeHtml(item.region)}</span><a href="/?audit=${escapeHtml(item.stack_id)}">查看 Terraform 配置</a></div><p>${escapeHtml(item.services)}</p>${item.configs ? `<p class="saved-net">${escapeHtml(item.configs)}</p>` : ""}${item.credential ? `<p class="saved-net">鉴权 ${escapeHtml(item.credential)}</p>` : ""}<p class="saved-net">${escapeHtml(item.networks)}</p></li>`,
    )
    .join("")}</ul>`;
}

function dataTable(
  headers: string[],
  items: Array<Record<string, string | number | null>>,
  columns: string[],
): string {
  const body =
    items.length === 0
      ? `<tr><td class="empty" colspan="${headers.length}">还没有记录</td></tr>`
      : items
          .map((item) => `<tr>${columns.map((column) => `<td>${escapeHtml(item[column])}</td>`).join("")}</tr>`)
          .join("");
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function platformLabel(catalog: CatalogSnapshot, platform: string): string {
  return catalog.platforms.find((item) => item.id === platform)?.label ?? platform;
}

function serviceLabel(catalog: CatalogSnapshot, platform: string, id: string): string {
  return (
    catalog.services.find((service) => service.platformId === platform && service.id === id)?.label ??
    catalog.services.find((service) => service.id === id)?.label ??
    id
  );
}

function describeServices(catalog: CatalogSnapshot, platform: string, raw: string): string {
  try {
    const ids = JSON.parse(raw) as unknown;
    if (!Array.isArray(ids)) return raw;
    return ids.map((id) => serviceLabel(catalog, platform, String(id))).join("、");
  } catch {
    return raw;
  }
}

function placeLabel(catalog: CatalogSnapshot, platform: string, regionId: string, zonesRaw: string): string {
  const region = catalog.regions.find((item) => item.platformId === platform && item.id === regionId);
  const label = region ? placeText(region.label, region.id) : regionId;
  let zones: string[] = [];
  try {
    const parsed = JSON.parse(zonesRaw) as unknown;
    if (Array.isArray(parsed)) zones = parsed.map(String);
  } catch {
    zones = [];
  }
  return zones.length > 0 ? `${label} · ${zones.join("、")}` : label;
}

function describeConfigs(catalog: CatalogSnapshot, platform: string, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    return Object.entries(parsed as Record<string, { config?: string; count?: unknown }>)
      .map(([id, value]) => {
        const config = (value?.config ?? "").replace(/\s+/g, " ").trim();
        const count = storedServiceCount(value?.count);
        return config ? `${serviceLabel(catalog, platform, id)} × ${count}：${config}` : "";
      })
      .filter((line) => line.length > 0)
      .join("；");
  } catch {
    return "";
  }
}

function describeNetworks(raw: string): string {
  try {
    const networks = JSON.parse(raw) as unknown;
    if (!Array.isArray(networks) || networks.length === 0) return "不进入网络";
    return networks
      .map((network) => {
        const item = network as { name?: string; cidr?: string };
        return `${item.name ?? ""} ${item.cidr ?? ""}`.trim();
      })
      .join("、");
  } catch {
    return raw;
  }
}

function loginPage(): string {
  return renderPage(
    "登录 · novtf",
    `<main class="gate"><form class="gate-card" method="post" action="/login">
<p class="brand">novtf</p>
<h1>登录</h1>
<p class="lead">控制面只在这台机器上。</p>
<label>用户名 <input name="username" autocomplete="username"></label>
<label>口令 <input name="password" type="password" autocomplete="current-password"></label>
<button class="primary" type="submit">登录</button>
</form></main>`,
  );
}

function csrfOk(request: IncomingMessage, body: string, user: SessionUser): boolean {
  const header = request.headers["x-csrf-token"];
  const token = Array.isArray(header) ? header[0] : header;
  const formToken = formValue(body, "csrf");
  return token === user.csrfSecret || formToken === user.csrfSecret;
}

export async function startApi(db: DatabaseSync, host: string, port: number): Promise<Server> {
  await bootstrapAdmin(db, process.env.NOVTF_OPERATOR_PASSWORD);
  const server = createServer(async (request, response) => {
    try {
      await route(db, request, response);
    } catch {
      send(response, 400, "bad request\n", "text/plain; charset=utf-8");
    }
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return server;
}

async function route(db: DatabaseSync, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/healthz") {
    send(response, 200, "ok\n", "text/plain; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/login") {
    send(response, 200, loginPage(), "text/html; charset=utf-8");
    return;
  }
  if (request.method === "POST" && url.pathname === "/login") {
    const body = await readBody(request);
    const session = await login(db, formValue(body, "username"), formValue(body, "password"));
    if (!session) {
      send(response, 401, "login failed\n", "text/plain; charset=utf-8");
      return;
    }
    send(response, 302, "", "text/plain; charset=utf-8", { location: "/", "set-cookie": cookieHeader(session.sessionId) });
    return;
  }

  const user = readSession(db, request.headers.cookie);
  if (!user) {
    if (request.method === "GET" && ["/", "/platforms", "/services", "/regions", "/credentials"].includes(url.pathname)) {
      send(response, 302, "", "text/plain; charset=utf-8", { location: "/login" });
      return;
    }
    send(response, 401, "unauthorized\n", "text/plain; charset=utf-8");
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    send(response, 200, page(db, user, url.searchParams.get("error") ?? "", url.searchParams.get("audit") ?? ""), "text/html; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/credentials") {
    send(response, 200, credentialView(db, user, url.searchParams), "text/html; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/credentials") {
    send(response, 200, JSON.stringify(credentialJson(db, user.role)), "application/json; charset=utf-8");
    return;
  }
  if (request.method === "GET" && (url.pathname === "/platforms" || url.pathname === "/services" || url.pathname === "/regions")) {
    send(
      response,
      200,
      managePage(db, user, url.pathname, url.searchParams.get("error") ?? "", url.searchParams.get("value") ?? ""),
      "text/html; charset=utf-8",
    );
    return;
  }

  const body = request.method === "POST" ? await readBody(request) : "";
  if (request.method === "POST" && !csrfOk(request, body, user)) {
    send(response, 403, "csrf\n", "text/plain; charset=utf-8");
    return;
  }
  if (request.method === "POST" && url.pathname === "/logout") {
    logout(db, user.sessionId);
    send(response, 302, "", "text/plain; charset=utf-8", { location: "/login", "set-cookie": clearCookieHeader() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/users") {
    if (user.role !== "admin") {
      send(response, 403, "forbidden\n", "text/plain; charset=utf-8");
      return;
    }
    const payload = JSON.parse(body) as { username?: string; password?: string; role?: string };
    if (!payload.username || !payload.password || !payload.role || !isRole(payload.role)) {
      send(response, 400, "missing fields\n", "text/plain; charset=utf-8");
      return;
    }
    const id = await createUser(db, payload.username, payload.password, payload.role);
    send(response, 201, JSON.stringify({ id }), "application/json; charset=utf-8");
    return;
  }
  const grantMatch = url.pathname.match(/^\/api\/v1\/users\/(\d+)\/grants$/);
  if (request.method === "POST" && grantMatch) {
    if (user.role !== "admin") {
      send(response, 403, "forbidden\n", "text/plain; charset=utf-8");
      return;
    }
    const payload = JSON.parse(body) as { platform?: string };
    if (!payload.platform || !loadCatalog(db).platforms.some((platform) => platform.id === payload.platform)) {
      send(response, 422, "unsupported platform\n", "text/plain; charset=utf-8");
      return;
    }
    grantPlatform(db, Number(grantMatch[1]), payload.platform);
    send(response, 204, "", "text/plain; charset=utf-8");
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/credentials") {
    saveCredentialRequest(db, user, body, response, true);
    return;
  }
  if (request.method === "POST" && url.pathname === "/credentials") {
    saveCredentialRequest(db, user, body, response, false);
    return;
  }
  if (request.method === "POST" && url.pathname === "/stacks") {
    saveStack(db, user, body, response);
    return;
  }
  if (request.method === "POST" && (url.pathname === "/platforms" || url.pathname === "/services" || url.pathname === "/regions")) {
    saveCatalog(db, user, url.pathname, body, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/provider-runs") {
    const payload = JSON.parse(body) as {
      id?: string;
      stackId?: string;
      platform?: string;
      region?: string;
      action?: string;
    };
    if (!payload.id || !payload.stackId || !payload.platform || !payload.region || !payload.action) {
      send(response, 400, "missing fields\n", "text/plain; charset=utf-8");
      return;
    }
    if (!loadCatalog(db).platforms.some((platform) => platform.id === payload.platform) || !ACTIONS.has(payload.action)) {
      send(response, 422, "unsupported platform or action\n", "text/plain; charset=utf-8");
      return;
    }
    const granted = user.role === "admin" || hasPlatformGrant(db, user.userId, payload.platform);
    const decision = authorizeRun(user.role, payload.action, granted);
    if (!decision.ok) {
      send(response, decision.status, `${decision.code}\n`, "text/plain; charset=utf-8");
      return;
    }
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO provider_run (id, stack_id, platform, region, action, phase, actor_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(payload.id, payload.stackId, payload.platform, payload.region, payload.action, user.userId, now, now);
    send(response, 201, "queued\n", "text/plain; charset=utf-8");
    return;
  }
  send(response, 404, "not found\n", "text/plain; charset=utf-8");
}

function managePage(db: DatabaseSync, user: SessionUser, path: string, error: string, value: string): string {
  const catalog = loadCatalog(db);
  const viewer = { username: user.username, role: user.role, csrf: user.csrfSecret };
  const text = catalogMessage(error, value);
  if (path === "/services") return servicesPage(viewer, catalog, text);
  if (path === "/regions") return regionsPage(viewer, catalog, text);
  return platformsPage(viewer, catalog, text);
}

function catalogMessage(code: string, value: string): string {
  const shown = value.trim().slice(0, 80);
  const named: Record<string, string> = {
    platform_exists: `云平台标识「${shown}」已经存在`,
    platform_label_exists: `云平台显示名「${shown}」已经存在`,
    service_exists: `云资源标识「${shown}」已经存在`,
    service_label_exists: `云资源显示名「${shown}」已经存在`,
    region_exists: `区域「${shown}」已经存在`,
    region_label_exists: `区域显示名「${shown}」已经存在`,
    zone_exists: `可用区「${shown}」已经存在`,
    zone_label_exists: `可用区显示名「${shown}」已经存在`,
    zone_duplicate: `这次填写的可用区「${shown}」重复了`,
    config_required: `请填写云资源「${shown}」的配置`,
    config_too_long: `云资源「${shown}」的配置不能超过 500 字`,
  };
  if (shown && named[code]) return named[code];
  return ERROR_TEXT[code] ?? code;
}

function saveCatalog(db: DatabaseSync, user: SessionUser, path: string, body: string, response: ServerResponse): void {
  if (user.role !== "admin") {
    send(response, 403, "forbidden\n", "text/plain; charset=utf-8");
    return;
  }
  const params = new URLSearchParams(body);
  const notice =
    path === "/platforms"
      ? addPlatform(db, params.get("id") ?? "", params.get("label") ?? "")
      : path === "/services"
        ? params.get("intent") === "config"
          ? saveServiceConfig(db, params.get("platform") ?? "", params.get("id") ?? "", params.get("config") ?? "")
          : addService(
              db,
              params.get("platform") ?? "",
              params.get("id") ?? "",
              params.get("label") ?? "",
              params.get("group") ?? "",
              params.get("network") ?? "",
              params.get("config") ?? "",
            )
        : addRegion(db, params.get("platform") ?? "", params.get("id") ?? "", params.get("label") ?? "", parseZones(params.get("zones") ?? ""));
  const location = notice
    ? `${path}?error=${encodeURIComponent(notice.code)}&value=${encodeURIComponent(notice.value)}`
    : path;
  send(response, 302, "", "text/plain; charset=utf-8", { location });
}

function parseZones(raw: string): Array<{ id: string; label: string }> {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\S+)\s*(.*)$/);
      return { id: match?.[1] ?? "", label: (match?.[2] ?? "").trim() };
    });
}

function saveStack(db: DatabaseSync, user: SessionUser, body: string, response: ServerResponse): void {
  if (user.role === "auditor") {
    send(response, 403, "forbidden\n", "text/plain; charset=utf-8");
    return;
  }
  const params = new URLSearchParams(body);
  const name = (params.get("stack_name") ?? "").trim();
  const platforms = params.getAll("platform");
  if (!name || platforms.length === 0) {
    keepComposeDraft(db, user, response, "no_platform", body);
    return;
  }
  const catalog = loadCatalog(db);
  const admitted: Array<NormalizedSelection & { credentialId: string }> = [];
  for (const platform of platforms) {
    if (user.role === "operator" && !hasPlatformGrant(db, user.userId, platform)) {
      keepComposeDraft(db, user, response, "platform_not_granted", body);
      return;
    }
    const credentialId = (params.get(`${platform}_credential`) ?? "").trim();
    if (credentialId && credentialPlatform(db, credentialId) !== platform) {
      keepComposeDraft(db, user, response, "credential_unknown", body);
      return;
    }
    const names = params.getAll(`${platform}_net_name`);
    const cidrs = params.getAll(`${platform}_net_cidr`);
    const services = catalog.services.filter((service) => service.platformId === platform);
    const result = admit(
      {
        platform,
        region: params.get(`${platform}_region`) ?? "",
        services: params.getAll(`${platform}_service`),
        zones: params.getAll(`${platform}_zone`),
        networks: names.map((networkName, index) => ({ name: networkName, cidr: cidrs[index] ?? "" })),
        serviceNetwork: Object.fromEntries(
          services.map((service) => [
            service.id,
            networkNameAt(names, params.get(`${platform}_${service.id}_network`) ?? ""),
          ]),
        ),
        serviceConfig: Object.fromEntries(
          services.map((service) => [service.id, params.get(`${platform}_${service.id}_config`) ?? ""]),
        ),
        serviceCount: Object.fromEntries(
          services.map((service) => [service.id, params.get(`${platform}_${service.id}_count`) ?? ""]),
        ),
      },
      false,
      catalog,
    );
    if (!result.ok) {
      keepComposeDraft(db, user, response, result.code, body);
      return;
    }
    admitted.push({ ...result.selection, credentialId });
  }
  const stackId = randomUUID();
  const now = new Date().toISOString();
  withImmediate(db, () => {
    db.prepare("INSERT INTO stack (id, name, created_at) VALUES (?, ?, ?)").run(stackId, name, now);
    db.prepare("UPDATE session SET compose_draft = NULL WHERE id = ?").run(user.sessionId);
    for (const selection of admitted) {
      db.prepare(
        `INSERT INTO stack_selection (stack_id, platform, region, services, networks, parameters, zones, credential_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        stackId,
        selection.platform,
        selection.region,
        JSON.stringify(selection.services),
        JSON.stringify(selection.networks),
        JSON.stringify(selection.parameters),
        JSON.stringify(selection.zones),
        selection.credentialId || null,
      );
    }
  });
  send(response, 302, "", "text/plain; charset=utf-8", { location: `/?audit=${stackId}` });
}

function credentialView(db: DatabaseSync, user: SessionUser, query: URLSearchParams): string {
  const draft: CredentialDraft = {
    platform: (query.get("platform") ?? "").slice(0, 20),
    authKind: (query.get("auth_kind") ?? "").slice(0, 32),
    partition: (query.get("partition") ?? "").slice(0, 8),
    displayName: (query.get("display_name") ?? "").slice(0, 40),
    accountHint: (query.get("account_hint") ?? "").slice(0, 64),
    roleArn: (query.get("role_arn") ?? "").slice(0, 2048),
    accessKeyId: (query.get("access_key_id") ?? "").slice(0, 128),
    clientId: (query.get("client_id") ?? "").slice(0, 64),
    tenantId: (query.get("tenant_id") ?? "").slice(0, 64),
    subscriptionId: (query.get("subscription_id") ?? "").slice(0, 64),
  };
  return credentialsPage(
    { username: user.username, role: user.role, csrf: user.csrfSecret },
    loadCatalog(db),
    listCredentials(db),
    query.get("error") ?? "",
    query.get("saved") === "1",
    draft,
  );
}

function credentialJson(db: DatabaseSync, role: string): Array<Record<string, string>> {
  return listCredentials(db).map((item) =>
    role === "admin"
      ? {
          id: item.id,
          platform: item.platform,
          auth_kind: item.authKind,
          partition: item.partition,
          display_name: item.displayName,
          account_hint: item.accountHint,
          fingerprint: item.fingerprint,
          ...(item.warning ? { warning: item.warning } : {}),
        }
      : { id: item.id, platform: item.platform, account_hint: item.accountHint },
  );
}

function saveCredentialRequest(db: DatabaseSync, user: SessionUser, body: string, response: ServerResponse, json: boolean): void {
  if (user.role !== "admin") {
    send(response, 403, "forbidden\n", "text/plain; charset=utf-8");
    return;
  }
  const request = json ? (JSON.parse(body) as CredentialRequest) : credentialFromForm(body);
  const result = saveCredential(db, user.userId, request);
  if (!result.ok) {
    if (json) {
      send(response, 422, JSON.stringify({ code: result.code }), "application/json; charset=utf-8");
      return;
    }
    const params = new URLSearchParams(body);
    const query = new URLSearchParams({
      error: result.code,
      platform: params.get("platform") ?? "",
      auth_kind: params.get("auth_kind") ?? "",
      partition: params.get("partition") ?? "",
      display_name: params.get("display_name") ?? "",
      account_hint: params.get("account_hint") ?? "",
      role_arn: params.get("role_arn") ?? "",
      access_key_id: params.get("access_key_id") ?? "",
      client_id: params.get("client_id") ?? "",
      tenant_id: params.get("tenant_id") ?? "",
      subscription_id: params.get("subscription_id") ?? "",
    });
    send(response, 302, "", "text/plain; charset=utf-8", { location: `/credentials?${query}` });
    return;
  }
  if (json) {
    const item = result.credential;
    send(
      response,
      201,
      JSON.stringify({
        id: item.id,
        fingerprint: item.fingerprint,
        auth_kind: item.authKind,
        partition: item.partition,
        account_hint: item.accountHint,
        ...(item.warning ? { warning: item.warning } : {}),
      }),
      "application/json; charset=utf-8",
    );
    return;
  }
  send(response, 302, "", "text/plain; charset=utf-8", { location: "/credentials?saved=1" });
}

function credentialFromForm(body: string): CredentialRequest {
  const params = new URLSearchParams(body);
  const secret: Record<string, string> = {};
  for (const key of [
    "access_key_id",
    "secret_access_key",
    "access_key_secret",
    "role_arn",
    "external_id",
    "client_id",
    "client_secret",
    "tenant_id",
    "subscription_id",
  ]) {
    const value = params.get(key);
    if (value) secret[key] = value;
  }
  return {
    platform: params.get("platform") ?? "",
    auth_kind: params.get("auth_kind") ?? "",
    partition: params.get("partition") ?? "",
    display_name: params.get("display_name") ?? "",
    account_hint: params.get("account_hint") ?? "",
    secret,
  };
}

function keepComposeDraft(db: DatabaseSync, user: SessionUser, response: ServerResponse, code: string, body: string): void {
  db.prepare("UPDATE session SET compose_draft = ? WHERE id = ?").run(body, user.sessionId);
  send(response, 302, "", "text/plain; charset=utf-8", { location: `/?error=${encodeURIComponent(code)}` });
}

function composeDraft(db: DatabaseSync, user: SessionUser): URLSearchParams | undefined {
  const row = db.prepare("SELECT compose_draft FROM session WHERE id = ?").get(user.sessionId) as
    | { compose_draft: string | null }
    | undefined;
  if (!row?.compose_draft) return undefined;
  return new URLSearchParams(row.compose_draft);
}

function networkNameAt(names: string[], slot: string): string {
  if (!slot) return "";
  return (names[Number(slot) - 1] ?? "").trim();
}
