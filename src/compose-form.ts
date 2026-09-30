import { placeText, type CatalogSnapshot, type CatalogService } from "./catalog.ts";
import type { CredentialChoice } from "./credential.ts";
import { escapeHtml } from "./html.ts";

export function composeForm(
  csrf: string,
  catalog: CatalogSnapshot,
  platformIds: string[],
  error: string,
  canSubmit: boolean,
  draft?: URLSearchParams,
  choices: CredentialChoice[] = [],
): string {
  const picked = new Set(draft?.getAll("platform") ?? []);
  const cards = platformIds.map((platformId) => platformCard(catalog, platformId, picked.has(platformId), draft, choices)).join("");
  const banner = error ? `<p class="banner" role="alert">没有保存：${escapeHtml(error)}</p>` : "";
  if (platformIds.length === 0) {
    return `<p class="lead">没有可用的云平台。管理员需要先授予平台，或在「云平台」里新增。</p>`;
  }
  const submit = canSubmit
    ? `<button class="primary" type="submit">生成配置供审计</button>`
    : `<p>当前角色只能查看，不能提交。</p>`;
  const note = canSubmit ? `<p>只展示 Terraform 配置，不执行命令。</p>` : "";
  return `${banner}
<form method="post" action="/stacks">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<div class="toolbar">
<label class="namebar"><span>名称</span><input name="stack_name" required maxlength="40" placeholder="例如 hk-app" value="${escapeHtml(draft?.get("stack_name") ?? "")}" ${canSubmit ? "" : "disabled"}></label>
<div class="actions">${submit}${note}</div>
</div>
${cards}
<div class="actions actions-end">${submit}${note}</div>
</form>
<script>
document.querySelectorAll(".cloud").forEach((card) => {
  const names = [...card.querySelectorAll("input[name$='_net_name']")];
  const syncNames = () => {
    card.querySelectorAll("select[name$='_network']").forEach((select) => {
      [...select.options].forEach((option) => {
        if (!option.value) return;
        const typed = (names[Number(option.value) - 1]?.value || "").trim();
        option.textContent = typed || "网络 " + option.value;
      });
    });
  };
  names.forEach((input) => input.addEventListener("input", syncNames));
  const syncConfig = () => {
    card.querySelectorAll(".product").forEach((product) => {
      const box = product.querySelector("input[type=checkbox]");
      if (!(box instanceof HTMLInputElement)) return;
      product.querySelectorAll(".config-edit").forEach((config) => {
        config.classList.toggle("is-off", !box.checked || box.disabled);
      });
    });
  };
  card.querySelectorAll(".product input[type=checkbox]").forEach((box) => box.addEventListener("change", syncConfig));
  const region = card.querySelector("select[name$='_region']");
  const syncZones = () => {
    card.querySelectorAll("[data-zone-region]").forEach((group) => {
      const on = !region || group.dataset.zoneRegion === region.value;
      group.classList.toggle("is-off", !on);
      if (!on) group.querySelectorAll("input").forEach((input) => { input.checked = false; });
    });
  };
  region?.addEventListener("change", syncZones);
  syncNames();
  syncZones();
  syncConfig();
});
</script>`;
}

function platformCard(
  catalog: CatalogSnapshot,
  platformId: string,
  picked: boolean,
  draft?: URLSearchParams,
  choices: CredentialChoice[] = [],
): string {
  const platform = catalog.platforms.find((item) => item.id === platformId);
  const label = platform?.label ?? platformId;
  const regions = catalog.regions.filter((region) => region.platformId === platformId);
  const regionId = draft?.get(`${platformId}_region`) ?? "";
  const regionOptions = regions
    .map(
      (region) =>
        `<option value="${escapeHtml(region.id)}"${region.id === regionId ? " selected" : ""}>${escapeHtml(placeText(region.label, region.id))}</option>`,
    )
    .join("");
  const regionSelect = regions.length
    ? `<select name="${escapeHtml(platformId)}_region">${regionOptions}</select>`
    : `<select name="${escapeHtml(platformId)}_region"><option value="">还没有区域</option></select>`;
  const services = catalog.services.filter((service) => service.platformId === platformId);
  const groups = [...new Set(services.map((service) => service.group))]
    .map((group) => {
      const products = services
        .filter((service) => service.group === group)
        .map((service) => productControl(platformId, service, draft))
        .join("");
      return `<h3 class="group-title">${escapeHtml(group)}</h3><div class="products">${products}</div>`;
    })
    .join("");
  const body = services.length ? groups : `<p class="lead">还没有云资源。可以在左侧「云资源」里添加。</p>`;
  const netNames = draft?.getAll(`${platformId}_net_name`) ?? [];
  const netCidrs = draft?.getAll(`${platformId}_net_cidr`) ?? [];
  const networks = [1, 2, 3]
    .map(
      (slot) => `<label class="net"><span>网络 ${slot}</span>
<input name="${escapeHtml(platformId)}_net_name" maxlength="16" placeholder="${slot === 1 ? "自定义名称，例如 app" : "自定义名称"}" autocomplete="off" value="${escapeHtml(netNames[slot - 1] ?? "")}">
<input name="${escapeHtml(platformId)}_net_cidr" placeholder="CIDR，留空则用默认 /16" autocomplete="off" value="${escapeHtml(netCidrs[slot - 1] ?? "")}"></label>`,
    )
    .join("");
  const zoneGroups = regions
    .map((region) => {
      const zones = catalog.zones.filter((zone) => zone.platformId === platformId && zone.regionId === region.id);
      if (zones.length === 0) return "";
      const pickedZones = new Set(draft?.getAll(`${platformId}_zone`) ?? []);
      const boxes = zones
        .map(
          (zone) =>
            `<label><input type="checkbox" name="${escapeHtml(platformId)}_zone" value="${escapeHtml(zone.id)}"${pickedZones.has(zone.id) ? " checked" : ""}> ${escapeHtml(placeText(zone.label, zone.id))}</label>`,
        )
        .join("");
      return `<div class="zone-group" data-zone-region="${escapeHtml(region.id)}"><span>${escapeHtml(placeText(region.label, region.id))}</span>${boxes}</div>`;
    })
    .join("");
  const zones = zoneGroups
    ? `<div class="net-head"><strong>可用区</strong><p>可选。只显示当前区域下的可用区。</p></div>${zoneGroups}`
    : `<p class="lead">还没有可用区。可以在左侧「区域」里添加。</p>`;
  return `<article class="cloud" data-platform="${escapeHtml(platformId)}">
<header class="cloud-head">
<label class="platform-pick"><input type="checkbox" name="platform" value="${escapeHtml(platformId)}"${picked ? " checked" : ""}> ${escapeHtml(label)}</label>
<label class="region-pick"><span>区域</span>${regionSelect}</label>
${credentialSelect(platformId, draft, choices)}
</header>
<div class="net-head"><strong>网络</strong><p>名称自己填写，小写字母开头。相同名称是同一套网络，最多三套。填了名称却没有资源使用，不能保存。</p></div>
<div class="nets">${networks}</div>
${body}
${zones}
</article>`;
}

function credentialSelect(platformId: string, draft: URLSearchParams | undefined, choices: CredentialChoice[]): string {
  const current = draft?.get(`${platformId}_credential`) ?? "";
  const options = choices
    .filter((choice) => choice.platform === platformId)
    .map((choice) => `<option value="${escapeHtml(choice.id)}"${choice.id === current ? " selected" : ""}>${escapeHtml(choice.label)}</option>`)
    .join("");
  return `<label class="region-pick"><span>鉴权</span><select name="${escapeHtml(platformId)}_credential"><option value="">先不选</option>${options}</select></label>`;
}

function productControl(platformId: string, service: CatalogService, draft?: URLSearchParams): string {
  const off = service.enabled ? "" : " disabled";
  const empty = service.network === "optional" ? "不进入网络" : "未选择";
  const picked = new Set(draft?.getAll(`${platformId}_service`) ?? []);
  const on = service.enabled && picked.has(service.id);
  const configKey = `${platformId}_${service.id}_config`;
  const configValue = draft?.has(configKey) ? (draft.get(configKey) ?? "") : service.config;
  const countKey = `${platformId}_${service.id}_count`;
  const countValue = draft?.has(countKey) ? (draft.get(countKey) ?? "") : "1";
  const slot = draft?.get(`${platformId}_${service.id}_network`) ?? "";
  const networkOptions = [1, 2, 3]
    .map((index) => `<option value="${index}"${slot === String(index) ? " selected" : ""}>网络 ${index}</option>`)
    .join("");
  const count = `<label class="config-edit count-edit${on ? "" : " is-off"}"><span>数量（1–10）</span><input name="${escapeHtml(countKey)}" type="number" min="1" max="10" step="1" inputmode="numeric" value="${escapeHtml(countValue)}"${off}></label>`;
  const config = `<label class="config-edit${on ? "" : " is-off"}"><span>资源配置</span><textarea name="${escapeHtml(platformId)}_${escapeHtml(service.id)}_config" maxlength="500"${off}>${escapeHtml(configValue)}</textarea></label>`;
  return `<div class="product${service.enabled ? "" : " is-off"}">
<label>
<input type="checkbox" name="${escapeHtml(platformId)}_service" value="${escapeHtml(service.id)}"${on ? " checked" : ""}${off}>
<span class="ptitle">${escapeHtml(service.label)}</span>
<span class="psum">${escapeHtml(service.summary)}</span>
</label>
${service.enabled ? `<select name="${escapeHtml(platformId)}_${escapeHtml(service.id)}_network"><option value=""${slot === "" ? " selected" : ""}>${empty}</option>${networkOptions}</select>` : ""}
${count}
${config}
</div>`;
}
