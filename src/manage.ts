import { placeText, type CatalogSnapshot } from "./catalog.ts";
import { escapeHtml, appFrame } from "./html.ts";

interface Viewer {
  username: string;
  role: string;
  csrf: string;
}

export function platformsPage(viewer: Viewer, catalog: CatalogSnapshot, error: string): string {
  const rows = catalog.platforms
    .map((platform) => {
      const regions = catalog.regions.filter((region) => region.platformId === platform.id).length;
      const services = catalog.services.filter((service) => service.platformId === platform.id).length;
      return `<tr><td>${escapeHtml(platform.label)}</td><td>${escapeHtml(platform.id)}</td><td>${services}</td><td>${regions}</td></tr>`;
    })
    .join("");
  const form =
    viewer.role === "admin"
      ? `<form class="panel" method="post" action="/platforms">
<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrf)}">
<h2>新增云平台</h2>
<p class="lead">标识用于保存和授权。显示名出现在编排页。资源、区域和可用区在左侧另外两项里加。</p>
<div class="fields">
<label>标识<input name="id" required maxlength="21" placeholder="例如 gcp" autocomplete="off"></label>
<label>显示名<input name="label" required maxlength="40" placeholder="例如 Google Cloud"></label>
</div>
<button class="primary" type="submit">新增云平台</button>
</form>`
      : `<p class="lead">当前角色只能查看，不能新增。</p>`;
  return frame(viewer, "/platforms", "云平台", `${banner(error)}${form}
<section class="block"><h2>已有云平台</h2>
${table(["显示名", "标识", "云资源", "区域"], rows)}</section>`);
}

export function servicesPage(viewer: Viewer, catalog: CatalogSnapshot, error: string): string {
  const options = catalog.platforms
    .map((platform) => `<option value="${escapeHtml(platform.id)}">${escapeHtml(platform.label)}</option>`)
    .join("");
  const rows = catalog.services
    .map((service) => {
      const platform = catalog.platforms.find((item) => item.id === service.platformId)?.label ?? service.platformId;
      const network = service.network === "required" ? "必须进入网络" : "可以不进网络";
      const config =
        viewer.role === "admin"
          ? `<form method="post" action="/services">
<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrf)}">
<input type="hidden" name="intent" value="config">
<input type="hidden" name="platform" value="${escapeHtml(service.platformId)}">
<input type="hidden" name="id" value="${escapeHtml(service.id)}">
<textarea name="config" required maxlength="500">${escapeHtml(service.config)}</textarea>
<button class="ghost" type="submit">保存配置</button>
</form>`
          : `<p class="config-text">${escapeHtml(service.config)}</p>`;
      return `<tr><td>${escapeHtml(platform)}</td><td>${escapeHtml(service.label)}</td><td>${escapeHtml(service.id)}</td><td>${escapeHtml(service.group)}</td><td>${network}</td><td class="config-cell">${config}</td></tr>`;
    })
    .join("");
  const form =
    viewer.role === "admin"
      ? `<form class="panel" method="post" action="/services">
<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrf)}">
<h2>新增云资源</h2>
<p class="lead">标识会自动加上云平台英文名，例如 aws_cloud_disk。资源配置写明要创建的规格。标识、显示名如果已经存在，会提示并且不会保存。</p>
<div class="fields">
<label>云平台<select name="platform">${options}</select></label>
<label>标识<span class="id-line"><span class="id-prefix">${escapeHtml(catalog.platforms[0]?.id ?? "")}_</span><input name="id" required maxlength="32" placeholder="cloud_disk" autocomplete="off"></span></label>
<label>显示名<input name="label" required maxlength="40" placeholder="例如 云盘"></label>
<label>分组<input name="group" maxlength="40" placeholder="例如 数据"></label>
<label>网络<select name="network"><option value="required">必须进入网络</option><option value="optional">可以不进网络</option></select></label>
<label class="wide">资源配置<textarea name="config" required maxlength="500" placeholder="例如&#10;容量 100 GB&#10;规格 small"></textarea></label>
</div>
<button class="primary" type="submit">新增云资源</button>
</form>
<script>
const platformSelect = document.querySelector(".panel select[name=platform]");
const prefix = document.querySelector(".id-prefix");
const syncPrefix = () => { if (prefix && platformSelect) prefix.textContent = platformSelect.value + "_"; };
platformSelect?.addEventListener("change", syncPrefix);
syncPrefix();
</script>`
      : `<p class="lead">当前角色只能查看，不能新增。</p>`;
  return frame(viewer, "/services", "云资源", `${banner(error)}${form}
<section class="block"><h2>已有云资源</h2>
${table(["平台", "显示名", "标识", "分组", "网络", "资源配置"], rows)}</section>`);
}

export function regionsPage(viewer: Viewer, catalog: CatalogSnapshot, error: string): string {
  const options = catalog.platforms
    .map((platform) => `<option value="${escapeHtml(platform.id)}">${escapeHtml(platform.label)}</option>`)
    .join("");
  const rows = catalog.regions
    .map((region) => {
      const platform = catalog.platforms.find((item) => item.id === region.platformId)?.label ?? region.platformId;
      const zones = catalog.zones
        .filter((zone) => zone.platformId === region.platformId && zone.regionId === region.id)
        .map((zone) => placeText(zone.label, zone.id))
        .join("、");
      return `<tr><td>${escapeHtml(platform)}</td><td>${escapeHtml(placeText(region.label, region.id))}</td><td>${escapeHtml(zones || "还没有")}</td></tr>`;
    })
    .join("");
  const form =
    viewer.role === "admin"
      ? `<form class="panel" method="post" action="/regions">
<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrf)}">
<h2>新增区域和可用区</h2>
<p class="lead">区域标识例如 ap-east-1。可用区每行一个，可以只写标识，也可以写成「标识 显示名」。标识、显示名或可用区如果已经存在，会提示并且不会重复保存。</p>
<div class="fields">
<label>云平台<select name="platform">${options}</select></label>
<label>区域标识<input name="id" required maxlength="33" placeholder="例如 ap-east-1" autocomplete="off"></label>
<label>区域显示名<input name="label" maxlength="40" placeholder="例如 香港"></label>
<label class="wide">可用区<textarea name="zones" placeholder="ap-east-1a&#10;ap-east-1b 可用区 B"></textarea></label>
</div>
<button class="primary" type="submit">保存区域</button>
</form>`
      : `<p class="lead">当前角色只能查看，不能新增。</p>`;
  return frame(viewer, "/regions", "区域与可用区", `${banner(error)}${form}
<section class="block"><h2>已有区域</h2>
${table(["平台", "区域", "可用区"], rows)}</section>`);
}

function frame(viewer: Viewer, active: string, title: string, main: string): string {
  return appFrame({
    username: viewer.username,
    role: viewer.role,
    csrf: viewer.csrf,
    active,
    main: `<section><h1>${escapeHtml(title)}</h1>${main}</section>`,
  });
}

function banner(error: string): string {
  return error ? `<p class="banner" role="alert">${escapeHtml(error)}</p>` : "";
}

function table(headers: string[], rows: string): string {
  const body = rows || `<tr><td class="empty" colspan="${headers.length}">还没有记录</td></tr>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}
